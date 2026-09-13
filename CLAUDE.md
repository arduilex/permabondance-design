# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Permabondance "design app": a small web tool for drawing garden/terrain plans (plants + zones over a satellite image) per client project. Node/Express + Postgres, served behind Traefik on a VPS at `design.pepinieres-permabondance.fr`. Everything user-facing (UI text, code comments, commit messages, README) is in **French** — keep it that way.

## Commands

There is no build step, no linter, and no test suite. The frontend is plain HTML/CSS/JS served as static files (no bundler, no framework). `TODO.md` tracks the current feature roadmap and its order — check it before starting a step.

```bash
# LOCAL test stack (no Traefik, no .env needed) → http://localhost:3000, login admin / admin
docker compose -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.local.yml logs -f design-app
docker compose -f docker-compose.local.yml down -v      # also wipes local DB + uploads
# backend/public and backend/src are bind-mounted: HTML edits show on reload,
# src/ edits need `docker compose -f docker-compose.local.yml restart design-app`.

# PRODUCTION stack (needs a .env — see .env.example; this is what the VPS runs)
docker compose up -d --build            # rebuild after any backend/ change
docker compose up -d                    # compose/.env change only
docker compose logs -f design-app

# Import an old standalone-app export (*.permab.json, image embedded as base64) as a new project.
# scripts/ is baked into the image, so mount it when the script is newer than the last build.
docker compose -f docker-compose.local.yml run --rm \
  -v "$PWD/backend/scripts:/app/scripts:ro" -v "$PWD/X.permab.json:/import/X.permab.json:ro" \
  design-app node scripts/import-permab.js /import/X.permab.json     # prints /p/<id>

# Generate the bcrypt hash for ADMIN_PASSWORD_HASH
docker compose run --rm design-app node scripts/hash-password.js 'password'
# or locally: cd backend && npm install && npm run hash -- 'password'

# Run the server without Docker (needs a reachable Postgres)
cd backend && npm install
DATABASE_URL=postgres://design:pw@localhost:5432/design \
ADMIN_PASSWORD_HASH='$2a$12$...' SESSION_SECRET=dev UPLOAD_DIR=./uploads NODE_ENV=development \
node src/server.js                      # listens on :3000
```

`NODE_ENV=development` makes the session cookie non-`Secure` so login works over plain HTTP locally. There is no `node_modules` checked in locally; the server normally only runs inside Docker.

## Git workflow — pushing to `main` deploys to production

- `dev` = work branch, `main` = production. Work on `dev`; merge `dev` → `main` only for a validated version.
- `auto-deploy/` runs a container on the VPS that polls `origin/main` every 60 s and does `git reset --hard` + `docker compose up -d --build`. **Any push to `main` is live within a minute.** Never commit `.env`; it and `traefik/letsencrypt/` are gitignored and untouched by deploys.
- Traefik is not redeployed automatically; changes under `traefik/` need a manual `docker compose up -d` in that folder on the VPS.

## Architecture

```
Traefik (:443, LE certs) ──► design-app (Express :3000) ──► design-db (Postgres 16, internal network only)
                                   │ serves backend/public/{index,editor}.html
                                   └ images on volume design-uploads (/data/uploads/<projectId>/plan_*.ext)
```

### Backend (`backend/src/`)

