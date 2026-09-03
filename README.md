# A3 Shipping Pro — 3D Container Loading Tool

Interactive 3D web application for planning and visualizing cargo loads into
shipping containers, with a smart auto-load engine, project inventories,
side-by-side scenario comparison, and JWT-secured cloud persistence.

## Quick start (local dev)

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

**Back up** the database by copying the volume contents (e.g.
`docker compose cp app:/data ./backup`) or snapshotting the `a3-data` volume.

In production the server **fails fast** if `JWT_SECRET` is unset/default, or if
the database is empty and `ADMIN_PASSWORD` is not provided.

## Features

### 3D visualization & interaction
- Three.js scene: right-drag orbit, scroll zoom.
- Container types with real ISO internal dimensions and payload limits:
  20' Standard (47,900 lb), 40' Standard (58,860 lb), 40' High Cube (58,860 lb).
- Drag & drop that drops items to the floor by default; hold **Shift** to stack an item on top of another (stacking rules enforced).
- Rotate 90° (`R`, swaps L/W) or tip forward (`T`, swaps L/H).
- 3D item tags/labels (`L`), dark/light theme toggle.

### Cargo & projects
- **Projects** bundle an **item catalog** (all potential packages + quantity
  available) and multiple **scenarios** (candidate load plans).
- Custom items, grouped item library + saveable custom presets.
- CSV import to populate the catalog in bulk (with a downloadable sample template).
- Categories (general/fragile/heavy/hazardous/perishable) with color coding.
- Full UN/DOT hazmat classes with placard colors + segregation rules.
- Stacking rules and a staging area for removed/unplaced items.

### 🧠 Smart auto-load engine
- **Sequential multi-container best-fill:** packs one container as full as
  possible, "locks" it as its own scenario (`Auto — Container 1`, `2`, `3`…),
  then loads the remaining items into the next container, repeating until the
  inventory is placed (or a configurable **Max containers** cap is hit).
- **Best-fill selection:** for each container it tries several arrival orderings
  (heaviest-first, densest, largest-volume, largest-footprint, tallest) and
  keeps the packing that fills the box best — so it "picks through" the catalog
  to choose the ideal mix of dims/weights for the container in front of it.
- Default strategy: **Balanced (space + weight safety)** — bottom-heavy,
  densest first, stays under payload, recentres the load and evens out the
  center of gravity; honors stacking + hazmat rules.
- Also: **Maximize volume** and **Fewest containers** strategies.
- Items that fit no container (e.g. oversized) are sent to the staging area.

### Comparison
- Side-by-side stats table across all scenarios (weight, volume %, item counts,
  hazmat, overweight flags) with best-value highlighting.
- One shared, fully-interactive 3D viewport with a scenario switcher.

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
`Click` select · `Drag` move (auto-stack) · `Shift+Drag` floor · `R` rotate ·
`T` tip · `E` edit · `L` toggle tags · `Dbl-Click` details · `Delete` remove ·
`Right-Drag` camera · `Scroll` zoom.

## Project layout
```
server/   Express API, SQLite, auth, routes
public/   Static frontend (Three.js via CDN import-map)
```
