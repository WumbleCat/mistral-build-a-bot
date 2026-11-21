# Robot BOM builder

Turn one or more photos of a robot (for example a DIY four-wheel rover) into an
**evidence-grounded, human-verified bill of materials** using the Mistral vision API.

The app is built around one rule: **it never states more than the photos and a human
reviewer support.**

- `observed` – visible in a photo, with the image ID and a visual justification.
- `inferred` – mechanically/electrically plausible, but not seen.
- `unknown` – not determined.

A part can be recognised by *type* ("relay module") without its make/model being known.
SKUs, voltages, prices, shops and URLs are never guessed: they stay `null` until a person
enters them in review or a configured catalog API returns them.

## Pipeline

```text
photos ─► A. ingest (validate, EXIF-rotate, downscale)
        ─► B. pass 1: observed-only extraction, one structured result per image
        ─► B. visibility re-check: each claim is re-examined against the photo;
              claims that are only implied (wheels → "motors") are demoted to inferred
        ─► (optional) Grounding DINO + SAM 2 locate the listed parts on the photo;
              switched off = VLM/LLM only, which is the default
        ─► C. cross-image reconciliation (same part in two photos is counted once)
        ─► B. pass 2: inference / completeness audit (proposals and questions only)
        ─► D. deterministic mechanical / electrical checks
        ─► E. optional catalog search
        ─► F. human review (review.json or the web UI)
        ─► G. bom.json / bom.csv / bom.md / issues.md
```

| Module | Role |
| --- | --- |
| `src/robot_bom/models.py` | Pydantic contracts and invariants |
| `src/robot_bom/ingest.py` | A – image ingestion |
| `src/robot_bom/vision.py` | `VisionClient` protocol, Mistral/OpenAI-compatible client, mock client |
| `src/robot_bom/prompts.py`, `extraction.py` | B – two-pass prompts, schema validation, bounded retries |
| `src/robot_bom/grounding.py` | optional – Grounding DINO + SAM 2 localisation (off = VLM/LLM only) |
| `src/robot_bom/reconcile.py` | C – `InventoryReconciler.merge` |
| `src/robot_bom/validation.py` | D – `RequirementsValidator.validate`, purchase-readiness rules |
| `src/robot_bom/catalog.py` | E – `CatalogClient.search` (optional) |
| `src/robot_bom/review.py` | F – review document, `finalize`, audit trail |
| `src/robot_bom/export.py` | G – `BOMExporter.export` |
| `src/robot_bom/pipeline.py`, `cli.py`, `api.py` | orchestration, CLI, FastAPI + web UI |

## Setup

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync --inexact      # --inexact keeps packages you installed by hand (torch, notebooks, ...)
cp .env.example .env      # then put your key in .env
```

`.env`:

```dotenv
MISTRAL_API_KEY=...                    # required for live runs
# MISTRAL_MODEL=mistral-large-latest   # optional; any vision-capable Mistral chat model
```

All settings are listed in [`.env.example`](.env.example).

**Model choice.** The default is `mistral-large-latest`. In a single live test on a
top-view photo of a DIY rover, `mistral-large-latest` labelled the view correctly and
stated that motors were not visible, while `mistral-medium-latest` mislabelled the view
as "underside" (which suppresses the underside-photo request) and, before the prompt
and re-check were tightened, listed four motors as visible. That is one photo, not a
benchmark – but it is why the larger model is the default. Each image costs two
vision calls (extraction + re-check) plus one text call per run; set `VISION_VERIFY=0`
to skip the re-check.

Check the configuration without printing the key:

```bash
uv run robot-bom check-api
```

`.env` is git-ignored. The key is never logged, printed, or written to any output file.

### Other providers

The client speaks the OpenAI-compatible `/chat/completions` format, so another provider
only needs environment variables: `VISION_API_BASE_URL`, `VISION_API_KEY`,
`VISION_MODEL`. Provider-specific notes:

- Images are sent as `{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}`.
- JSON mode is requested with `response_format: {"type": "json_object"}`. Set
  `VISION_JSON_MODE=none` for providers that reject it; replies are still schema-validated.
- `temperature` is 0 with `top_p` 1 (Mistral's large model rejects greedy sampling
  unless `top_p` is sent explicitly).
- `MISTRAL_API_KEY` / `MISTRAL_MODEL` are the fallbacks for `VISION_API_KEY` /
  `VISION_MODEL`.

## Usage

### CLI

```bash
# 1. analyse (several views are better: top, underside, close-ups of board labels)
uv run robot-bom analyze ./photos/top.jpg ./photos/underside.jpg --out ./output

# 2. review: edit ./output/review.json (see "Human review" below)