- `server.js` — the whole API + static serving in one file. `db.js` — pg pool + `init()`.
- **Schema lives in `db.js` and is applied at boot**: `CREATE TABLE IF NOT EXISTS projects` followed by `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for later additions. That is the migration mechanism — add new columns the same way, never assume a fresh DB.
- One table, `projects`: `id` (22-char random base64url token = **edit token**), `view_token` (read-only token), `name`, `plan_date`, `image_path`, `scale JSONB`, the element collections `plants`, `zones`, `ponds`, `ditches`, `paths`, `items`, `item_types` (all JSONB arrays), timestamps. Element structure is defined only by the editor JS; the server stores it opaquely (the `JSON_COLS` list in `server.js` is the only server-side knowledge of them). `db.js init()` also runs data migrations at boot (e.g. the plant `variete`/`libre` → `description` merge) — write them idempotent.
- **Auth model is intentional, don't "fix" it**: the admin JWT cookie (`pb_session`) only guards listing/creating/deleting projects (`/`, `GET/POST /api/projects`, `DELETE`). Reading, PATCHing and uploading for a project (`/api/projects/:id`, `/p/:id`, `/api/projects/:id/image`, `/api/projects/:id/assets`) are **public** — the unguessable id *is* the edit link. `/v/:token` + `GET /api/view/:token` serve the same project **read-only**: the response strips `id`, so a viewer can never derive the edit link. `app.param("id")` rejects anything that doesn't look like a token (ids are used as upload folder names).
- `PATCH /api/projects/:id` uses `COALESCE` per field, so omitted fields are left untouched; send `null`-free partial bodies (consequence: a JSON column can't be reset to `null` via PATCH).
- Item images go to `/uploads/<id>/items/` (raster only — no SVG, it would execute scripts on the app origin; 5 MB). Deleting a project `rm -rf`s its whole folder.
- Helmet runs with CSP disabled because the pages use inline scripts/styles. Upload limit 40 MB (multer), JSON body limit 4 MB, Traefik read timeout 600 s — these three are tuned together for large satellite images.

### Frontend (`backend/public/`)

- `index.html` — admin login + project list (inline CSS/JS). The editor, loaded at `/p/<id>`, is split into `editor.html` (markup + inline SVG `<symbol>` icons), `editor.css` (design tokens in `:root`) and `editor.js` (one IIFE, no modules; `$()`/`$$()` helpers).
- **Editor state** is one object: `state = { client, planDate, imageUrl, plants[], zones[], ponds[], ditches[], paths[], items[], itemTypes[], scale, viewToken }`, plus a single selection `sel = { kind, id }` with `kind ∈ plant | zone | pond | ditch | path | item` (`selPlant()` / `selShape()` / `selItem()` resolve it). `READONLY` (URL starts with `/v/`) disables saving, editing tools (only `select` + `ruler`), handles and the form sheet (`renderSheetRO`). Display prefs (panel/sheet collapsed, open + hidden categories) live in `localStorage["pb.editor"]`, not in the project.
  - All coordinates are stored as **percent of the image (0–100)**, not pixels, so they survive image replacement. Sizes (`plant.diam`, `item.size`, line `width`) are in *image* pixels — they scale with zoom, i.e. they are real-world sizes once calibrated. `clientToPct()` converts screen → %.
  - `scale = { mPerPx, p1, p2, meters }` comes from the 2-point calibration flow; `isCal()` gates every "real units" feature (sliders in metres, areas/lengths, scale bar, ruler units, dynamic `maxScale()`).
  - Two registries drive the generic code: `CATS` (panel categories → CSS `hide-<key>` class, `kinds` they contain) and `SHAPES` (zone/pond = closed polygon with fill; ditch/path = open polyline with `width`; each with `coll`, labels, defaults). Adding a shape kind = one `SHAPES` entry + a `polyTool()` + a `CATS` entry + a block in `renderElements`. Paths are drawn freehand (`TOOLS.path.drag`, Douglas-Peucker `simplify`), typed via `PATH_TYPES` presets. Items are markers (like plants) whose image comes from the per-project library `itemTypes` (`/api/projects/:id/assets`).
- **Autosave**: every mutation calls `scheduleSave()` (1.1 s debounce → PATCH). Only fields whose JSON changed since the last successful save are sent (`pendingDiff()` vs `lastSavedParts`; the server COALESCEs the rest). `saveNow()` bypasses the debounce for critical data (the scale). On `beforeunload`/`pagehide`/tab hidden, `flushSave()` sends the pending diff with `navigator.sendBeacon` to `POST /api/projects/:id/beacon` (same handler as PATCH); the leave-page prompt only appears if that beacon could not be queued. `render()` does *not* save — a mutation without an explicit `scheduleSave()` is lost. Don't add a separate save path.
- **Rendering is full re-render**: `render()` = `renderMarkers/Shapes/Labels/Elements/Sheet`, each rebuilding its DOM via `innerHTML`. During a drag, handlers mutate the DOM directly (`style.left`, `setShapePoints`) and only call `render()` + `scheduleSave()` on pointer-up. Form inputs update targeted pieces (never full `render()`, which would refill the field being typed in).
- **Labels** (`.lblbox`, plants + items) are laid out by `layoutLabels()`: overlapping ones are hidden (selected first, then biggest wins), recomputed when the zoom changes (`applyTransform`) and re-measured after `renderLabels`. Hover is geometric (`markerAt`), so it works even when markers aren't clickable.
- **Tools are exclusive** — the `TOOLS` registry (`select`, `plant`, `zone`, `pond`, `ditch`, `path`, `item`, `ruler`, `calib`) gives each tool a `shortcut`, `enter/exit`, `onClick/onMove/onKey` (or `drag:true` + `dragStart/Move/End` for the pencil, where Space+drag pans instead) and a `hint()` (content of the contextual tag at the top of the stage, rebuilt by `updateHint()`; supports `input`/`select`/`actions`). `setTool(name)` is the only way to switch; it stamps `#stage[data-tool]`, and CSS uses that to turn off `pointer-events` on markers/shapes whenever the tool isn't `select` — so a new drawing tool is non-clickable-through by default. `Escape` → select tool (or deselect), letter keys switch tools, `Delete`/`Backspace` deletes the selection.
- **No popups for destructive actions**: deletion is confirmed on the button itself (`armConfirm(btn, label, fn)` — first click arms it as "Confirmer ?", second click runs `fn`; Escape or a click elsewhere disarms; the `Delete` key arms the sheet's button). `index.html` uses the same pattern for project deletion. Don't reintroduce `confirm()`. Element numbers (`num`) still exist in the data for creation order but are never displayed.
- **SVG hit-testing gotcha**: open polylines get an invisible wide "hit" polyline sized with CSS `calc(14px * var(--inv))`. Do **not** use `vector-effect: non-scaling-stroke` on anything that must be clickable — Chrome then fails to hit-test it.
- **Layer stack inside `#world`** (z-index order): `#plan-img` → `#zoneLayer` (SVG polygons, z1) → `#calibLayer` (z2) → `.marker` divs (z3, z4 while dragging) → `#labelLayer` (HTML labels, z5) → `#editLayer` (selected-zone handles, z7). The three SVGs share the image's pixel viewBox (`sizeZoneLayer()`).
- **Screen-constant sizing under zoom**: `applyTransform()` sets CSS var `--inv = 1/scale` on `#world`; handles, labels and draft vertices apply `transform: scale(var(--inv))` so they keep a fixed on-screen size. Elements counter-scaled this way must **not** also use `vector-effect: non-scaling-stroke` (see commit 00b8d3d).
- **Pointer model**: a single `pointerdown/move/up` on `#viewport` handles pan vs. click (3 px moved-threshold); a click goes to `TOOLS[tool].onClick`, or in `select` mode to selection (marker → zone → empty = deselect). Draggable handles (`startMove`, `startVertexDrag`, `startMidpointDrag`, `startZoneMove`) call `stopPropagation()` and take pointer capture on the handle so the viewport doesn't pan.
- **Right panel** = "Éléments" (one collapsible `catBlock` per `CATS` entry with count, eye toggle, `+` shortcut(s) to its tool, filter box; plants grouped by containing zone via `zoneOfPlant`; the Items block also hosts the library) above "Fiche" (inspector for `sel`; `renderSheet` → `fillPlantForm` / `fillShapeForm` / `fillItemForm`, or `renderSheetRO` in read-only).
- **Testing**: no test suite in the repo. UI changes were verified with throwaway `playwright-core` scripts (Chrome via `channel: "chrome"`) against the local Docker stack; if you write one, capture the project JSON first and PATCH it back at the end so the local DB stays clean. Screen coordinates: the image sits at roughly x 340–790 / y 72–880 in a 1440×900 viewport at fit zoom, and the hint tag occupies the top ~60 px of the stage.
