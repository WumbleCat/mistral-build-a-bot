"""Pipeline orchestration: stages A-E, plus writing the analysis outputs."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .catalog import CatalogClient, NullCatalogClient, find_candidates
from .export import BOMExporter, write_json
from .extraction import VisionResponseError, extract_observations, run_inference_audit
from .ingest import ImageInput
from .models import (
    Component, Connection, EvidenceType, ImageObservation, InferenceAudit, ReviewDocument,
    ReviewIssue, RobotBOM, ViewRequest,
)
from .reconcile import InventoryReconciler
from .review import build_review_document
from .taxonomy import IdAllocator, name_similarity, normalize_category
from .validation import (
    UNDERSIDE_WORDS, RequirementsValidator, ensure_critical_placeholders, purchase_blockers,
)
from .vision import VisionAPIError, VisionClient

log = logging.getLogger(__name__)


@dataclass
class AnalysisResult:
    bom: RobotBOM
    observations: list[ImageObservation]
    audit: InferenceAudit | None
    review: ReviewDocument
    images: list[ImageInput]


def _apply_audit(
    audit: InferenceAudit, components: list[Component]
) -> tuple[list[Component], list[Connection], list[ReviewIssue], list[ViewRequest]]:
    """Turn pass-2 proposals into inferred/unknown lines, questions and view requests."""
    known_ids = {c.id for c in components}
    ids = IdAllocator(list(known_ids))
    result = list(components)

    for item in audit.inferred_components:
        category = normalize_category(item.category)
        duplicate = next(
            (c for c in result if c.category == category and name_similarity(c.name, item.name) >= 0.6),
            None,
        )
        if duplicate is not None:
            if duplicate.evidence_type is not EvidenceType.OBSERVED:
                continue  # same proposal twice
            log.info("pass 2 re-proposed observed part '%s'; ignored", item.name)
            continue
        related = [cid for cid in item.related_component_ids if cid in known_ids]
        notes = [item.rationale, "Proposed by the inference pass; not seen in any photo, not confirmed."]
        if related:
            notes.append("Related to: " + ", ".join(related))
        result.append(
            Component(
                id=ids.new(category),
                category=category,
                name=item.name.strip(),
                evidence_type=EvidenceType(item.evidence_type),
                notes=notes,
            )
        )

    connections: list[Connection] = []
    for proposal in audit.connections:
        if proposal.source_id not in known_ids or proposal.target_id not in known_ids:
            continue
        if proposal.source_id == proposal.target_id:
            continue
        # Pass 2 never sees the images, so it cannot *observe* a connection.
        evidence_type = EvidenceType.UNKNOWN if proposal.evidence_type == "unknown" else EvidenceType.INFERRED
        connections.append(
            Connection(
                source_id=proposal.source_id,
                target_id=proposal.target_id,
                relation=proposal.relation,
                evidence_type=evidence_type,
                rationale=proposal.rationale or "Proposed by the inference pass.",
            )
        )

    issues = [
        ReviewIssue(
            id=f"model.{index}",
            source="model",
            severity=issue.severity,
            component_ids=[cid for cid in issue.component_ids if cid in known_ids],
            message=issue.message,
            next_action=issue.next_action,
        )
        for index, issue in enumerate(audit.issues, start=1)
    ]
    views = [
        ViewRequest(view=v.view.strip(), reason=v.reason, priority=min(3, index + 1), source="model")
        for index, v in enumerate(audit.requested_views, start=1)
    ]
    return result, connections, issues, views


def _demote_unconfirmed(
    observations: list[ImageObservation], components: list[Component]
) -> tuple[list[Component], list[ReviewIssue]]:
    """Pass-1 claims that failed the visibility re-check become INFERRED lines + a question."""
    result = list(components)
    issues: list[ReviewIssue] = []
    ids = IdAllocator([c.id for c in components])
    for observation in observations:
        if observation.verification == "failed":
            issues.append(
                ReviewIssue(
                    id=f"verify.unavailable.{observation.image_id}", severity="warning", component_ids=[],
                    message=(
                        f"The visibility re-check for image '{observation.image_id}' did not produce a "
                        "valid result, so its observed parts were not double-checked."
                    ),
                    next_action="Compare each observed line against the photo before confirming it.",
                )
            )
        for claim in observation.unconfirmed:
            category = normalize_category(claim.category)
            if any(c.category == category and name_similarity(c.name, claim.name) >= 0.6 for c in result):
                continue  # already listed (seen in another photo, or proposed by pass 2)
            component = Component(
                id=ids.new(category),
                category=category,
                name=claim.name.strip(),
                evidence_type=EvidenceType.INFERRED,
                notes=[
                    f"Listed by the first pass for {observation.image_id}, but the visibility re-check "
                    f"could not confirm it is directly visible: {claim.reason}",
                    "Not counted as observed.",
                ],
            )
            result.append(component)
            issues.append(
                ReviewIssue(
                    id=f"verify.unconfirmed.{component.id}", severity="warning",
                    component_ids=[component.id],
                    message=(
                        f"'{claim.name}' was claimed for image '{observation.image_id}' but could not be "
                        "confirmed as directly visible, so it is listed as inferred, not observed."
                    ),
                    next_action="Look at the photo: confirm the line only if you can see or verify the part.",
                )
            )
    return result, issues


def _is_underside(view: str) -> bool:
    return any(word in view.lower() for word in UNDERSIDE_WORDS)


def _merge_views(rule_views: list[ViewRequest], model_views: list[ViewRequest]) -> list[ViewRequest]:
    merged = list(rule_views)
    for view in model_views:
        if " " not in view.view:  # snake_case label such as "side_left"; keep ids like pcb_module-1
            view.view = view.view.replace("_", " ").strip()
        if any(
            name_similarity(view.view, existing.view) >= 0.6
            or (_is_underside(view.view) and _is_underside(existing.view))
            for existing in merged
        ):
            continue
        merged.append(view)
    return sorted(merged, key=lambda v: v.priority)


def analyze(
    images: list[ImageInput],
    client: VisionClient,
    *,
    project_name: str = "robot",
    catalog: CatalogClient | None = None,
    max_retries: int = 2,
    verify: bool = True,
    mode: str = "live",
    vision_model: str | None = None,
    reasoning_client: VisionClient | None = None,
) -> AnalysisResult:
    """Run stages B-E on already-ingested images and return a draft BOM for review."""
    catalog = catalog or NullCatalogClient()

    # B - pass 1: observed-only, one structured result per image. A response that never
    # validates raises VisionResponseError; nothing is built from a malformed reply.
    # Each claim is then re-checked for direct visibility; unconfirmed claims are demoted.
    observations = extract_observations(client, images, max_retries=max_retries, verify=verify)

    # C - cross-image reconciliation.
    reconciled = InventoryReconciler().merge(observations)
    components = reconciled.components
    issues = list(reconciled.issues)
    connections: list[Connection] = []
    model_views: list[ViewRequest] = []

    # B - pass 2: inference / completeness audit (proposals and questions only).
    audit: InferenceAudit | None = None
    if components:
        try:
            audit = run_inference_audit(
                reasoning_client or client, components, observations, max_retries=max_retries
            )
        except (VisionResponseError, VisionAPIError) as exc:
            log.warning("inference audit unavailable: %s", exc)
            issues.append(
                ReviewIssue(
                    id="audit.unavailable", source="rule", severity="warning", component_ids=[],
                    message=(
                        "The model-based completeness audit (pass 2) did not produce a valid "
                        "result; only deterministic checks were applied."
                    ),
                    next_action="Rerun the analysis, or review hidden/missing parts manually.",
                )
            )
        else:
            components, connections, audit_issues, model_views = _apply_audit(audit, components)
            issues += audit_issues

    components, demotion_issues = _demote_unconfirmed(observations, components)
    issues += demotion_issues

    # D - deterministic requirement checks.
    components = ensure_critical_placeholders(components)
    image_views = {o.image_id: (o.view or "unknown") for o in observations}
    checks = RequirementsValidator().validate(components, connections, image_views=image_views)
    issues += checks.issues

    # E - optional catalog search (empty unless a catalog is configured).
    candidates = find_candidates(components, catalog)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    bom = RobotBOM(
        project_name=project_name,
        image_ids=[i.image_id for i in images],
        components=components,
        connections=connections,
        issues=issues,
        catalog_candidates=candidates,
        ready_to_purchase=False,  # a draft is never purchasing-ready
        requested_views=_merge_views(checks.requested_views, model_views),
        catalog_status=catalog.status,
        image_views=image_views,
        readiness_blockers=purchase_blockers(components, issues),
        metadata={
            "stage": "draft",
            "mode": mode,
            "vision_model": vision_model or getattr(client, "name", "unknown"),
            "analyzed_at": now,
        },
    )
    return AnalysisResult(
        bom=bom, observations=observations, audit=audit,
        review=build_review_document(bom), images=images,
    )


def write_analysis_outputs(result: AnalysisResult, out_dir: str | Path) -> dict[str, Path]:
    """Write observations.json, review.json and the draft BOM exports."""
    directory = Path(out_dir)
    written = {
        "observations.json": write_json(
            directory / "observations.json",
            {
                "images": [
                    {"image_id": i.image_id, "filename": i.filename, "sha256": i.sha256,
                     "width": i.width, "height": i.height}
                    for i in result.images
                ],
                "pass1_observations": [o.model_dump(mode="json") for o in result.observations],
                "pass2_inference_audit": result.audit.model_dump(mode="json") if result.audit else None,
                "metadata": result.bom.metadata,
            },
        ),
        "review.json": write_json(directory / "review.json", result.review.model_dump(mode="json")),
    }
    written.update(BOMExporter().export(result.bom, directory))
    return written