# 3. finalize
uv run robot-bom finalize ./output/review.json --out ./output/final --reviewer "your name"
```

`analyze` writes:

| File | Content |
| --- | --- |
| `observations.json` | raw pass 1 result per image and the pass 2 audit |
| `review.json` | the human-editable review document |
| `bom.json` / `bom.csv` / `bom.md` | the **draft** BOM (never purchasing-ready) |
| `issues.md` | open issues and requested photos/measurements |

`finalize` writes `bom.json`, `bom.csv`, `bom.md`, `issues.md` and `audit.json` (every
reviewer change, with old and new values).

### Mock mode (no API key)

```bash
uv run python scripts/make_sample_image.py            # synthetic placeholder drawing
uv run robot-bom analyze samples/rover_top_synthetic.png --mock --out output
```

Mock mode returns canned responses and labels every output as `MOCK DATA`. A file whose
name contains `underside` or `bottom` gets the canned underside view, which lets you try
cross-image deduplication offline. Mock mode is always explicit (`--mock` or
`ROBOT_BOM_MOCK=1`): a missing key produces a clear error, never a silent fallback.
A committed sample is in [`examples/mock-run/`](examples/mock-run/): the draft outputs,
a hand-edited `review.edited.json`, and the resulting `final/` exports with `audit.json`.

### Web app

```bash
python main.py                    # starts the server and opens the browser
uv run robot-bom serve --open     # same thing from the CLI (http://127.0.0.1:8000)
```

Running `main.py` (for example with PyCharm's Run button) is enough. If port 8000 is
busy the next free port is used and printed.

In the page you can drop, choose or paste one to eight photos, pick the detection mode,
and analyse. The result shows your photos with the located parts outlined, the visible
and unverified component tables (editable: review status, quantities, make / model /
SKU, specs), issues, the photos still needed, and a Finalize button that re-runs the
checks and offers the exports for download.

HTTP API behind the page:

- `POST /analyze` – multipart `images` (1–8 files), `project_name`, `mock`, `grounding`
- `POST /finalize` – JSON `{"review": {...}, "job_id": "..."}`
- `GET /jobs/{job_id}/overlays/{image_id}.jpg` – photo with SAM 2 masks (grounding runs only)
- `GET /health`, `GET /docs`

### Detection mode: VLM/LLM only, or with Grounding DINO + SAM 2

The app has two modes, switchable per run:

| Mode | What runs | Use it when |
| --- | --- | --- |
| **VLM / LLM only** (default) | Only the Mistral vision/language model. No local models, no torch. | You want the fastest run, or do not have the detection libraries installed. |
| **Mistral + Grounding DINO + SAM 2** | Mistral lists the visible parts; local Grounding DINO then locates them and SAM 2 segments them. | You want accurate outlines and masks on the photo. |

How to choose:

- **Web app:** the *Detection* dropdown next to the Analyze button. The choice is
  remembered in your browser. If torch / transformers are not installed, the DINO + SAM
  option is disabled and the page says so.
- **CLI:** `robot-bom analyze photo.jpg --grounding` or `--no-grounding`.
- **Default for both:** `ROBOT_BOM_GROUNDING=1` in `.env` makes DINO + SAM the default;
  unset (or `0`) means VLM/LLM only. The dropdown and the CLI flag override it.

The parts list, counts, checks and review flow are identical in both modes: the BOM
always comes from the vision/language model and your review. The local models only add
*where* each listed part is. A detector hit never adds a part, changes a count or
implies a specification; a different region count is raised as an info issue instead.
Detector and mask scores are reported as-is and are not calibrated probabilities. If
the local models fail, the run continues in VLM-only form with a warning.

DINO + SAM mode needs extra packages that are not installed by `uv sync`:

```bash
uv pip install torch torchvision "transformers==4.51.3" huggingface_hub truststore numpy
uv pip install git+https://github.com/facebookresearch/sam2.git
```

Weights (`IDEA-Research/grounding-dino-tiny`, `facebook/sam2.1-hiera-tiny`, about
850 MB) download on first use into `HF_HOME`; a `.hf-cache/` folder in the project is
used automatically when it exists. Without `sam2` the mode still runs with boxes only.
`GROUNDING_DINO_MODEL`, `GROUNDING_SAM_MODEL`, `GROUNDING_BOX_THRESHOLD` and
`GROUNDING_TEXT_THRESHOLD` override the defaults.

## Human review

`review.json` has two copies of the BOM: edit **`bom`**, leave **`baseline`** alone (it is
what your edits are diffed against for the audit trail). The file starts with the same
instructions:

- Set each component's `status` to `confirmed` or `rejected`.
- Correct `visible_quantity`; set `required_quantity` and `purchase_quantity`
  (`0` = nothing to buy, e.g. a custom chassis or a part you already own).
- Enter `manufacturer` / `model` / `sku` only when verified on the physical part.
  Leaving them `null` is correct; placeholder text such as `"unknown"` is stored as `null`.
- Electrical specs are strings in `specs`:

  | Component | Keys |
  | --- | --- |
  | power source | `voltage_v` |
  | motor | `voltage_v` (rated), `current_a` (stall/peak) |
  | motor driver / relay board | `max_voltage_v`, `max_current_a` (per channel), optional `min_voltage_v` |

- Close a warning or a model-raised issue with `"resolved": true` plus a `resolution_note`.
  Rule-based **critical** issues close only when the data they check is corrected.

### Three quantities

| Field | Meaning |
| --- | --- |
| `visible_quantity` | counted in the photos (only for `observed` parts) |
| `required_quantity` | how many the robot needs – `null` until established |
| `purchase_quantity` | how many to buy – `null` until established |

`null` means unknown, not zero. Exports show it as an empty CSV cell or the word `unknown`.

### Confidence vs. verification

`confidence` is the vision model's own estimate that it identified the part type
correctly. It is **not a calibrated probability** and has not been validated against
ground truth. `status` is the human verification state. A high confidence never
confirms a part; only a reviewer does.

### Purchase readiness

`ready_to_purchase` is recomputed on every `finalize` and is `true` only when all hold:

- no unresolved critical issue,
- every non-rejected component has been reviewed (`confirmed`),
- every confirmed component has a `purchase_quantity`,
- every component with `purchase_quantity > 0` has a verified `sku`.

Otherwise `readiness_blockers` lists why. Hand-editing the flag has no effect.

## Deterministic checks

Each rule raises a warning or a question; none of them confirms a part.

- Wheels visible but no motor count established → drivetrain unknown (four wheels do not
  mean four motors).
- Relay board without a motor driver → relays are not interchangeable with motor drivers.
- Power source / voltage unknown; controller unknown or unidentified.
- Supply voltage, motor current and driver capacity must be entered before purchase;
  once entered, over/under-voltage and undersized-driver pairings are flagged as critical.
- Chassis may be custom fabricated → no SKU assumed.
- No underside photo → motors, axles, couplers and fasteners are not established.
- Same part type across photos → counted once; uncertain matches are flagged, not merged.
- Assembly vs. subcomponent (relay module vs. relay blocks) → subcomponents are folded
  into the parent's notes.

## Catalog matching (optional)

Without a catalog the BOM reports `Catalog lookup not configured` and contains no store
links or prices. To enable the generic adapter set `CATALOG_API_URL` (and optionally
`CATALOG_API_KEY`); it calls `GET {CATALOG_API_URL}?q=<query>` and expects a list (or
`{"results": [...]}`) of objects with `title`, `product_url`, and optionally `vendor`,
`sku`, `price`, `currency`. URLs are stored exactly as returned, candidates are ranked
and listed separately from the inventory, and `compatible` stays `null` – nothing is
auto-confirmed. Adapt `HttpCatalogClient` in `src/robot_bom/catalog.py` for a specific
supplier API.

## Tests

```bash
uv run pytest
```

The tests never call the network; they use fake clients and `httpx.MockTransport`.

## Limitations

- A photo shows only what is visible. Hidden motors, gearboxes, batteries and
  fasteners are listed as `inferred`/`unknown`, never as confirmed parts.
- Part *type* recognition depends on the vision model and photo quality. No accuracy
  figures are claimed: nothing has been measured against labelled ground truth.
- The visibility re-check is the same model auditing its own claims. It removes some
  implied-but-unseen parts; it does not guarantee that every observed line is real, and
  it cannot add parts the first pass missed. Human review remains the verification step.
- The view label (top / underside / …) comes from the model. A wrong label can suppress
  or add a missing-view request.
- Bounding boxes are optional model output, kept only when well-formed, and `null`
  otherwise. In VLM-only mode they are approximate and not produced by a detection model.
- Cross-image matching compares category and part-type name; it cannot tell two
  identical-looking physical parts apart. Count mismatches are flagged for review.
- The electrical checks compare the numbers a reviewer enters; they are a sanity check,
  not a substitute for reading the datasheets.
- Grounding DINO + SAM 2 mode locates only parts the vision model already listed, by
  matching words in the detector's label to the part name; a part it cannot match keeps
  the vision model's rough box. The mode was run once on one photo with canned part
  names (wheels segmented correctly, some duplicate regions for chassis and
  breadboard); it has not been evaluated beyond that.
- Not implemented (optional in the spec): OCR label crops, per-part crop re-inspection,
  supplier-specific catalog integrations.

## Troubleshooting

- **`CERTIFICATE_VERIFY_FAILED` / `UnknownIssuer`** – antivirus or corporate TLS
  inspection. The app already trusts the operating-system certificate store. For `uv`
  itself, run `uv sync --inexact --system-certs`.
- **`uv sync` removed packages** – plain `uv sync` uninstalls everything that is not in
  `pyproject.toml` (for example a hand-installed torch). Use `uv sync --inexact`.
- **`No vision API key is configured`** – set `MISTRAL_API_KEY` in `.env`, or use `--mock`.
- **`did not return schema-valid JSON`** – the model's reply failed validation after the
  retry budget (`VISION_MAX_RETRIES`). No BOM is produced from a malformed reply; rerun,
  or try another `VISION_MODEL`.
