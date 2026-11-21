"""Strict data contracts for the pipeline.

Two ideas are kept apart on purpose:

* ``evidence_type`` says what the *photos* support (observed / inferred / unknown).
* ``status`` says what a *human* has verified (needs_review / confirmed / rejected).

``confidence`` is the vision model's own estimate. It is NOT a calibrated
probability and never substitutes for human verification.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Status = Literal["needs_review", "confirmed", "rejected"]
Severity = Literal["critical", "warning", "info"]
Relation = Literal["mechanically_attached", "wired_to", "drives", "supports", "unknown"]

# Strings a model or a person may type when they mean "I don't know".
# They are normalised to ``None`` so they can never pass as a real identifier.
_PLACEHOLDER_STRINGS = {
    "", "unknown", "n/a", "na", "none", "null", "tbd", "?", "-", "unspecified",
    "not visible", "not specified",
}


def clean_identifier(value: object) -> object:
    """Map empty / placeholder identifier strings to ``None``."""
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.lower() in _PLACEHOLDER_STRINGS:
            return None
        return stripped
    return value


class EvidenceType(str, Enum):
    OBSERVED = "observed"
    INFERRED = "inferred"
    UNKNOWN = "unknown"


class Evidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_id: str = Field(min_length=1)
    description: str = Field(min_length=1)
    # Normalised x1, y1, x2, y2 in 0..1 on the upright (EXIF-corrected) image.
    # ``None`` when the model gave no supportable location - never guessed.
    bbox_xyxy_norm: tuple[float, float, float, float] | None = None
    # Who produced this entry: the vision model, or the optional local detector.
    source: Literal["vlm", "grounding_dino"] = "vlm"

    @field_validator("bbox_xyxy_norm")
    @classmethod
    def _bbox_in_range(cls, bbox):
        if bbox is None:
            return bbox
        x1, y1, x2, y2 = bbox
        if not all(0.0 <= v <= 1.0 for v in bbox):
            raise ValueError("bbox_xyxy_norm values must be within 0..1")
        if x2 <= x1 or y2 <= y1:
            raise ValueError("bbox_xyxy_norm must satisfy x1 < x2 and y1 < y2")
        return bbox


class Component(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    category: str = Field(min_length=1)
    name: str = Field(min_length=1)
    evidence_type: EvidenceType
    evidence: list[Evidence] = Field(default_factory=list)
    visible_quantity: int | None = Field(default=None, ge=0)
    required_quantity: int | None = Field(default=None, ge=0)
    purchase_quantity: int | None = Field(default=None, ge=0)
    confidence: float | None = Field(default=None, ge=0, le=1)
    manufacturer: str | None = None
    model: str | None = None
    sku: str | None = None
    specs: dict[str, str] = Field(default_factory=dict)
    status: Status = "needs_review"
    notes: list[str] = Field(default_factory=list)

    @field_validator("manufacturer", "model", "sku", mode="before")
    @classmethod
    def _no_placeholder_identifiers(cls, value):
        return clean_identifier(value)

    @model_validator(mode="after")
    def _evidence_rules(self):
        if self.evidence_type is EvidenceType.OBSERVED and not self.evidence:
            raise ValueError(
                f"component '{self.id}' is marked observed but has no image evidence"
            )
        if self.evidence_type is not EvidenceType.OBSERVED and self.visible_quantity is not None:
            raise ValueError(
                f"component '{self.id}' is {self.evidence_type.value}: visible_quantity must be "
                "null (inferred quantities are never merged into observed quantities)"
            )
        return self


class Connection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: str
    target_id: str
    relation: Relation
    evidence_type: EvidenceType
    rationale: str


class CatalogCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    component_id: str
    vendor: str
    title: str
    sku: str | None = None
    price: float | None = Field(default=None, ge=0)
    currency: str | None = None
    product_url: str
    evidence_notes: str
    compatible: bool | None = None
    query: str | None = None
    queried_at: str | None = None  # ISO 8601 UTC timestamp of the catalog query
    match_score: float | None = None

    @field_validator("sku", mode="before")
    @classmethod
    def _no_placeholder_sku(cls, value):
        return clean_identifier(value)

    @field_validator("product_url")
    @classmethod
    def _absolute_url(cls, value: str):
        if not value.lower().startswith(("http://", "https://")):
            raise ValueError("product_url must be an absolute http(s) URL returned by the catalog")
        return value


class ReviewIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    severity: Severity
    component_ids: list[str] = Field(default_factory=list)
    message: str
    next_action: str
    # Extensions used by the review flow.
    id: str = ""
    source: Literal["rule", "model", "reconciler", "reviewer"] = "rule"
    resolved: bool = False
    resolution_note: str | None = None


class ViewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    view: str
    reason: str
    priority: int = Field(default=2, ge=1, le=3)  # 1 = most informative
    source: Literal["rule", "model", "reviewer"] = "rule"


class AuditEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    actor: str
    action: str
    target: str
    field: str | None = None
    old: object | None = None
    new: object | None = None


class RobotBOM(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_name: str
    image_ids: list[str]
    components: list[Component]
    connections: list[Connection] = Field(default_factory=list)
    issues: list[ReviewIssue] = Field(default_factory=list)
    catalog_candidates: list[CatalogCandidate] = Field(default_factory=list)
    ready_to_purchase: bool = False
    # Extensions beyond the minimum contract.
    requested_views: list[ViewRequest] = Field(default_factory=list)
    catalog_status: str = "Catalog lookup not configured"
    image_views: dict[str, str] = Field(default_factory=dict)  # image_id -> view label
    readiness_blockers: list[str] = Field(default_factory=list)
    metadata: dict[str, str] = Field(default_factory=dict)
    audit_trail: list[AuditEntry] = Field(default_factory=list)

    @model_validator(mode="after")
    def _referential_integrity(self):
        ids = [c.id for c in self.components]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"duplicate component ids: {dupes}")
        known = set(ids)
        images = set(self.image_ids)
        if len(images) != len(self.image_ids):
            raise ValueError("duplicate image ids")

        for comp in self.components:
            for ev in comp.evidence:
                if ev.image_id not in images:
                    raise ValueError(
                        f"component '{comp.id}' cites image '{ev.image_id}' which is not in image_ids"
                    )
        for conn in self.connections:
            for end in (conn.source_id, conn.target_id):
                if end not in known:
                    raise ValueError(f"connection references unknown component id '{end}'")
        for issue in self.issues:
            for cid in issue.component_ids:
                if cid not in known:
                    raise ValueError(f"issue references unknown component id '{cid}'")
        for cand in self.catalog_candidates:
            if cand.component_id not in known:
                raise ValueError(
                    f"catalog candidate references unknown component id '{cand.component_id}'"
                )

        if self.ready_to_purchase:
            if any(i.severity == "critical" and not i.resolved for i in self.issues):
                raise ValueError("ready_to_purchase cannot be true with unresolved critical issues")
            if any(c.status == "needs_review" for c in self.components):
                raise ValueError("ready_to_purchase cannot be true while components need review")
            if self.readiness_blockers:
                raise ValueError("ready_to_purchase cannot be true while readiness blockers remain")
        return self

    def active_components(self) -> list[Component]:
        return [c for c in self.components if c.status != "rejected"]

    def unresolved_issues(self, severity: str | None = None) -> list[ReviewIssue]:
        return [
            i for i in self.issues
            if not i.resolved and (severity is None or i.severity == severity)
        ]


# --------------------------------------------------------------------------
# Vision-model response contracts (what we ask the API to return).
# They deliberately have NO manufacturer / model / sku / price fields.
# --------------------------------------------------------------------------


class PartDetection(BaseModel):
    """A region the optional local detector matched to an observed part."""

    bbox_xyxy_norm: tuple[float, float, float, float]
    score: float  # detector score; not a calibrated probability
    mask_score: float | None = None  # SAM 2 mask quality score, if a mask was produced


class ObservedPart(BaseModel):
    """One visible part (or group of identical visible parts) in ONE image."""

    model_config = ConfigDict(extra="ignore")

    category: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    visible_quantity: int | None = Field(default=None, ge=0)
    bbox_xyxy_norm: tuple[float, float, float, float] | None = None
    parent_assembly: str | None = None
    visible_markings: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    # Filled in by the optional grounding stage, never by the vision model's reply.
    detections: list[PartDetection] = Field(default_factory=list)

    @field_validator("bbox_xyxy_norm", mode="before")
    @classmethod
    def _drop_unusable_bbox(cls, bbox):
        # A malformed box is treated as "no location available" (null), never repaired
        # by guessing.
        try:
            if bbox is None or len(bbox) != 4:
                return None
            x1, y1, x2, y2 = (float(v) for v in bbox)
        except (TypeError, ValueError):
            return None
        if not all(0.0 <= v <= 1.0 for v in (x1, y1, x2, y2)) or x2 <= x1 or y2 <= y1:
            return None
        return (x1, y1, x2, y2)

    @field_validator("parent_assembly", "visible_markings", mode="before")
    @classmethod
    def _clean_optional_text(cls, value):
        return clean_identifier(value)


class UnconfirmedPart(BaseModel):
    """A pass-1 claim that the visibility re-check could not confirm."""

    category: str
    name: str
    reason: str


class ImageObservation(BaseModel):
    """Pass 1 result for a single image."""

    model_config = ConfigDict(extra="ignore")

    view: str | None = None  # top / underside / side / front / rear / close-up / unknown
    parts: list[ObservedPart] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    image_id: str = ""  # filled in by the pipeline, never trusted from the model
    # Filled in by the visibility re-check, never by the model's first reply.
    unconfirmed: list[UnconfirmedPart] = Field(default_factory=list)
    verification: Literal["not_run", "ok", "failed"] = "not_run"


class PartCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")

    index: int = Field(ge=0)
    directly_visible: bool
    reason: str = ""


class VisibilityAudit(BaseModel):
    """Re-check of pass-1 claims against the same image."""

    model_config = ConfigDict(extra="ignore")

    checks: list[PartCheck] = Field(default_factory=list)


class InferredItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    category: str = Field(min_length=1)
    name: str = Field(min_length=1)
    # ``observed`` is not an allowed value here: pass 2 cannot create observations.
    evidence_type: Literal["inferred", "unknown"]
    rationale: str = Field(min_length=1)
    related_component_ids: list[str] = Field(default_factory=list)


class ProposedConnection(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source_id: str
    target_id: str
    relation: Relation = "unknown"
    evidence_type: Literal["observed", "inferred", "unknown"] = "inferred"
    rationale: str = ""


class AuditIssue(BaseModel):
    model_config = ConfigDict(extra="ignore")

    severity: Severity
    component_ids: list[str] = Field(default_factory=list)
    message: str = Field(min_length=1)
    next_action: str = Field(min_length=1)


class RequestedView(BaseModel):
    model_config = ConfigDict(extra="ignore")

    view: str = Field(min_length=1)
    reason: str = Field(min_length=1)


class InferenceAudit(BaseModel):
    """Pass 2 result: proposals and questions only, never confirmations."""

    model_config = ConfigDict(extra="ignore")

    inferred_components: list[InferredItem] = Field(default_factory=list)
    connections: list[ProposedConnection] = Field(default_factory=list)
    issues: list[AuditIssue] = Field(default_factory=list)
    requested_views: list[RequestedView] = Field(default_factory=list)


class ReviewDocument(BaseModel):
    """The human-editable ``review.json``. Edit ``bom``; leave ``baseline`` alone."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    instructions: list[str] = Field(default_factory=list)
    reviewer: str | None = None
    bom: RobotBOM
    baseline: RobotBOM
