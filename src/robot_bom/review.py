"""Stage F - human verification.

``analyze`` writes ``review.json``. A person edits the ``bom`` section (confirm / reject /
change quantities / enter exact part numbers / resolve issues) and runs ``finalize``.
The untouched ``baseline`` section is what the edits are diffed against, so every
correction lands in the audit trail.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from .catalog import CatalogClient, NullCatalogClient, find_candidates
from .models import AuditEntry, Component, ReviewDocument, ReviewIssue, RobotBOM
from .suggest import (
    DEFAULT_ACTION, SUGGESTION_NOTE, default_values, is_suggestion_candidate, settle_unknowns,
    suggestion_candidates,
)
from .validation import RequirementsValidator, purchase_blockers

REVIEW_INSTRUCTIONS = [
    "Edit ONLY the 'bom' section. Leave 'baseline' untouched - it is used to build the audit trail.",
    "Per component: set status to 'confirmed' or 'rejected'; correct visible_quantity; set "
    "required_quantity and purchase_quantity (0 = nothing to buy, e.g. custom or already owned).",
    "Enter manufacturer / model / sku only when you have verified them on the physical part or its "
    "documentation. Leave them null if unknown - null is correct, a guess is not.",
    "evidence_type describes what the PHOTOS show and normally stays as is; status records YOUR "
    "verification. A part you know exists but is not in any photo stays 'inferred'/'unknown' with "
    "status 'confirmed'.",
    "Electrical specs are strings in 'specs': voltage_v (power source, motor), current_a (motor "
    "stall/peak), max_voltage_v / max_current_a / min_voltage_v (motor driver or relay board).",
    "To close a warning or model-raised issue set its 'resolved' to true and add a 'resolution_note'. "
    "Rule-based CRITICAL issues close only when the component data they check is corrected.",
    "You do not have to review every line. Lines left at 'needs_review' stay in the BOM tagged "
    "'not reviewed', and anything critical that is still unknown is filled with a suggested part "
    "or value (listed in the line's assumed_fields) with shop links.",
    "Then run: robot-bom finalize <this file> --out <dir>. ready_to_purchase is recomputed; "
    "editing it by hand has no effect.",
]


class ReviewError(ValueError):
    """The review file cannot be used; the message explains what to fix."""


def build_review_document(bom: RobotBOM) -> ReviewDocument:
    return ReviewDocument(
        instructions=REVIEW_INSTRUCTIONS,
        bom=bom.model_copy(deep=True),
        baseline=bom.model_copy(deep=True),
    )


def load_review(source: str | Path | dict) -> ReviewDocument:
    if isinstance(source, dict):
        data = source
    else:
        path = Path(source)
        if not path.is_file():
            raise ReviewError(f"review file not found: {path}")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ReviewError(f"{path} is not valid JSON: {exc.msg} (line {exc.lineno})") from None
    if not isinstance(data, dict) or not isinstance(data.get("bom"), dict):
        raise ReviewError("review file must be a JSON object with a 'bom' section")
    # Readiness is always recomputed; a hand-edited flag must not trip validation.
    data = {**data, "bom": {**data["bom"], "ready_to_purchase": False, "readiness_blockers": []}}
    try:
        return ReviewDocument.model_validate(data)
    except ValidationError as exc:
        lines = [
            f"  - {'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in exc.errors()[:15]
        ]
        raise ReviewError("review file failed validation:\n" + "\n".join(lines)) from None


_NO_LONGER_RAISED = "No longer raised after review corrections."

_TRACKED_FIELDS = [
    "category", "name", "evidence_type", "visible_quantity", "required_quantity",
    "purchase_quantity", "manufacturer", "model", "sku", "specs", "status", "notes", "evidence",
]


def _own_notes(notes: list[str]) -> list[str]:
    return [n for n in notes if not n.startswith(SUGGESTION_NOTE)]


def _diff(baseline: RobotBOM, edited: RobotBOM, actor: str, now: str) -> list[AuditEntry]:
    entries: list[AuditEntry] = []
    # Values an earlier default-suggestion step wrote (the web page sends a finalized BOM back
    # for the next round): they are the app's, so they are not logged as the reviewer's edits.
    defaults = default_values(edited.audit_trail)

    def add(action: str, target: str, field: str | None = None, old=None, new=None) -> None:
        entries.append(AuditEntry(timestamp=now, actor=actor, action=action, target=target,
                                  field=field, old=old, new=new))

    before = {c.id: c for c in baseline.components}
    after = {c.id: c for c in edited.components}
    for component_id, component in after.items():
        original = before.get(component_id)
        suggested = defaults.get(component_id, {})
        if original is None:
            if not suggested.get("created"):
                add("component_added", component_id, new=component.model_dump(mode="json"))
            continue
        old, new = original.model_dump(mode="json"), component.model_dump(mode="json")
        new["specs"] = {k: v for k, v in new["specs"].items()
                        if k in old["specs"] or suggested.get(f"specs.{k}") != v}
        old["notes"], new["notes"] = _own_notes(old["notes"]), _own_notes(new["notes"])
        for field in _TRACKED_FIELDS:
            if field in suggested and new[field] == suggested[field]:
                continue
            if old[field] != new[field]:
                action = f"component_{new['status']}" if field == "status" else "component_modified"
                add(action, component_id, field, old[field], new[field])
    for component_id in before.keys() - after.keys():
        add("component_removed", component_id, old=before[component_id].model_dump(mode="json"))

    issues_before = {i.id: i for i in baseline.issues}
    refinalizing = edited.metadata.get("stage") == "final"
    for issue in edited.issues:
        original = issues_before.get(issue.id)
        if issue.source == "rule" and (issue.resolution_note == _NO_LONGER_RAISED or (original is None and refinalizing)):
            continue  # the checks raised or closed this one on an earlier finalize, not the reviewer
        if original is None:
            add("issue_added", issue.id or issue.message[:60], new=issue.model_dump(mode="json"))
        elif (original.resolved, original.resolution_note) != (issue.resolved, issue.resolution_note):
            add("issue_resolved" if issue.resolved else "issue_reopened", issue.id, "resolved",
                {"resolved": original.resolved, "note": original.resolution_note},
                {"resolved": issue.resolved, "note": issue.resolution_note})

    connections_before = {c.model_dump_json() for c in baseline.connections}
    connections_after = {c.model_dump_json() for c in edited.connections}
    for raw in connections_after - connections_before:
        add("connection_added", "connections", new=json.loads(raw))
    for raw in connections_before - connections_after:
        add("connection_removed", "connections", old=json.loads(raw))
    return entries


def _merge_issues(
    reviewed: list[ReviewIssue], fresh: list[ReviewIssue], components: list[Component]
) -> list[ReviewIssue]:
    """Combine re-run rule issues with the reviewer's decisions."""
    previous = {i.id: i for i in reviewed if i.id}
    status = {c.id: c.status for c in components}
    merged: list[ReviewIssue] = []
    fresh_ids = set()

    for issue in fresh:
        fresh_ids.add(issue.id)
        earlier = previous.get(issue.id)
        if earlier is not None and earlier.resolved:
            if issue.severity == "critical":
                issue.resolution_note = (
                    "Reviewer marked this resolved, but the check still fails on the reviewed data. "
                    "Correct the component data it refers to."
                    + (f" (Reviewer note: {earlier.resolution_note})" if earlier.resolution_note else "")
                )
            else:
                issue.resolved, issue.resolution_note = True, earlier.resolution_note or "Resolved by reviewer."
        merged.append(issue)

    for index, issue in enumerate(reviewed):
        if issue.id in fresh_ids:
            continue
        issue = issue.model_copy(deep=True)
        if not issue.id:
            issue.id, issue.source = f"reviewer.{index + 1}", "reviewer"
        referenced = list(issue.component_ids)
        issue.component_ids = [cid for cid in referenced if cid in status]
        if issue.source == "rule" and not issue.resolved:
            # The rule no longer fires on the corrected data.
            issue.resolved, issue.resolution_note = True, _NO_LONGER_RAISED
        elif issue.source == "reconciler" and not issue.resolved:
            if not referenced or any(status.get(cid, "rejected") == "rejected" for cid in referenced):
                issue.resolved = True
                issue.resolution_note = "Resolved in review: one of the entries was rejected or removed."
        merged.append(issue)
    return merged


