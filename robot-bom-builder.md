---
name: robot-bom-builder
description: Build an evidence-grounded image-to-robot bill-of-materials pipeline using the user's configured vision/LLM API.
---

# Build a Robot Image → Verified Bill of Materials App

You are a senior full-stack engineer and robotics systems engineer. **Implement working code in the current repository**. Do not merely outline the approach. Build a small but extensible application that takes one or more photographs of a robot (such as a DIY four-wheel rover), detects visible parts, reasons about assembly requirements, and generates an evidence-grounded bill of materials (BOM) with unresolved questions and candidate purchasable products.

## Operating instructions

1. Inspect the repository, existing stack, package manager, README, tests, and environment variables before editing anything. Reuse existing conventions. If it is empty, implement a Python 3.11+ project using `uv`, FastAPI, Pydantic v2, httpx, and a simple CLI. Avoid unnecessary frameworks.
2. Use **my existing API** for image understanding and reasoning. Discover how it is configured from `.env.example`, environment variable names, or existing client code. **Never print, log, or hardcode secrets.** If integration details are missing, implement an OpenAI-compatible vision API adapter configurable via `VISION_API_BASE_URL`, `VISION_API_KEY`, and `VISION_MODEL`; do not assume a key or live endpoint is available. Document any provider-specific adjustments needed. Use only APIs for which credentials have been supplied; do not silently switch to a different paid service.
3. Deliver code, tests, `.env.example`, setup instructions, and a sample run command. Implement a fully runnable **mock mode** for development without a real API key.
4. Prioritize a useful hackathon MVP: input images → evidence-linked component inventory → inference/compatibility checks → human review → export JSON/CSV/Markdown BOM. Product matching and image segmentation may be optional adapters; the core must work without them.
5. Do not require training a new model. Do not assume that a single photograph shows internal components.
6. If this document is installed as a skill and the user asks to analyze a specific image, use the app created here rather than guessing an exact SKU from appearance.

## Core truthfulness constraints (non-negotiable)

- Separate **OBSERVED** (visibly supported), **INFERRED** (mechanically/electrically plausible but not seen), and **UNKNOWN** (not determined). Never merge inferred quantities into observed quantities.
- A visible component can be recognized by **type** without its exact **make/model** being known. Do not invent SKU, voltage, torque, dimensions, capacity, price, shop, or purchase URL.
- Every observed claim must carry an image ID and short visual justification; prefer region bounding boxes when the model supports grounding. If no coordinates are available, set them to `null` rather than guessing.
- Distinguish `visible_quantity`, `required_quantity`, and `purchase_quantity`. The latter two must remain `null` if not established. `unknown` is not zero.
- Deduplicate identical parts viewed from multiple camera angles. Keep all supporting image references rather than counting the same wheel twice.
- Record uncertainty and request the *most informative missing view* (e.g., underside for motors). Use human verification for exact catalog matches.
- A compatibility rule produces a **warning or question**, not an automatically confirmed component.
- Never claim the final BOM is complete or purchasing-ready while unresolved critical components remain.

## Expected user experience

A user uploads a top-view photograph of a DIY rover. The app displays:

1. A component table (e.g., four visible rubber wheels, green frame, breadboard, relay modules, jumper wires, LEDs), each with evidence and confidence.
2. An `Unverified / likely hidden` table (e.g., motors, gearboxes, axles, microcontroller model, battery chemistry/voltage) **without treating those as confirmed items**.
3. Missing-view requests (e.g., underside and close-up of board labels).
4. A human-editable review interface or CLI review JSON where users can confirm, reject, modify quantities, and provide exact part numbers.
5. Final BOM exports and, if a product-search backend is configured, separate real catalog candidates with verified source URLs and compatibility warnings.

## Architecture

Implement the pipeline as discrete testable stages:

```text
Images (1..N)
   ↓
A. Image ingestion and preprocessing
   ↓
B. Vision API inventory extraction (one structured result per image)
   ↓
C. Cross-image entity reconciliation (deduplicate parts)
   ↓
D. Mechanical/electrical graph and requirements checks
   ↓
E. Optional grounded catalog search for exact products
   ↓
F. Human verification (confirm / edit / reject)
   ↓
G. JSON + CSV + Markdown BOM export and unresolved-issues report
```

Use an interface/adapter design for the API client:

