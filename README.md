# BuildFromVision — Assembly Studio (MVP)

Turns structured assembly JSON (robot parts + assembly steps, produced by the other
BuildFromVision modules) into an illustrated, narrated assembly walkthrough — an
interactive LEGO / IKEA-style manual with a voice guiding each stage.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build + serve (API routes included):

```bash
npm run build
npm run preview
```

Other scripts: `npm run typecheck`, `npm run test:adapter` (JSON adapter unit tests).

## Features

- **Workbook mode** — manually navigate illustrated steps (prev/next), each stage shows
  a large illustration, verbatim written instructions, parts added / already installed,
  and audio controls.
- **Guided walkthrough mode** — press *Guided walkthrough*: narration plays per step and
  the app advances automatically only when the audio ends. Controls: play / pause /
  resume, previous, next, restart, exit, auto-advance toggle, step progress.
  If no audio can be produced at all, a timed (video-like) fallback advances steps.
- **Visuals** — reusable SVG schematic diagrams (chassis, DC motors, wheels, Arduino,
  battery, wires, screws; unknown part types get generic boxes). One canonical layout;
  per step, installed parts are grey, newly added parts are highlighted in the accent
  colour with pulsing dashed outlines, arrows and label callouts. A persistent banner
  marks the diagram as *schematic / illustrative, not an engineering drawing*.
- **Optional AI illustrations** — when `MISTRAL_API_KEY` + `MISTRAL_IMAGE_AGENT_ID`
  (or `MISTRAL_IMAGE_MODEL`) are set, each stage can generate a style-consistent
  technical illustration (light background, isometric, no embedded text); the SVG
  callouts are overlaid on top. Results are cached per session.
- **Audio** — Mistral Voxtral TTS (`voxtral-mini-tts-3-0`) via a server-side route
  `POST /api/tts` (the API key never reaches the browser). Narration for **all steps is
  generated automatically when the workbook loads** (never auto-played); each step has
  a play/pause player in the stage card and a mini player in the steps list, the
  narration text stays visible next to the illustration, and a ↻ Regenerate control
  recreates a step's audio. Session caching avoids repeat API calls; if the API is
  unavailable the app falls back to browser `speechSynthesis`, shows loading/error
  states, and the written instructions always remain visible.
- **JSON import** — *Import JSON* accepts a file or pasted JSON. The adapter
  (`src/lib/adapter.ts`) normalises alternate key names, fills missing narration from
  the written instruction, derives cumulative `installed_components`, renumbers steps
  and reports warnings — upstream instruction text is never modified.
- **Deep links** — `?step=3`, `?mode=guided&step=6`.

## Input schema

See `public/sample-robot.json` (downloadable from the sidebar). Minimal shape:

```json
{
  "robot_name": "Four-Wheel Robot Car",
  "description": "…",
  "parts": [{ "id": "chassis", "name": "Robot chassis", "quantity": 1 }],
  "steps": [
    {
      "id": "step-1", "number": 1, "title": "Prepare the chassis",
      "instruction": "Position the chassis on a flat surface.",
      "narration": "First, prepare the robot chassis.",
      "component_ids": ["chassis"],
      "installed_components": ["chassis"],
      "visual_prompt": "Show the chassis on its own."
    }
  ]
}
```

`narration`, `installed_components`, `visual_prompt` and `description` are optional;
`component_ids` may also be `components`/`parts`, parts may be `components`/`bom`, etc.

## Configuration (server-side only)

Copy `.env.example` to `.env`:

| Variable | Purpose |
|---|---|
| `MISTRAL_API_KEY` | Enables Voxtral TTS (`/api/tts`) and image generation (`/api/image`) |
| `MISTRAL_IMAGE_AGENT_ID` | Mistral agent id used for per-step illustrations (agents API) |
| `MISTRAL_IMAGE_MODEL` | Alternative: direct image model via `/v1/images/generations` |
| `MISTRAL_BASE_URL` | Optional API base override (default `https://api.mistral.ai/v1`) |

Without any key the app runs fully on SVG diagrams + browser speech.

## API routes (mounted on dev and preview servers)

- `GET /api/health` — which integrations are configured
- `POST /api/tts` — `{ "text": "…", "voice"?: "…" }` → audio bytes (`voxtral-mini-tts-3-0`), server-cached
- `POST /api/image` — `{ "prompt": "…" }` → `{ "url" }` or `{ "dataUrl" }`, server-cached

## Structure

```
src/
  types.ts                  canonical schema
  lib/adapter.ts            input normaliser (integration boundary)
  lib/narration.ts          TTS client + session cache + player (audio element / speechSynthesis)
  lib/imageGen.ts           image-generation client + prompt builder + cache
  data/mockRobot.ts         four-wheel robot car sample data
  hooks/useNarrationEngine.ts
  components/               Header, StageCard, Illustration, AudioControls, Sidebar,
                            WalkthroughOverlay, ImportDialog
  components/robot/         SVG diagram: layout.ts (canonical coordinates) + RobotDiagram.tsx
server/api.ts               Vite middleware for /api/* (keeps MISTRAL_API_KEY server-side)
vite.config.ts              mounts the API on dev + preview servers
```

Video export is intentionally out of scope for the MVP; the walkthrough is a
narrated slideshow structured so a video-generation step can be added later.

## `teardown` skill — technical illustrations & exploded views

Installed at `.vibe/skills/teardown/`, retrieved from
`github.com/jakubkrehel/skills` at commit `031c5bf` (the parent of `37744ed8`,
which removed the skill). All 30 files verified byte-identical (git blob SHA-1)
against that commit; nothing else from the repo was installed. The project
folder was added to `~/.vibe/trusted_folders.toml` so project skills load.

**Invoke it:** type `/teardown <request>` in the chat (e.g. `/teardown an exploded
view of the robot car`), or ask the agent to load the `teardown` skill by name.
A fresh session in this project loads it via the `skill` tool — verified.

Working area: `teardown-work/` (standalone `package.json` with
`jspdf` / `svg2pdf.js` / `@fontsource-variable/inter` — the app's own
dependencies are untouched):

- `drawing.json` + `model-robot.js` — two models: `dc-motor` (component test)
  and `robot-car` (exploded assembly whose part ids/names match the sample BOM).
- Commands (Windows wrappers patch Chrome discovery; skill files unmodified):
  - `teardown-work\run.cmd run-proof.cjs drawing.json proof --quick` — proof sheets + PNG previews
  - `teardown-work\run.cmd run-proof.cjs drawing.json proof-full` — full proof incl. occlusion check
  - `teardown-work\run.cmd tools\teardown\scripts\build-viewer.cjs drawing.json dist\index.html` — standalone interactive viewer (assembled/exploded, annotations, colors, SVG/PNG/PDF download)
  - `teardown-work\run.cmd run-check.cjs dist\index.html check` — headless-Chrome verification
  - `teardown-work\run.cmd export-svgs.cjs drawing.json svgs` — standalone SVGs
- Generated SVGs are copied to `public/illustrations/` with a `manifest.json`.
  When the loaded robot matches the manifest, the stage shows a
  **💥 Exploded view** toggle; each SVG part group carries `data-item="<BOM part
  id>"`, so the app highlights the current step's components in the accent
  colour (installed = ink, pending = faded). Deep link: `?view=exploded&step=2`.
- The skill's drawings are **illustrative concepts** — dimensions are invented
  and nothing is toleranced; the UI badges say so. Not manufacturing drawings.
