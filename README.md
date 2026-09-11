# A3 Shipping Pro — 3D Container Loading Tool

Interactive 3D web application for planning and visualizing cargo loads into
shipping containers, with a smart auto-load engine, a shared project inventory
consumed across multiple container loadings, a cross-container shipment
summary, and JWT-secured cloud persistence.

## Quick start (local dev)

Use Node.js 22 LTS (`nvm use`). No additional frontend build step is required.

```bash
npm install        # compiles better-sqlite3 (native)
npm start          # serves API + frontend on http://localhost:3000
```

In development (no `NODE_ENV=production`) a convenience admin is seeded on first
run: **`admin` / `123123`**. This fallback is disabled in production.

## Deploy with Docker (recommended)

The app ships as a single container. The SQLite database is kept in a named
volume so it survives rebuilds/redeploys.

```bash
cp .env.example .env
# Edit .env and set at minimum:
#   JWT_SECRET      -> openssl rand -hex 32
#   ADMIN_PASSWORD  -> strong password for the initial admin (first boot only)

docker compose up -d --build
curl http://127.0.0.1:3000/api/health     # -> {"status":"ok",...}
```

The container binds to `127.0.0.1:3000` on the host — put your TLS reverse
proxy (Nginx/Caddy/Traefik) in front of it. Configuration is via environment
variables (see `.env.example`):

| Var | Purpose |
| --- | --- |
| `JWT_SECRET` | **Required in production.** Token signing key. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seed the initial admin (first boot, empty DB). `ADMIN_PASSWORD` **required in production**. |
| `JWT_EXPIRES_IN` | Token lifetime (default `7d`). |
| `DB_PATH` | SQLite file path (default `/data/a3shipping.sqlite`, on the volume). |
| `PORT` / `HOST` | Listen address (default `3000` / `0.0.0.0`). |
| `CORS_ORIGIN` | Optional comma-separated cross-origin allow-list. |
| `TRUST_PROXY` | Unset for direct access. Use `1` only behind one trusted proxy that overwrites forwarded headers and is the only route to the app. |

**Back up** a live database using SQLite's online backup API, not by copying a
changing WAL database and its sidecar files independently:

```bash
# Local: choose a new absolute destination (existing files are never overwritten).
npm run backup -- /absolute/path/to/backups/a3-2026-09-11.sqlite

# Docker: create a consistent snapshot, then copy that completed file off-volume.
docker compose exec app npm run backup -- /data/backup-2026-09-11.sqlite
docker compose cp app:/data/backup-2026-09-11.sqlite ./backup-2026-09-11.sqlite
```

The command runs integrity and foreign-key checks on the snapshot. For restore,
stop the app, preserve the existing database **and** WAL/SHM files, install the
backup at `DB_PATH` with the runtime user's ownership, and restart with no stale
WAL/SHM files at that destination. Test restores in a separate deployment first.

In production the server **fails fast** if `JWT_SECRET` is unset/default, or if
the database is empty and `ADMIN_PASSWORD` is not provided.

## Features

### 3D visualization & interaction
- Three.js scene: Ctrl/Cmd + left-drag orbit, scroll zoom.
- Container types with real ISO internal dimensions and payload limits:
  20' Standard (47,900 lb), 40' Standard (58,860 lb), 40' High Cube (58,860 lb),
  40' Side-Load (8' high, 52,910 lb).
- Drag & drop that drops items to the floor by default; hold **Shift** to stack an item on top of another (stacking rules enforced).
- **Snap-to-grid (`G`):** drags and nudges snap to a 1" grid by default so items align precisely; toggle on/off from the toolbar or the `G` key (persisted).
- Rotate 90° (`R`, swaps L/W) or tip forward (`T`, swaps L/H).
- 3D item tags/labels (`L`), dark/light theme toggle.

### Cargo & projects
- **Projects** bundle an **item catalog** (all potential packages + quantity
  available) and multiple **container loadings**. The catalog is a single shared
  inventory pool: placing a unit into any container loading draws down its
  remaining quantity, so the same inventory can't be over-placed across the
  shipment (restricted loading across multiple containers).
- Custom items, grouped item library + saveable custom presets.
- CSV import to populate the catalog in bulk (with a downloadable sample template).
- Categories (general/fragile/heavy/hazardous/perishable) with color coding.
- Hazmat class labels and colors with a **simplified** incompatibility table.
  These checks are not comprehensive dangerous-goods compliance advice. Have
  qualified personnel verify segregation, load restraint and transport rules.
- Stacking rules and a staging area for removed/unplaced items.

### 🧠 Smart auto-load engine
- **Sequential multi-container best-fill:** packs one container as full as
  possible, "locks" it as its own container loading (`Auto — Container 1`, `2`,
  `3`…), then loads the remaining items into the next container, repeating until
  the inventory is placed (or a configurable **Max containers** cap is hit).
  Auto-load appends new container loadings and only packs inventory that hasn't
  already been placed.
- **Scored multi-simulation search:** rather than packing once and presenting
  the result, the engine simulates *many* layouts per container and proposes the
  highest-scoring one. It varies three things independently:
  1. **Arrival order** — five deterministic orderings (heaviest-first, densest,
     largest-volume, largest-footprint, tallest) plus randomized jitters around
     the strategy's natural ordering.
  2. **Rotation strategy** — every simulation picks an orientation bias
     (`upright` / `flat` / `tight`), so different runs genuinely make different
     rotate/tip choices instead of replaying one greedy preference.
  3. **Packing priority** — each search depth is run both letting balance win
     freely and requiring containers be packed nearly full, producing
     balance-oriented and consolidation-oriented plans.
