# BuildFromVision

Photograph any electronics -- a camera, a circuit board, a keyboard, a drone, a robot. Get back
what it is, every component it is built from, a distributor link and price for each, an
interactive exploded 3D view, ordered assembly instructions, and a generated video of the build.

**Stack:** React (Vite) · Supabase (Postgres + Auth + Storage + Realtime + Edge Functions) ·
Mistral vision · Three.js

---

## Start here if you're on the frontend

```bash
npm install
npm run dev
```

That's it. **No `.env`, no Supabase project and no Mistral key are needed to work on the UI.**

With no credentials the app boots in **demo mode**: two fully analysed samples (a USB-C power
bank and a line-following robot), a simulated analysis you can watch progress stage by stage,
and fake video jobs. Every loading, empty, error
and success state is reachable, so the whole interface can be built and styled before the backend
exists. A banner under the header makes clear nothing is real.

The demo backend lives in [src/lib/demo.js](src/lib/demo.js) and mirrors the surface of
[src/lib/api.js](src/lib/api.js) exactly, so components never know which one they got. State is
in memory: uploads vanish on reload and the sample comes back.

Once someone hands you Supabase credentials, drop them in `.env` and the same UI talks to the real
pipeline. `VITE_DEMO_MODE=true` forces demo mode back on for offline work.

---

## How it works

```
 photo ──► Supabase Storage ──► analyze-device (Edge Function)
                                      │
                                      ├─ Mistral pixtral: identify device, parts, geometry, steps
                                      └─ writes: projects, components, component_links,
                                                 assembly_steps
                                      │
 React UI ◄── Realtime ◄──────────────┘
    │
    ├─► exploded 3D view, built in the browser from the BOM (Three.js)
    └─► generate-video (Edge Fn) ─► Mistral: step ➜ shot description ─► video model
```

The React app never holds an API key. It talks only to Supabase; the two edge functions hold the
Mistral key and are the only things that call out.

---

## Backend setup

Only needed by whoever owns the backend half.

### 1. Create the Supabase project