- `VisionClient.analyze(images, system_prompt, response_schema)`
- `CatalogClient.search(query)` (optional; never fabricate results)
- `InventoryReconciler.merge(per_image_observations)`
- `RequirementsValidator.validate(inventory, connections)`
- `BOMExporter.export(project)`

Optional enhancements behind flags: Grounding DINO + SAM 2 for bounding boxes/masks, OCR/label crops where appropriate, user-assisted connected-component graph, image overlay, external catalog integrations. **Do not block MVP delivery on these.** Do not use generic object detectors to imply exact specifications.

## Strict data contracts

Use Pydantic models and JSON schema validation. At minimum:

```python
from enum import Enum
from pydantic import BaseModel, Field

class EvidenceType(str, Enum):
    OBSERVED = "observed"
    INFERRED = "inferred"
    UNKNOWN = "unknown"

class Evidence(BaseModel):
    image_id: str
    description: str
    bbox_xyxy_norm: tuple[float, float, float, float] | None = None  # 0..1, optional

class Component(BaseModel):
    id: str
    category: str
    name: str
    evidence_type: EvidenceType
    evidence: list[Evidence] = Field(default_factory=list)
    visible_quantity: int | None = None
    required_quantity: int | None = None
    purchase_quantity: int | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    manufacturer: str | None = None
    model: str | None = None
    sku: str | None = None
    specs: dict[str, str] = Field(default_factory=dict)
    status: str = "needs_review"  # needs_review / confirmed / rejected
    notes: list[str] = Field(default_factory=list)

class Connection(BaseModel):
    source_id: str
    target_id: str
    relation: str  # mechanically_attached / wired_to / drives / supports / unknown
    evidence_type: EvidenceType
    rationale: str

class CatalogCandidate(BaseModel):
    component_id: str
    vendor: str
    title: str
    sku: str | None = None
    price: float | None = None
    currency: str | None = None
    product_url: str
    evidence_notes: str
    compatible: bool | None = None

class ReviewIssue(BaseModel):
    severity: str  # critical / warning / info
    component_ids: list[str] = Field(default_factory=list)
    message: str
    next_action: str

class RobotBOM(BaseModel):
    project_name: str
    image_ids: list[str]
    components: list[Component]
    connections: list[Connection] = Field(default_factory=list)
    issues: list[ReviewIssue] = Field(default_factory=list)
    catalog_candidates: list[CatalogCandidate] = Field(default_factory=list)
    ready_to_purchase: bool = False
```

Also validate quantity nonnegativity, unique component IDs, in-range bounding boxes, real image references, and connections to existing component IDs. Document the difference between confidence (model estimate; **not calibrated probability** unless validated) and verification state.

## Vision prompting strategy

Use two passes rather than one unconstrained prompt:

### Pass 1 — observed-only extraction

System prompt:

> You are an evidence-focused robotics component annotator. List ONLY parts physically visible in supplied image(s). Include category, visual description, quantity visible, image reference and approximate location if supportable. Do not infer hidden parts. Do not guess manufacturer, SKU, electrical ratings, exact dimensions, or exact part numbers from appearance. Distinguish assemblies (e.g., a relay module containing two blue relay blocks) from their subcomponents to avoid double counting. Use `null` for unknowable fields. Return ONLY schema-valid JSON.

Apply temperature 0 or lowest supported setting and structured JSON mode where available. Implement bounded retries for malformed responses; log validation errors without secrets.

### Pass 2 — inference and completeness audit

System prompt:

> You are a robotics assembly and electrical safety reviewer. Given the observed inventory and evidence, propose *potential* missing mechanical/electrical components and connection requirements. Mark all unobserved items `inferred` or `unknown`, not `observed`. Identify ambiguities, compatibility constraints, and the next most useful photo or measurement. Never convert a plausible part into a confirmed part. Return ONLY schema-valid JSON.

Run deterministic consistency checks after the LLM pass. At least:

- Count checking and cross-view deduplication.
- Four wheels do **not** necessarily mean four motors; drivetrain architecture is unknown until seen.
- Relay boards are not interchangeable with motor drivers; require checking intended motor control method.
- Power source, operating voltage, motor current, driver current capacity, physical mounting, and connectors must be confirmed before purchase.
- A chassis may be a custom fabricated part; don't provide a fabricated vendor SKU.
- A complete-looking top view does not establish underside fasteners or couplers.

## Catalog matching (optional integration)