- **Every layout is scored** on the metrics that matter, each normalized to
  0–1 and read from the same `scenarioStats()` model the Balance panel shows,
  so the score and the on-screen numbers can never disagree:

  | Component | Meaning |
  | --- | --- |
  | Front/back balance | 1.0 at a perfect 50/50 split along the length |
  | Left/right balance | 1.0 at a perfect 50/50 split across the width |
  | Floor/roof balance | asymmetric — floor-heavy is rewarded, top-heavy penalized |
  | Number of items | share of the offered units actually loaded |
  | Fill | volume + payload utilization (tiebreaker) |

  Weights are **per strategy** (`SCORE_WEIGHTS`): *Balanced* puts 70% on the
  three balance axes, while *Maximize volume* / *Fewest containers* lean on item
  count and fill. Any layout breaching the >60%-in-one-half guideline is
  heavily penalized, so the engine won't propose a load the UI would flag.
- **Whole-plan selection:** because a locally-perfect container can leave an
  awkward remainder that needs an extra box, several *complete* multi-container
  plans are built and compared as wholes — on cargo placed, mean layout score,
  and a penalty per additional container. The proposed plan is the one with the
  best aggregate, not a chain of locally-greedy choices.
- **Cancellable background search:** packing runs in a Web Worker, with a
  four-second search budget and a ten-second worker timeout. The seeded PRNG
  makes candidate ordering repeatable, but wall-clock cutoffs can change the
  winning result across machines. Truncated results are identified explicitly.
  The **Simulations** field controls search depth; projects are limited to 5,000
  available units and 100 container loadings (50 new containers per run).
- Default strategy: **Balanced (space + weight safety)** — bottom-heavy,
  densest first, stays under payload, recentres the load and evens out the
  center of gravity; honors stacking + hazmat rules.
- Also: **Maximize volume** and **Fewest containers** strategies.
- Items that fit no container (e.g. oversized) are sent to the staging area.
- The winning layout's score and per-axis balance are shown in the result toast
  and in the **Shipment summary** table.

### Shipment summary
- Cross-container roll-up: per-container stats (weight, volume %, item counts,
  hazmat, overweight flags) plus a **Shipment Total** column.
- Inventory reconciliation table (available vs. placed vs. remaining per item).
- One shared, fully-interactive 3D viewport with a container-loading switcher.

### Reporting & export
- Real-time statistics, step-by-step load plan, printable manifest,
  PNG export, and local JSON import/export of projects.

### Backend, auth & persistence
- Express REST API, `better-sqlite3` (WAL) with auto-migrations + seeded admin.
- JWT auth with three roles: **admin**, **editor**, **viewer**.
- Cloud projects with `public` / `restricted` visibility (`project_viewers`).
- `bcryptjs` password hashing.

## REST API
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/login` | returns `{ token, user }` |
| GET | `/api/me` | current user |
| GET/POST/PUT/DELETE | `/api/projects` | editor writes, viewer reads |
| GET/POST/PUT/DELETE | `/api/users` | admin only |
| GET | `/api/health` | health check |

## Keyboard shortcuts
`Click` select · `Drag` move to floor · `Shift+Drag` stack · `R` rotate ·
`T` tip · `E` edit · `L` toggle tags · `Dbl-Click` details · `Delete` remove ·
`Ctrl/Cmd+Left-Drag` camera · `Scroll` zoom.

## Validation, tests and upgrade notes

```bash
npm run check   # Syntax-check all application, script and test JavaScript
npm test        # Domain, geometry, persistence, worker, API, migration and backup tests
```

Tests use temporary or in-memory databases; they do not access the local app
database. CI runs these checks on Node 22. Geometry tests use renderer doubles,
so a real-browser/WebGL smoke test is still recommended before deployment.

- Existing databases receive additive `users.token_version` and
  `projects.revision` migrations. Back up before upgrading.
- Existing JWTs require a fresh login after this upgrade. Deleted users lose
  access immediately; roles are read from the database on each request;
  password resets invalidate previously issued tokens.
- `PUT /api/projects/:id` now requires the `revision` returned by GET/POST/PUT.
  Missing revisions return **428**; stale revisions return **409**. Export local
  changes before reloading after a conflict. Ordinary content saves do not
  rewrite visibility or viewers.
- Saves/imports validate dimensions, quantities, references, bounds, collisions,
  support, door entry, payload and the modeled hazmat rules. Invalid legacy
  projects are not rewritten on startup; they may need repair before saving or
  printing. JSON export remains available to preserve a recovery copy.
- Staging is now project-scoped and included in saves and JSON exports. Old
  versions did not persist staging, so previously lost staging cannot be recovered.
- Legacy `stackOn`/`stackUnder` fields remain readable for compatibility but do
  not enforce category-specific stacking. Current stacking rejects fragile bases
  and modeled hazmat incompatibilities and requires full footprint support.
- Stored load scores are historical generation results and are invalidated when
  the active loading is edited.

Remaining maintenance work includes project-list pagination, a fully read-only
viewer UI, centralized credential policy, comprehensive browser tests, and a
professionally validated hazardous-goods/load-restraint model.

## Project layout
```
server/   Express API, SQLite, auth, routes
public/   Static frontend (Three.js via CDN import-map)
```
