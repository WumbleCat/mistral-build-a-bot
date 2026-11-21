"""Command line interface: ``robot-bom analyze | finalize | check-api | serve``."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .catalog import build_catalog_client
from .config import ConfigError, load_settings
from .export import BOMExporter, write_json
from .extraction import VisionResponseError
from .ingest import IngestError, load_images
from .pipeline import analyze, write_analysis_outputs
from .review import ReviewError, finalize, load_review
from .vision import OpenAICompatVisionClient, VisionAPIError, build_vision_client


def _summary(bom) -> str:
    observed = [c for c in bom.components if c.evidence_type.value == "observed"]
    unverified = [c for c in bom.components if c.evidence_type.value != "observed"]
    lines = [
        f"Project: {bom.project_name}  (mode: {bom.metadata.get('mode', 'n/a')}, stage: {bom.metadata.get('stage', 'n/a')})",
        f"Observed components ({len(observed)}):",
    ]
    for c in observed:
        quantity = "unknown qty" if c.visible_quantity is None else f"x{c.visible_quantity}"
        lines.append(f"  - {c.id:<22} {c.name} ({quantity}, status: {c.status})")
    lines.append(f"Unverified / likely hidden ({len(unverified)}):")
    for c in unverified:
        lines.append(f"  - {c.id:<22} {c.name} [{c.evidence_type.value}, status: {c.status}]")
    open_issues = bom.unresolved_issues()
    counts = {s: sum(1 for i in open_issues if i.severity == s) for s in ("critical", "warning", "info")}
    lines.append(
        f"Open issues: {counts['critical']} critical, {counts['warning']} warning, {counts['info']} info"
    )
    if bom.requested_views:
        lines.append("Requested photos/measurements: " + "; ".join(v.view for v in bom.requested_views))
    lines.append(f"Catalog: {bom.catalog_status}")
    lines.append(f"Ready to purchase: {'YES' if bom.ready_to_purchase else 'NO'}")
    for blocker in bom.readiness_blockers:
        lines.append(f"  blocked by: {blocker}")
    return "\n".join(lines)


def _cmd_analyze(args: argparse.Namespace) -> int:
    settings = load_settings()
    mock = args.mock or settings.mock
    client = build_vision_client(settings, mock=mock)
    reasoning_client = None
    model = "mock"
    if isinstance(client, OpenAICompatVisionClient):
        if args.model:
            client = client.with_model(args.model)
        model = args.model or settings.vision_model
        reasoning_model = args.model or settings.reasoning_model
        if reasoning_model != model:
            reasoning_client = client.with_model(reasoning_model)
    images = load_images(args.images)
    result = analyze(
        images,
        client,
        project_name=args.project_name or Path(args.images[0]).stem,
        catalog=build_catalog_client(settings),
        max_retries=settings.max_retries,
        mode="mock" if mock else "live",
        vision_model=model,
        reasoning_client=reasoning_client,
    )
    written = write_analysis_outputs(result, args.out)
    print(_summary(result.bom))
    print("\nWrote:")
    for path in written.values():
        print(f"  {path}")
    print(f"\nNext: edit {written['review.json']} then run\n  robot-bom finalize {written['review.json']} --out {Path(args.out) / 'final'}")
    return 0


def _cmd_finalize(args: argparse.Namespace) -> int:
    settings = load_settings()
    review = load_review(args.review)
    if args.reviewer:
        review.reviewer = args.reviewer
    bom = finalize(review, catalog=build_catalog_client(settings))
    written = BOMExporter().export(bom, args.out)
    written["audit.json"] = write_json(
        Path(args.out) / "audit.json", [e.model_dump(mode="json") for e in bom.audit_trail]
    )
    print(_summary(bom))
    print("\nWrote:")
    for path in written.values():
        print(f"  {path}")
    return 0


def _cmd_check_api(args: argparse.Namespace) -> int:
    settings = load_settings()
    client = build_vision_client(settings)
    print(f"Endpoint: {settings.base_url}")
    print(f"Vision model: {settings.vision_model}   Reasoning model: {settings.reasoning_model}")
    print("API key: configured (value not shown)")
    if not isinstance(client, OpenAICompatVisionClient):
        print("Mock mode is enabled (ROBOT_BOM_MOCK); no API call made.")
        return 0
    models = client.list_models()
    entry = next((m for m in models if m.get("id") == settings.vision_model), None)
    if entry is None:
        print(f"WARNING: model '{settings.vision_model}' is not in the provider's model list.")
        return 1
    vision = (entry.get("capabilities") or {}).get("vision")
    print(f"Credentials accepted. Model found; vision capability reported: {vision}")
    return 0 if vision is not False else 1


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("robot_bom.api:app", host=args.host, port=args.port, log_level="info")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="robot-bom",
        description="Robot photos -> evidence-grounded, human-verified bill of materials.",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("analyze", help="analyse one or more robot photos into a draft BOM + review.json")
    p.add_argument("images", nargs="+", help="image files (jpg/png/webp), e.g. top and underside views")
    p.add_argument("--out", default="output", help="output directory (default: output)")
    p.add_argument("--project-name", help="project name (default: first image's file name)")
    p.add_argument("--mock", action="store_true", help="offline mock mode: canned responses, no API key needed")
    p.add_argument("--model", help="override VISION_MODEL for this run")
    p.set_defaults(func=_cmd_analyze)

    p = sub.add_parser("finalize", help="apply an edited review.json and export the final BOM")
    p.add_argument("review", help="path to the edited review.json")
    p.add_argument("--out", default="output/final", help="output directory (default: output/final)")
    p.add_argument("--reviewer", help="reviewer name recorded in the audit trail")
    p.set_defaults(func=_cmd_finalize)

    p = sub.add_parser("check-api", help="verify the configured vision API key and model (no secrets printed)")
    p.set_defaults(func=_cmd_check_api)

    p = sub.add_parser("serve", help="run the web UI / HTTP API")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(func=_cmd_serve)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    if not args.verbose:
        logging.getLogger("httpx").setLevel(logging.WARNING)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    try:
        return args.func(args)
    except (ConfigError, IngestError, ReviewError, VisionResponseError, VisionAPIError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
