"""Command line interface: ``robot-bom analyze | finalize | infer | models | check-api | serve``."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .catalog import build_catalog_client
from .config import ConfigError, load_settings
from .design import best_guess
from .export import BOMExporter, write_json
from .extraction import VisionResponseError
from .grounding import build_grounder
from .ingest import IngestError, load_images
from .pipeline import analyze, write_analysis_outputs
from .review import ReviewError, finalize, load_review
from .vision import (
    OpenAICompatVisionClient, VisionAPIError, build_vision_client, clients_for_run, list_available_models,
)


def _summary(bom) -> str:
    observed = [c for c in bom.components if c.evidence_type.value == "observed"]
    unverified = [c for c in bom.components if c.evidence_type.value != "observed"]
    detection = "VLM + Grounding DINO/SAM 2" if bom.metadata.get("detection_mode") == "vlm+grounding" else "VLM/LLM only"
    lines = [
        f"Project: {bom.project_name}  (mode: {bom.metadata.get('mode', 'n/a')}, stage: {bom.metadata.get('stage', 'n/a')}, "
        f"detection: {detection})",
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
    client, reasoning_client, model = clients_for_run(
        build_vision_client(settings, mock=mock), settings, args.model
    )
    use_grounding = settings.grounding if args.grounding is None else args.grounding
    grounder = build_grounder(settings) if use_grounding else None  # fails early if libraries are missing
    images = load_images(args.images)
    result = analyze(
        images,
        client,
        project_name=args.project_name or Path(args.images[0]).stem,
        catalog=build_catalog_client(settings),
        max_retries=settings.max_retries,
        verify=settings.verify,
        mode="mock" if mock else "live",
        vision_model=model,
        reasoning_client=reasoning_client,
        grounder=grounder,
    )
    written = write_analysis_outputs(result, args.out)
    print(_summary(result.bom))
    print("\nWrote:")
    for path in written.values():
        print(f"  {path}")
    if args.infer:
        print("\nInferring the critical parts and open design choices, then looking the parts up in "
              "the shops (--no-infer skips this)...")
        text_client = reasoning_client or client
        try:
            inferred, review = best_guess(
                text_client, result.review, model=getattr(text_client, "_model", model),
                max_retries=settings.max_retries, web_search=settings.web_search,
            )
        except (VisionResponseError, VisionAPIError) as exc:
            print(f"warning: the AI best guess could not be produced ({exc}). The outputs above are "
                  f"unaffected; retry with: robot-bom infer {written['review.json']}", file=sys.stderr)
        else:
            design = inferred["inferred_components"]
            print(f"AI best guess (assumptions, not verified): {len(design['design_choices'])} design choices, "
                  f"{len(design['components'])} components")
            for name, document in inferred.items():
                print(f"  {write_json(Path(args.out) / 'inferred' / f'{name}.json', document)}")
            # the review file and draft exports now carry the guesses, marked as assumptions
            write_json(written["review.json"], review.model_dump(mode="json"))
            BOMExporter().export(review.bom, args.out)
            print(_guess_summary(review.bom, inferred["order_links"]))
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


def _guess_summary(bom, links: dict) -> str:
    assumed = [c for c in bom.components if c.assumed_fields]
    critical = [i.id for i in bom.unresolved_issues() if i.severity == "critical"]
    availability = links["availability"]
    lines = [f"Written into the parts list as assumptions ({len(assumed)} line(s), still 'needs review'):"]
    lines += [f"  - {c.id}: {c.name} x{c.required_quantity} {c.specs}" for c in assumed]
    lines.append("Open critical issues after the guess: " + (", ".join(critical) if critical else "none"))
    lines.append(
        f"Shop lookup: {availability['parts_with_products']} of {availability['parts_total']} parts have product "
        f"pages, {availability['in_stock_confirmed']} page(s) confirmed in stock ({availability['method']})"
        + (f"; {availability['error']}" if availability["error"] else "")
    )
    return "\n".join(lines)


def _cmd_infer(args: argparse.Namespace) -> int:
    settings = load_settings()
    review = load_review(args.review)
    bom = review.bom
    mock = args.mock or settings.mock or bom.metadata.get("mode") == "mock"
    vision, reasoning, model = clients_for_run(build_vision_client(settings, mock=mock), settings, args.model)
    client = reasoning or vision  # both queries are text-only
    result, review = best_guess(client, review, model=getattr(client, "_model", model),
                                max_retries=settings.max_retries, web_search=settings.web_search)
    design, links = result["inferred_components"], result["order_links"]
    print("MODEL INFERENCE - assumptions, not verified.")
    if design["summary"]:
        print(design["summary"])
    print(f"\nDesign choices ({len(design['design_choices'])}):")
    for choice in design["design_choices"]:
        print(f"  - {choice['issue_id']}: {choice['choice']}")
    print(f"\nComponents ({len(design['components'])}):")
    for row in links["components"]:
        print(f"  - {row['quantity']} x {row['name']} [{row['basis']}]  search: {row['search_query']}")
        for product in row["products"]:
            print(f"      {product['stock']:<10} {product['url']}")
    print("\n" + _guess_summary(review.bom, links))
    print("\nWrote:")
    for name, document in result.items():
        print(f"  {write_json(Path(args.out) / f'{name}.json', document)}")
    path = write_json(Path(args.out) / "review.json", review.model_dump(mode="json"))
    print(f"  {path}  (the review with the guesses written in; edit and finalize this one)")
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


def _cmd_models(args: argparse.Namespace) -> int:
    settings = load_settings()
    models = list_available_models(settings)
    usable = [m for m in models if m["usable"]]
    print(f"Models at {settings.base_url}: {len(usable)} of {len(models)} can read photos "
          f"(* = configured default, {settings.vision_model})")
    for m in models if args.all else usable:
        mark = "*" if m["id"] == settings.vision_model else " "
        notes = [] if m["usable"] else ["cannot read photos" if m["chat"] else "not a chat model"]
        if m["name"]:
            notes.append(f"= {m['name']}")
        if m["deprecated"]:
            notes.append("deprecated")
        print(f"  {mark} {m['id']:<40} {'; '.join(notes)}".rstrip())
    if not args.all and len(models) > len(usable):
        print(f"({len(models) - len(usable)} models that cannot read photos are hidden; --all shows them)")
    print("\nUse one with:  robot-bom analyze <photos> --model <id>   (or set MISTRAL_MODEL in .env)")
    return 0


def find_free_port(host: str, preferred: int, attempts: int = 20) -> int:
    """Return ``preferred`` if it can be bound, else the next free port after it."""
    import socket

    for port in range(preferred, preferred + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((host, port))
            except OSError:
                continue
            return port
    raise ConfigError(f"no free port found in {preferred}-{preferred + attempts - 1}")


def _cmd_serve(args: argparse.Namespace) -> int:
    import threading
    import webbrowser

    import uvicorn

    port = find_free_port(args.host, args.port)
    if port != args.port:
        print(f"Port {args.port} is in use; using {port} instead.")
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{port}"
    print(f"Robot BOM builder is running at {url}  (Ctrl+C to stop)")
    if args.open:
        threading.Timer(1.2, webbrowser.open, args=[url]).start()
    uvicorn.run("robot_bom.api:app", host=args.host, port=port, log_level="warning")
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
    p.add_argument("--model", help="model for this run (see `robot-bom models`); default: VISION_MODEL / MISTRAL_MODEL")
    p.add_argument(
        "--grounding", action=argparse.BooleanOptionalAction, default=None,
        help="also locate parts with local Grounding DINO + SAM 2; --no-grounding = VLM/LLM only "
             "(default: VLM/LLM only unless ROBOT_BOM_GROUNDING=1)",
    )
    p.add_argument(
        "--infer", action=argparse.BooleanOptionalAction, default=True,
        help="after the analysis, let the model settle every open issue and build shop search links "
             "into <out>/inferred (default: on; --no-infer skips the two extra queries)",
    )
    p.set_defaults(func=_cmd_analyze)

    p = sub.add_parser("finalize", help="apply an edited review.json and export the final BOM")
    p.add_argument("review", help="path to the edited review.json")
    p.add_argument("--out", default="output/final", help="output directory (default: output/final)")
    p.add_argument("--reviewer", help="reviewer name recorded in the audit trail")
    p.set_defaults(func=_cmd_finalize)

    p = sub.add_parser(
        "infer",
        help="let the model settle every open issue, list the components and build shop search links "
             "(assumptions; does not change the BOM)",
    )
    p.add_argument("review", help="path to review.json from `analyze` (your edits are taken into account)")
    p.add_argument("--out", default="output/inferred", help="output directory (default: output/inferred)")
    p.add_argument("--model", help="model for this step (see `robot-bom models`)")
    p.add_argument("--mock", action="store_true", help="canned responses, no API call")
    p.set_defaults(func=_cmd_infer)

    p = sub.add_parser("models", help="list the models your API key can use")
    p.add_argument("--all", action="store_true", help="also list models that cannot read photos")
    p.set_defaults(func=_cmd_models)

    p = sub.add_parser("check-api", help="verify the configured vision API key and model (no secrets printed)")
    p.set_defaults(func=_cmd_check_api)

    p = sub.add_parser("serve", help="run the web app (upload photos, review, finalize) and HTTP API")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000, help="preferred port; the next free one is used if busy")
    p.add_argument("--open", action="store_true", help="open the app in your browser")
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
