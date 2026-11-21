"""Stage G - JSON, CSV and Markdown exports plus the unresolved-issues report.

Null stays null: an unknown quantity is exported as an empty CSV cell / the word
``unknown`` in Markdown, never as 0.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

from .models import Component, EvidenceType, ReviewIssue, RobotBOM

CSV_FIELDS = [
    "id", "category", "name", "evidence_type", "visible_quantity", "required_quantity",
    "purchase_quantity", "manufacturer", "model", "sku", "status", "confidence", "notes",
]


def _cell(text: object) -> str:
    """Escape a value for a Markdown table cell."""
    return str(text).replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def _csv_value(value: object) -> object:
    """Null -> empty cell; neutralise text a spreadsheet would run as a formula."""
    if value is None:
        return ""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@"):
        return "'" + value
    return value


def _qty(value: int | None) -> str:
    return "unknown" if value is None else str(value)


def _ident(value: str | None) -> str:
    return _cell(value) if value else "unknown"


def _table(headers: list[str], rows: list[list[str]]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(" --- " for _ in headers) + "|"]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return lines


def _component_rows(components: list[Component], *, with_evidence: bool) -> list[list[str]]:
    rows = []
    for c in components:
        row = [
            f"`{c.id}`", _cell(c.category), _cell(c.name), _qty(c.visible_quantity),
            _qty(c.required_quantity), _qty(c.purchase_quantity),
            _ident(c.manufacturer), _ident(c.model), _ident(c.sku), c.status,
            "n/a" if c.confidence is None else f"{c.confidence:.2f}",
        ]
        if with_evidence:
            evidence = "; ".join(f"[{e.image_id}] {e.description}" for e in c.evidence if e.source == "vlm")
            boxes = sum(1 for e in c.evidence if e.source == "grounding_dino")
            if boxes:
                evidence += f" (+{boxes} Grounding DINO region(s); see bom.json)"
            row.append(_cell(evidence) or "none (not visible in any photo)")
        else:
            row.append(_cell(" ".join(c.notes)) or "-")
        rows.append(row)
    return rows


_COMPONENT_HEADERS = [
    "ID", "Category", "Name", "Visible qty", "Required qty", "Purchase qty",
    "Manufacturer", "Model", "SKU", "Review status", "Model confidence*",
]


def _issue_lines(issues: list[ReviewIssue]) -> list[str]:
    lines = []
    for issue in issues:
        state = "resolved" if issue.resolved else "OPEN"
        refs = f" (components: {', '.join(f'`{c}`' for c in issue.component_ids)})" if issue.component_ids else ""
        lines.append(f"- **[{issue.severity.upper()} - {state}]** `{issue.id}`{refs}: {issue.message}")
        lines.append(f"  - Next action: {issue.next_action}")
        if issue.resolution_note:
            lines.append(f"  - Note: {issue.resolution_note}")
    return lines


class BOMExporter:
    # ---- individual formats ----------------------------------------------

    def to_json(self, project: RobotBOM) -> str:
        return project.model_dump_json(indent=2)

    def to_csv(self, project: RobotBOM) -> str:
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=CSV_FIELDS, lineterminator="\n")
        writer.writeheader()
        for c in project.components:
            row = c.model_dump(mode="json", include=set(CSV_FIELDS))
            row["notes"] = " | ".join(c.notes)
            writer.writerow({k: _csv_value(row.get(k)) for k in CSV_FIELDS})
        return buffer.getvalue()

    def to_markdown(self, project: RobotBOM) -> str:
        active = project.active_components()
        observed = [c for c in active if c.evidence_type is EvidenceType.OBSERVED]
        confirmed_hidden = [
            c for c in active if c.evidence_type is not EvidenceType.OBSERVED and c.status == "confirmed"
        ]
        inferred = [
            c for c in active if c.evidence_type is EvidenceType.INFERRED and c.status != "confirmed"
        ]
        unknown = [
            c for c in active if c.evidence_type is EvidenceType.UNKNOWN and c.status != "confirmed"
        ]
        rejected = [c for c in project.components if c.status == "rejected"]
        open_critical = project.unresolved_issues("critical")
        stage = project.metadata.get("stage", "draft")

        out: list[str] = [f"# Bill of materials - {project.project_name}", ""]
        if project.metadata.get("mode") == "mock":
            out += ["> **MOCK DATA** - produced by the offline mock client, not by analysing the photos.", ""]
        out += [
            f"- Stage: **{stage}**" + (" (not yet human-reviewed)" if stage != "final" else ""),
            "- Images: " + ", ".join(
                "`{}` ({} view)".format(i, project.image_views.get(i, "unknown")) for i in project.image_ids
            ),
            f"- Vision model: {project.metadata.get('vision_model', 'n/a')}",
            "- Detection mode: " + (
                f"vision model + local Grounding DINO / SAM 2 ({project.metadata.get('grounder')})"
                if project.metadata.get("detection_mode") == "vlm+grounding" else "vision/language model only"
            ),
            f"- Ready to purchase: **{'YES' if project.ready_to_purchase else 'NO'}**",
            "",
            "Quantities shown as `unknown` are not established - unknown is not zero. "
            "Identifiers shown as `unknown` were not verified and have deliberately not been guessed.",
            "",
            "## Confirmed/visible components",
            "",
            "Visible in at least one photo. The part *type* is recognised; make/model is only "
            "listed when a human entered it in review.",
            "",
        ]
        if observed:
            out += _table(_COMPONENT_HEADERS + ["Evidence"], _component_rows(observed, with_evidence=True))
        else:
            out.append("_None._")
        if confirmed_hidden:
            out += ["", "Confirmed by the reviewer but **not visible in any photo**:", ""]
            out += _table(_COMPONENT_HEADERS + ["Notes"], _component_rows(confirmed_hidden, with_evidence=False))
        notes = [(c.id, n) for c in observed for n in c.notes]
        if notes:
            out += ["", "Notes:", ""] + [f"- `{cid}`: {note}" for cid, note in notes]

        out += [
            "", "## Inferred/hidden possibilities", "",
            "Plausible but **not seen and not confirmed**. Do not buy from this table.", "",
        ]
        if inferred:
            out += _table(_COMPONENT_HEADERS + ["Rationale"], _component_rows(inferred, with_evidence=False))
        else:
            out.append("_None._")

        out += ["", "## Unknown critical details", ""]
        if unknown:
            out += _table(_COMPONENT_HEADERS + ["Notes"], _component_rows(unknown, with_evidence=False))
            out.append("")
        if open_critical:
            out += _issue_lines(open_critical)
        elif not unknown:
            out.append("_No unresolved critical unknowns._")

        out += ["", "## Catalog candidates", ""]
        if project.catalog_candidates:
            out += [
                f"Status: {project.catalog_status}. Candidates are search results, **not** confirmed "
                "matches; verify each against the physical part.", "",
            ]
            out += _table(
                ["Component", "Vendor", "Title", "SKU", "Price", "URL", "Compatible", "Queried at", "Notes"],
                [[f"`{c.component_id}`", _cell(c.vendor), _cell(c.title), _ident(c.sku),
                  "unknown" if c.price is None else f"{c.price:g} {c.currency or ''}".strip(),
                  c.product_url, "unverified" if c.compatible is None else str(c.compatible),
                  c.queried_at or "unknown", _cell(c.evidence_notes)] for c in project.catalog_candidates],
            )
        else:
            out.append(f"{project.catalog_status}. No store links or prices are listed.")

        compat = [i for i in project.issues if i.severity != "critical" or i.resolved]
        out += ["", "## Compatibility checks", ""]
        out += _issue_lines(compat) if compat else ["_No further checks raised._"]
        if open_critical:
            out += ["", f"({len(open_critical)} open critical check(s) are listed under *Unknown critical details*.)"]

        out += ["", "## Photos/measurements requested", ""]
        if project.requested_views:
            out += [f"{n}. **{_cell(v.view)}** - {v.reason}" for n, v in enumerate(project.requested_views, 1)]
        else:
            out.append("_None._")

        out += ["", "## Purchase readiness", ""]
        if project.ready_to_purchase:
            out.append(
                "**Ready to purchase**, based on the reviewer's confirmations. This reflects the "
                "reviewed data only; it is not an independent guarantee of completeness."
            )
        else:
            out.append("**NOT ready to purchase.** This BOM is incomplete and must not be used as an order list.")
            out += ["", "Blocking reasons:", ""]
            out += [f"- {b}" for b in project.readiness_blockers] or ["- Human review has not been completed."]

        if rejected:
            out += ["", "## Rejected in review", ""] + [f"- `{c.id}` {c.name}" for c in rejected]
        out += [
            "", "---",
            "\\* Model confidence is the vision model's own estimate. It is **not a calibrated "
            "probability** and is separate from the human review status.", "",
        ]
        return "\n".join(out)

    def to_issues_markdown(self, project: RobotBOM) -> str:
        out = [f"# Unresolved issues - {project.project_name}", ""]
        open_issues = project.unresolved_issues()
        if not open_issues:
            out.append("_No open issues._")
        for severity in ("critical", "warning", "info"):
            group = [i for i in open_issues if i.severity == severity]
            if group:
                out += [f"## {severity.capitalize()} ({len(group)})", ""] + _issue_lines(group) + [""]
        resolved = [i for i in project.issues if i.resolved]
        if resolved:
            out += [f"## Resolved ({len(resolved)})", ""] + _issue_lines(resolved) + [""]
        out += ["## Photos/measurements requested", ""]
        out += [f"{n}. **{v.view}** - {v.reason}" for n, v in enumerate(project.requested_views, 1)] or ["_None._"]
        out += ["", f"Ready to purchase: **{'YES' if project.ready_to_purchase else 'NO'}**", ""]
        return "\n".join(out)

    # ---- files ------------------------------------------------------------

    def export(self, project: RobotBOM, out_dir: str | Path = "output") -> dict[str, Path]:
        directory = Path(out_dir)
        directory.mkdir(parents=True, exist_ok=True)
        files = {
            "bom.json": self.to_json(project),
            "bom.csv": self.to_csv(project),
            "bom.md": self.to_markdown(project),
            "issues.md": self.to_issues_markdown(project),
        }
        written = {}
        for name, text in files.items():
            path = directory / name
            path.write_text(text, encoding="utf-8", newline="\n")
            written[name] = path
        return written


def write_json(path: Path, payload: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n")
    return path
