"""Stage C - cross-image entity reconciliation.

Rules:

* The same part type seen in several photos is counted ONCE. Every supporting image
  reference is kept; the quantity is the largest single-view count (a lower bound).
* A confident match is merged. An uncertain match (same category, different-looking
  name) is NOT merged silently - both entries are kept and a review issue is raised.
* Subcomponents of an assembly (relay blocks on a relay module) are folded into the
  parent's notes instead of becoming separate BOM lines.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import Component, Evidence, EvidenceType, ImageObservation, ObservedPart, ReviewIssue
from .taxonomy import IdAllocator, name_similarity, name_tokens, normalize_category, normalize_name

MERGE_THRESHOLD = 0.6

# Only these parent categories are single purchasable assemblies whose soldered-on parts
# must not become BOM lines. A chassis or breadboard is NOT such a parent: things mounted
# on a frame or plugged into a breadboard are separate parts.
FOLDABLE_PARENTS = {
    "relay_module", "motor_driver", "pcb_module", "microcontroller", "single_board_computer",
    "sensor", "motor", "servo",
}


@dataclass
class _LocalGroup:
    """Identical parts within ONE image."""

    image_id: str
    category: str
    name: str
    quantity: int | None
    quantity_known: bool
    evidence: list[Evidence]
    confidence: float | None
    markings: list[str]
    notes: list[str]


@dataclass
class _Cluster:
    category: str
    name: str
    groups: list[_LocalGroup] = field(default_factory=list)

    def image_ids(self) -> set[str]:
        return {g.image_id for g in self.groups}


@dataclass
class ReconcileResult:
    components: list[Component]
    issues: list[ReviewIssue]


def _pluralise(quantity: int | None, name: str) -> str:
    return f"{quantity} x {name}" if quantity is not None else f"{name} (count not determined)"


class InventoryReconciler:
    def __init__(self, merge_threshold: float = MERGE_THRESHOLD) -> None:
        self.merge_threshold = merge_threshold

    # ---- within one image -------------------------------------------------

    def _local_groups(self, observation: ImageObservation) -> tuple[list[_LocalGroup], list[tuple[str, str]]]:
        """Group one image's parts; returns groups and (child, parent) double-count suspects."""
        parts = [p for p in observation.parts if p.visible_quantity != 0]
        by_name = {normalize_name(p.name): p for p in parts}

        def named_parent(part: ObservedPart) -> ObservedPart | None:
            if not part.parent_assembly:
                return None
            parent = by_name.get(normalize_name(part.parent_assembly))
            return parent if parent is not None and parent is not part else None

        def parent_of(part: ObservedPart) -> ObservedPart | None:
            parent = named_parent(part)
            if parent is None or normalize_category(parent.category) not in FOLDABLE_PARENTS:
                return None
            return parent

        groups: dict[tuple[str, str], _LocalGroup] = {}
        children: list[tuple[ObservedPart, ObservedPart]] = []
        for part in parts:
            parent = parent_of(part)
            if parent is not None and parent_of(parent) is None:
                children.append((part, parent))
                continue
            category = normalize_category(part.category)
            key = (category, normalize_name(part.name))
            # With detector boxes available, the vision model's rough box is dropped in
            # favour of one evidence entry per located region.
            evidence = Evidence(
                image_id=observation.image_id,
                description=part.description,
                bbox_xyxy_norm=None if part.detections else part.bbox_xyxy_norm,
            )
            located = [
                Evidence(
                    image_id=observation.image_id,
                    description=(
                        f"Located by Grounding DINO (detector score {hit.score:.2f}"
                        + (f", SAM 2 mask score {hit.mask_score:.2f}" if hit.mask_score is not None else "")
                        + "; not calibrated probabilities)."
                    ),
                    bbox_xyxy_norm=hit.bbox_xyxy_norm,
                    source="grounding_dino",
                )
                for hit in part.detections
            ]
            group = groups.get(key)
            if group is None:
                groups[key] = _LocalGroup(
                    image_id=observation.image_id,
                    category=category,
                    name=part.name.strip(),
                    quantity=part.visible_quantity,
                    quantity_known=part.visible_quantity is not None,
                    evidence=[evidence, *located],
                    confidence=part.confidence,
                    markings=[part.visible_markings] if part.visible_markings else [],
                    notes=[],
                )
                if named_parent(part) is not None:
                    groups[key].notes.append(f"Mounted on / attached to '{part.parent_assembly}'.")
                elif part.parent_assembly:
                    groups[key].notes.append(
                        f"Model described this as part of '{part.parent_assembly}', which was not "
                        "listed; kept as its own line - check for double counting."
                    )
            else:
                # Two entries for the same part type in one image are separate sightings.
                group.quantity_known = group.quantity_known and part.visible_quantity is not None
                group.quantity = (
                    (group.quantity or 0) + part.visible_quantity if group.quantity_known else None
                )
                group.evidence += [evidence, *located]
                if part.confidence is not None:
                    group.confidence = max(group.confidence or 0.0, part.confidence)
                if part.visible_markings and part.visible_markings not in group.markings:
                    group.markings.append(part.visible_markings)

        for child, parent in children:
            key = (normalize_category(parent.category), normalize_name(parent.name))
            markings = f" Marking read on it: '{child.visible_markings}'." if child.visible_markings else ""
            groups[key].notes.append(
                f"Contains {_pluralise(child.visible_quantity, child.name)} "
                f"(subcomponent seen in {observation.image_id}; not counted as a separate BOM line)."
                + markings
            )

        # Heuristic guard: an assembly and its bare subcomponent both listed as top-level.
        suspects: list[tuple[str, str]] = []
        local = list(groups.values())
        for a in local:
            for b in local:
                if a is b:
                    continue
                relay_pair = a.category == "relay" and b.category == "relay_module"
                tokens_a, tokens_b = name_tokens(a.name), name_tokens(b.name)
                nested_name = a.category != b.category and tokens_a < tokens_b
                if relay_pair or nested_name:
                    suspects.append((f"{a.category}|{normalize_name(a.name)}", f"{b.category}|{normalize_name(b.name)}"))
        return local, suspects

    # ---- across images ----------------------------------------------------

    def merge(self, per_image_observations: list[ImageObservation]) -> ReconcileResult:
        clusters: list[_Cluster] = []
        uncertain: list[tuple[_Cluster, _Cluster, float]] = []
        suspects: list[tuple[str, str, str]] = []

        for observation in per_image_observations:
            groups, local_suspects = self._local_groups(observation)
            suspects += [(observation.image_id, a, b) for a, b in local_suspects]
            new_clusters: list[_Cluster] = []
            for group in groups:
                candidates = [
                    (name_similarity(group.name, c.name), c)
                    for c in clusters
                    if c.category == group.category and group.image_id not in c.image_ids()
                ]
                best_score, best = max(candidates, key=lambda sc: sc[0], default=(0.0, None))
                if best is not None and best_score >= self.merge_threshold:
                    best.groups.append(group)
                    continue
                cluster = _Cluster(category=group.category, name=group.name, groups=[group])
                new_clusters.append(cluster)
                if best is not None:
                    uncertain.append((best, cluster, best_score))
            clusters += new_clusters

        ids = IdAllocator()
        components: list[Component] = []
        cluster_ids: dict[int, str] = {}
        key_to_id: dict[tuple[str, str], str] = {}
        issues: list[ReviewIssue] = []

        for cluster in clusters:
            component_id = ids.new(cluster.category)
            cluster_ids[id(cluster)] = component_id
            for group in cluster.groups:
                key_to_id[(group.image_id, f"{group.category}|{normalize_name(group.name)}")] = component_id

            counts = {g.image_id: g.quantity for g in cluster.groups if g.quantity is not None}
            visible = max(counts.values()) if counts else None
            notes: list[str] = []
            for group in cluster.groups:
                notes += [n for n in group.notes if n not in notes]
            images = sorted(cluster.image_ids())
            if len(images) > 1:
                notes.append(
                    f"Matched across {len(images)} images ({', '.join(images)}) and counted once; "
                    "visible_quantity is the largest single-view count (a lower bound)."
                )
            if len(set(counts.values())) > 1:
                detail = ", ".join(f"{img}: {qty}" for img, qty in sorted(counts.items()))
                notes.append(f"Visible counts differ between views ({detail}).")
                issues.append(
                    ReviewIssue(
                        id=f"reconcile.count_mismatch.{component_id}",
                        source="reconciler",
                        severity="warning",
                        component_ids=[component_id],
                        message=(
                            f"'{cluster.name}' was counted differently in different photos ({detail}). "
                            "The largest single-view count is used, but the true total may be higher "
                            "if different photos show different units."
                        ),
                        next_action="Count the physical parts and correct visible_quantity in review.",
                    )
                )
            markings = []
            for group in cluster.groups:
                markings += [m for m in group.markings if m not in markings]
            confidences = [g.confidence for g in cluster.groups if g.confidence is not None]
            components.append(
                Component(
                    id=component_id,
                    category=cluster.category,
                    name=cluster.name,
                    evidence_type=EvidenceType.OBSERVED,
                    evidence=[e for g in cluster.groups for e in g.evidence],
                    visible_quantity=visible,
                    confidence=max(confidences) if confidences else None,
                    specs={"visible_markings": "; ".join(markings)} if markings else {},
                    notes=notes,
                )
            )

        for first, second, score in uncertain:
            a, b = cluster_ids[id(first)], cluster_ids[id(second)]
            issues.append(
                ReviewIssue(
                    id=f"reconcile.uncertain_match.{a}.{b}",
                    source="reconciler",
                    severity="warning",
                    component_ids=[a, b],
                    message=(
                        f"'{first.name}' ({', '.join(sorted(first.image_ids()))}) and '{second.name}' "
                        f"({', '.join(sorted(second.image_ids()))}) are both '{first.category}' parts and "
                        f"may be the same physical part seen from different angles (name similarity "
                        f"{score:.2f}). They were NOT merged automatically."
                    ),
                    next_action=(
                        "Compare the photos. If they are the same part, reject one entry in review; "
                        "if they are different parts, keep both."
                    ),
                )
            )

        seen_pairs: set[tuple[str, str]] = set()
        for image_id, child_key, parent_key in suspects:
            child, parent = key_to_id.get((image_id, child_key)), key_to_id.get((image_id, parent_key))
            if not child or not parent or child == parent or (child, parent) in seen_pairs:
                continue
            seen_pairs.add((child, parent))
            issues.append(
                ReviewIssue(
                    id=f"reconcile.possible_double_count.{child}.{parent}",
                    source="reconciler",
                    severity="warning",
                    component_ids=[child, parent],
                    message=(
                        f"'{child}' may be a subcomponent of the assembly '{parent}' rather than a "
                        "separately purchased part (possible double counting)."
                    ),
                    next_action="If it is part of the assembly, reject the subcomponent line in review.",
                )
            )

        return ReconcileResult(components=components, issues=issues)