Implement a `CatalogClient` adapter to query the user's configured catalog/product API, if available. Store returned title, SKU, verified product URL, price, currency, supplier, and query timestamp. Do not create links by guessing URL patterns. Rank candidate matches using part category, verified markings, dimensional/electrical specs, and vendor metadata. Return top candidates *separately* from observed component truth; never auto-confirm the first search result.

If no catalog service exists, leave `catalog_candidates` empty and clearly report `Catalog lookup not configured`. The pipeline should still produce a complete **observed inventory** and a list of missing information.

## Human-in-the-loop review

Provide a CLI review option (minimum) where a user can edit a generated `review.json` and rerun `finalize`, e.g.:

```bash
uv run robot-bom analyze ./photos/top.jpg ./photos/underside.jpg --out ./output
uv run robot-bom finalize ./output/review.json --out ./output/final
```

If an existing web UI is present, integrate an upload form and review table there. If starting from scratch, a simple FastAPI endpoint for uploads/results is sufficient, with CLI as the primary interface.

`finalize` must respect user corrections and retain an audit trail. `ready_to_purchase` must be `false` if critical issues remain, unknown SKUs are required for purchasing, or unresolved compatibility checks are critical.

## Deliverables / output files

Provide the following, respecting the repo's existing layout:

- Application source with clear modules for API integration, extraction, reconciliation, validation, review and export.
- `.env.example` with the API environment variable names and **no real tokens**.
- `README.md` explaining API setup, usage, limitations and mock mode.
- A callable CLI and preferably a `POST /analyze` API route.
- `output/observations.json`, `output/review.json`, `output/bom.json`, `output/bom.csv`, `output/bom.md`, and `output/issues.md` from a sample/mock run (or documented equivalent).
- Unit tests for schema constraints, deduplication, unverified fields, compatibility warnings and finalization.

CSV suggested fields: `id,category,name,evidence_type,visible_quantity,required_quantity,purchase_quantity,manufacturer,model,sku,status,confidence,notes`.

Markdown BOM sections: `Confirmed/visible components`, `Inferred/hidden possibilities`, `Unknown critical details`, `Catalog candidates`, `Compatibility checks`, `Photos/measurements requested`, `Purchase readiness`.

## Example acceptance test: DIY four-wheel robot photo

Given a top-view photo showing four chunky tyres, a green chassis, a breadboard with lights, a wired electronic relay assembly and other electronics:

- Correctly recognise four visible wheels **without claiming four visible motors**.
- Identify breadboard, chassis, visible wires and relay module(s) as categories without forcing unverified brand/model names.
- Distinguish a relay board assembly from individual relay cubes; prevent double-counting.
- Mark drive motor count/type, battery voltage and controller identity `unknown` or `inferred` unless visibly supported.
- Recommend underside and readable PCB/label close-ups for verification.
- Export valid JSON, CSV and Markdown with uncertainty intact.
- If catalog search is unavailable, produce **no invented store links or prices**.

## Tests and evaluation

Write automated tests including:

1. API response fails schema → helpful validation error/retry, not corrupted BOM.
2. Same wheel visible in two images → counted once when matched; flag uncertain matching for manual review instead of silently merging.
3. Four-wheel input with no underside → unknown drivetrain, no invented motor count.
4. Part marked `observed` without image evidence → validation failure.
5. Unknown SKU → null, never a fabricated string.
6. No configured API key → mock mode works; normal mode fails clearly and safely.
7. Catalog unavailable → empty candidates; output still exports.
8. Incorrect motor-driver voltage/current pairing → unresolved critical compatibility issue.
9. Review corrections persist in final BOM; unresolved critical issue keeps `ready_to_purchase=false`.

If ground-truth labeled robots are later available, evaluate category precision/recall/F1, visible-count error, exact SKU precision, critical-missing-parts recall and fraction of hallucinated specifications. Do not claim numerical accuracy before measuring it.

## Final execution checklist

- [ ] Inspect repository and implement the smallest viable architecture.
- [ ] Verify the configured user vision API or provide compatible adapter + mock mode.
- [ ] Generate Pydantic schemas and strict two-pass prompts.
- [ ] Implement image ingestion, multi-view reconciliation, validators and exports.
- [ ] Add review/edit flow and explicit uncertainty reporting.
- [ ] Run tests and a sample/mock end-to-end command; fix failures.
- [ ] Summarize created files, run commands, what was tested, and what remains optional.

**Start implementing now.** Make reasonable defaults rather than asking broad planning questions. Ask the user only if the API cannot be integrated from repo configuration and a working configurable adapter is insufficient.
