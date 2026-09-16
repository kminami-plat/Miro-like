# Team Whiteboard

A self-hosted, Miro-style collaborative whiteboard for internal teams. Multiple people open the
same board and see each other's sticky notes, drawings, cursors and selections live.

Everything that Miro puts behind a paid plan is simply on:

- **Unlimited boards** for every member.
- **Private boards with invitations** (invite by user ID as editor or viewer; invitees accept or decline).
- **Advanced sharing**: team-wide boards (view or edit), revocable share links with view/edit
  permission and optional expiry, guest access without an account, ownership transfer.
- **Member management**: ID + password accounts (no e-mail needed), admin panel to add / deactivate /
  reset / promote members. Anyone can also create their own account from the sign-in page.

## Features

| Area | What you get |
| --- | --- |
| Canvas | Infinite board, pan (scroll, Space+drag, hand tool), zoom (Ctrl+scroll, pinch, buttons), fit to content, dot grid |
| Sticky notes | 11 colours, auto-fitting or fixed text size, bold, author label, keep-ratio resize |
| Text | Free text boxes with size, colour, bold, alignment; grow with content |
| Shapes | Rectangle, rounded, ellipse, diamond, triangle with fill, border and label |
| Frames | Titled regions to group/categorise notes; moving a frame moves its contents |
| Lines | Straight lines, arrows (one or both ends), dashed, three widths; freehand pen |
| Editing | Multi-select, rubber-band, resize handles, lock, z-order, duplicate, copy/paste, nudge, undo/redo, context menu |
| Realtime | WebSocket sync of every change, live cursors with names, remote selection outlines, presence avatars, permission changes pushed live |
| Sharing | Private / team visibility, invitations with roles, share links (view/edit, guests on/off, expiry), transfer ownership, leave board |
| Boards | Dashboard with search, starred boards, invitations inbox, duplicate, rename, export/import JSON, export PNG |
| History | Automatic version every 10 min of activity (last 40 kept) + manual saved versions; download or restore any version, restore is broadcast live |
| Backup | Admin full-backup JSON of every board; `scripts/backup_sqlite.py` for file-level copies; PostgreSQL option for managed hosting |
| Admin | Members table (role, status, reset password, delete with board hand-over), all-boards view, org name, full backup |

## Run it

Requirements: Python 3.11+ (no Node needed). `uv` is used if present, otherwise plain `venv`.
If the project folder is synced by iCloud Drive (macOS Desktop often is), keep the virtualenv outside
it with `VENV_DIR=~/.venvs/whiteboard ./run.sh`; a synced venv makes Python imports stall.

```bash
./run.sh            # http://localhost:8000
./run.sh 9000       # custom port
```

The **first account created becomes the administrator**. After that, colleagues click
**Register a new account** on the sign-in page and choose their own ID and password. Admins can
also add members directly under *Admin → Members*.

Data lives in a single SQLite file at `data/boards.db` (override with `BOARD_DB=/path/to.db`).
To use PostgreSQL instead (Neon, Supabase, Railway, RDS…) set `DATABASE_URL=postgres://…`; the
schema is created automatically. Guest sessions and version history are stored in the same database,
so nothing is lost on restart.

### Backups

- Admin → Settings → **Full backup** downloads every board, member list and item as one JSON file.
- `.venv/bin/python scripts/backup_sqlite.py backups 14` makes a consistent copy of the SQLite file
  (safe while running) and keeps the last 14. Put it in cron.
- Per-board versions: board menu → **Version history**. Any version can be downloaded as JSON and
  re-imported from the dashboard.

### Hosting

The app needs one long-running process (WebSockets), so serverless hosts such as Vercel are not a
fit. Ready-made configs: `Dockerfile`, `fly.toml` (Fly.io with a persistent volume, a few dollars a
month) and `render.yaml` (Render free tier + external Postgres). See `consult.txt` for a step-by-step
comparison and the operations checklist.

Environment variables: `PORT`, `BOARD_DB`, `DATABASE_URL`, `COOKIE_SECURE=1` (force Secure cookies),
`AUTO_SNAPSHOT_MINUTES` (default 10), `MAX_AUTO_SNAPSHOTS` (default 40).

### Deploying on the office network

Run behind any reverse proxy that forwards WebSockets (nginx, Caddy). Use HTTPS in production so
session cookies are not sent in the clear. Example Caddyfile:

```
board.example.local {
    reverse_proxy 127.0.0.1:8000
}
```

## Project layout

```
server/main.py   FastAPI app: REST API, WebSocket hub, static SPA
server/auth.py   scrypt password hashing, sessions, guest sessions
server/db.py     Schema + SQLite/PostgreSQL adapter
scripts/         backup_sqlite.py
Dockerfile, fly.toml, render.yaml   deployment
static/app.js    SPA shell: auth, dashboard, share dialog, admin panel
static/board.js  Canvas editor (tools, selection, undo, realtime)
static/style.css
tests/e2e.py     Playwright browser test (3 users collaborating)
```

## Access model

| Role | Can |
| --- | --- |
| Owner | Everything on the board, incl. sharing, members, links, delete, transfer |
| Editor | Add/edit/delete items, rename, invite others |
| Viewer | Look around, follow cursors, export |
| Guest (via link) | View or edit per the link's permission; no account; loses access when the link is revoked |
| Admin | Full access to all boards and member management |

Board visibility: **Private** (owner + invited members) or **Team** (every signed-in member,
with a board-wide view/edit default; individual invitations override it).

## Tests

```bash
uv pip install --python .venv/bin/python playwright   # once; uses your installed Google Chrome
./tests/run_e2e.sh
```

If your editor reports `Failed to run python -m pip list`, the virtualenv was created without pip.
Add it with `uv pip install --python .venv/bin/python pip`. It does not affect the tests.

The suite registers an admin, builds a board with every item type, invites a second user, checks
view-only enforcement and the live upgrade to editor, verifies realtime sync / cursors / presence,
opens the board as a link guest, revokes the link, checks team boards, and exercises the admin panel.

## Keyboard shortcuts

`V` select · `H` pan · `N` sticky · `T` text · `S` shape · `F` frame · `L` line · `A` arrow · `P` pen ·
double-click canvas for a new sticky · `Enter` edit · `Del` delete · `Ctrl+Z / Shift+Ctrl+Z` undo/redo ·
`Ctrl+C/V/D` copy/paste/duplicate · `[` / `]` z-order · arrows nudge · `Ctrl+0` reset zoom · `Shift+1` fit.