def finalize(
    review: ReviewDocument,
    *,
    validator: RequirementsValidator | None = None,
    catalog: CatalogClient | None = None,
    now: str | None = None,
) -> RobotBOM:
    """Apply reviewer corrections, re-run the checks and compute purchase readiness."""
    validator = validator or RequirementsValidator()
    catalog = catalog or NullCatalogClient()
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    actor = review.reviewer or "reviewer"
    edited = review.bom

    # Edits are always diffed against the baseline, so re-finalizing never duplicates entries.
    audit = list(review.baseline.audit_trail)
    audit += [e for e in edited.audit_trail if e.action == DEFAULT_ACTION and e not in audit]
    audit += _diff(review.baseline, edited, actor, now)
    # Whatever is critical and still unknown is filled with a suggestion instead of blocking.
    components = [c.model_copy(deep=True) for c in edited.components]
    audit += settle_unknowns(components, now=now)
    checks = validator.validate(components, edited.connections, image_views=edited.image_views)
    issues = _merge_issues(edited.issues, checks.issues, components)

    requested = list(checks.requested_views)
    seen = {v.view.lower() for v in requested}
    for view in edited.requested_views:
        # keep model-requested views; rule-requested ones were just recomputed
        if view.source != "rule" and view.view.lower() not in seen:
            requested.append(view)
            seen.add(view.view.lower())
    requested.sort(key=lambda v: v.priority)

    active = {c.id for c in components if c.status != "rejected"}
    candidates = find_candidates(components, catalog)
    candidates += [c for c in edited.catalog_candidates if is_suggestion_candidate(c) and c.component_id in active]
    candidates += suggestion_candidates(components, candidates, now=now)
    blockers = purchase_blockers(components, issues)
    audit.append(
        AuditEntry(timestamp=now, actor="robot-bom", action="finalized", target="bom",
                   field="ready_to_purchase", old=False, new=not blockers)
    )
    try:
        return RobotBOM(
            project_name=edited.project_name,
            image_ids=edited.image_ids,
            components=components,
            connections=edited.connections,
            issues=issues,
            catalog_candidates=candidates,
            ready_to_purchase=not blockers,
            requested_views=requested,
            catalog_status=catalog.status,
            image_views=edited.image_views,
            readiness_blockers=blockers,
            metadata={**edited.metadata, "stage": "final", "finalized_at": now},
            audit_trail=audit,
        )
    except ValidationError as exc:
        raise ReviewError(f"reviewed BOM is inconsistent: {exc.errors()[0]['msg']}") from None