Create one at [supabase.com/dashboard](https://supabase.com/dashboard), then put its URL and anon
key into `.env` (see `.env.example`).

### 2. Create the schema

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste `supabase/migrations/20261121000000_init.sql` into the dashboard SQL editor. That one file
creates the tables, the row level security policies, the private `device-images` bucket, and adds
the tables to the realtime publication.

### 3. Turn on guest sign-in

Dashboard → **Authentication → Sign In / Providers → Anonymous sign-ins: on**. This is what lets a
visitor upload a photo without an account. Email magic links work out of the box.

### 4. Deploy the edge functions

```bash
supabase secrets set MISTRAL_API_KEY=your_key_from_console.mistral.ai
supabase functions deploy analyze-device
supabase functions deploy generate-video
```

Secrets are set with `supabase secrets set`, never written into `.env` — the frontend must not be
able to see them.

---

## The exploded 3D view

The reference for this screen is a camera teardown plate: every part separated along one axis,
fine linework, callouts to the side.

It is **not** a generated mesh. The analyzer returns a rough primitive per component — shape, size
in millimetres, rotation, finish — which is a cheap, reliable thing for a vision model to produce.
[src/lib/geometry.js](src/lib/geometry.js) turns the bill of materials into a layout and
[src/components/ExplodedView.jsx](src/components/ExplodedView.jsx) renders it with Three.js.

- **Explode order follows build order.** A part's layer is the first assembly step that installs
  it, so the stack reads bottom-to-top in the order you'd actually build it.
- **Quantities expand into instances**, capped at six so a bag of screws stays legible.
- **Anything the model omits is synthesized** from the part's category, so the view renders even on
  a partial analysis.
- **Click a part** to isolate it; filter to a single assembly step; drag the explode slider.
- **Download `.glb`** to open the assembly in Blender or any 3D viewer.
- Light background by default to match the reference plates, with a dark toggle.

Three.js is lazy-loaded, so it costs nothing until the tab is opened.

---

## Where parts are bought

Asking a language model for product URLs produces dead links, so it doesn't. It returns a
`search_query` per part, and [src/lib/retailers.js](src/lib/retailers.js) maps the part's category
to distributors that actually stock it:

| Distributor | Used for |
| --- | --- |
| [LCSC](https://www.lcsc.com/) | electronics, wiring, power, sensors, controllers |
| [DigiKey](https://www.digikey.co.uk/) | as above, plus actuators |
| [Mouser](https://www.mouser.co.uk/) | as above |
| [RS](https://uk.rs-online.com/web/) | electronics plus mechanical: bearings, fasteners, extrusion |
| [SparkFun](https://www.sparkfun.com/) | sensors, controllers, kits |
| Pololu · RobotShop · Adafruit | robot-specific mechanical parts the distributors don't carry |

Exact product pages appear only when the model supplied one, and are styled differently from a
search link. Parts the model would not price show `—` rather than a guess, and are counted
separately under the table.

---

## Data model

| Table | Holds |
| --- | --- |
| `projects` | One uploaded photo and its analysis: device name, summary, difficulty, totals, status. |
| `components` | The bill of materials — name, category, quantity, unit price, specs, substitutes, `geometry`. |
| `component_links` | Exact product URLs the model was confident about. |
| `assembly_steps` | Ordered instructions with the parts and tools each step consumes. |
| `videos` | One row per generated clip: per step, or `kind='walkthrough'` for the full build. |

Row level security is on for every table. A row is readable only by the user who owns its project,
enforced through `public.owns_project()`. Storage objects live under `<user_id>/…` and the bucket
policies key off that first path segment, so one user can never read another's photo.

`projects.status` drives the whole UI: `queued → analyzing → ready`, or `failed` with the error
message on the row. The frontend subscribes to realtime changes and polls as a fallback.

---

## Video generation

Pluggable, because video models are the slowest and priciest link in the chain.

| `VIDEO_PROVIDER` | Behaviour |
| --- | --- |
| `mock` (default) | Mistral writes the shot description; the UI shows it as a storyboard card. No video vendor needed. |
| `replicate` | Text-to-video via Replicate. Needs `REPLICATE_API_TOKEN`. |
| `luma` | Luma Dream Machine. Needs `LUMA_API_KEY`. |

Jobs longer than the function's inline wait are stored as `generating` with a `provider_job_id`;
the UI polls `generate-video` with `action: "poll"` until the clip lands.

---

## Design notes

- **Photograph the device in the app.** [src/components/CameraCapture.jsx](src/components/CameraCapture.jsx)
  opens the webcam or phone camera with `getUserMedia`, draws the frame to a canvas and hands
  back a `File`, so a capture and a dropped file follow the exact same path. Front cameras are
  previewed mirrored and un-mirrored on capture. getUserMedia needs a secure context, so it works
  on localhost and over https but not on a plain-http LAN address — the UI says so rather than
  failing silently.
- **Photos are downscaled in the browser** to 1280px before upload
  ([src/lib/image.js](src/lib/image.js)). Phone photos are 4–12 MB; the vision model needs about a
  tenth of that, and it keeps the analysis call under the request size limit.
- **Assembly steps are renumbered 1..n server side**, so a model that repeats or skips a step
  number can't violate the unique constraint.
- **Guest-first auth.** Uploading signs you in anonymously; `linkEmail()` in `AuthContext` upgrades
  that session to a real account later without losing the builds.
- **Prices are estimates** of single-unit hobbyist retail, and labelled as such.

---

## Project layout

```
src/
  lib/           supabase client, data access, demo backend, geometry, retailers, image resize
  context/       AuthContext (anonymous + magic link + demo)
  hooks/         useSignedUrl for private storage objects
  components/    Layout, ImageDropzone, CameraCapture, BomTable, ExplodedView, AssemblySteps
  pages/         Home (upload), SignIn, Dashboard, Project (overview/parts/3D/assembly/video)
supabase/
  migrations/    schema, RLS, storage, realtime
  functions/
    _shared/     http helpers, request-scoped clients, Mistral wrapper
    analyze-device/   photo ➜ device, BOM, geometry, purchase links, assembly steps
    generate-video/  step ➜ shot description ➜ video model, with polling
.claude/skills/
  teardown/      technical-illustration skill, for producing exploded reference plates
```

## Scripts

```bash
npm run dev       # dev server (demo mode until .env is filled in)
npm run build     # production build
npm run preview   # serve the build
npm run lint      # oxlint
```

---

## Verifying parts before you order

The analysis is a model's reading of one photograph. It is a strong starting point, not a
datasheet. Before spending money, check the **"Inferred, not seen"** panel on the overview tab — it
lists what the model assumed rather than observed — and confirm voltages, torque figures and
mounting patterns against the product pages. The exploded view is schematic: it shows how the
device goes together, not dimensioned geometry to manufacture from.
