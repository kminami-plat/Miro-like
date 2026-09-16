"""Collaborative whiteboard server: REST API + WebSocket realtime + static SPA."""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
import uuid
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, db

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{2,32}$")

app = FastAPI(title="Whiteboard", docs_url=None, redoc_url=None)

AUTO_SNAPSHOT_INTERVAL = int(os.environ.get("AUTO_SNAPSHOT_MINUTES", "10")) * 60
MAX_AUTO_SNAPSHOTS = int(os.environ.get("MAX_AUTO_SNAPSHOTS", "40"))
LOGIN_ATTEMPTS: dict[str, list[float]] = {}  # ip -> timestamps (basic brute-force throttle)


@app.on_event("startup")
def _startup() -> None:
    db.init_db()
    print(f"[whiteboard] database: {db.backend_name()}")


@app.get("/api/health")
def health():
    with db.conn() as c:
        c.execute("SELECT 1").fetchone()
    return {"ok": True, "db": "postgresql" if db.IS_PG else "sqlite"}


def throttle_login(request: Request) -> None:
    ip = request.client.host if request.client else "?"
    t = time.time()
    hits = [x for x in LOGIN_ATTEMPTS.get(ip, []) if t - x < 300]
    if len(hits) >= 15:
        raise HTTPException(429, "Too many attempts. Try again in a few minutes.")
    hits.append(t)
    LOGIN_ATTEMPTS[ip] = hits


# ------------------------------------------------------------------ helpers

def uid() -> str:
    return uuid.uuid4().hex[:12]


def get_board(c, board_id: str) -> dict[str, Any]:
    r = c.execute("SELECT * FROM boards WHERE id=?", (board_id,)).fetchone()
    if not r:
        raise HTTPException(404, "Board not found")
    return dict(r)


PERM_RANK = {None: 0, "view": 1, "edit": 2, "owner": 3}


def board_permission(c, board: dict[str, Any], user: dict | None, guest: dict | None) -> Optional[str]:
    """Return 'owner' | 'edit' | 'view' | None."""
    perm: Optional[str] = None
    if user:
        if user["role"] == "admin" or board["owner_id"] == user["id"]:
            return "owner"
        m = c.execute(
            "SELECT role,status FROM board_members WHERE board_id=? AND user_id=?", (board["id"], user["id"])
        ).fetchone()
        if m and m["status"] == "active":
            perm = "owner" if m["role"] == "owner" else ("edit" if m["role"] == "editor" else "view")
        if board["visibility"] == "team":
            tp = board["team_permission"]
            if PERM_RANK[tp] > PERM_RANK[perm]:
                perm = tp
    if guest:
        gp = guest["boards"].get(board["id"])
        if PERM_RANK.get(gp, 0) > PERM_RANK[perm]:
            perm = gp
    return perm


def actor(request: Request) -> tuple[dict | None, dict | None]:
    return auth.current_user(request), auth.get_guest(request.cookies.get(auth.GUEST_COOKIE))


def require_board(request: Request, board_id: str, minimum: str) -> tuple[dict, str, dict | None, dict | None]:
    user, guest = actor(request)
    with db.conn() as c:
        board = get_board(c, board_id)
        perm = board_permission(c, board, user, guest)
    if PERM_RANK[perm] < PERM_RANK[minimum]:
        if perm is None:
            raise HTTPException(403 if (user or guest) else 401, "No access to this board")
        raise HTTPException(403, "Insufficient permission")
    return board, perm, user, guest


def actor_identity(user: dict | None, guest: dict | None) -> dict[str, Any]:
    if user:
        return {"id": user["id"], "display_name": user["display_name"], "color": user["color"], "username": user["username"], "guest": False}
    if guest:
        return {"id": guest["id"], "display_name": guest["display_name"], "color": guest["color"], "username": None, "guest": True}
    return {"id": None, "display_name": "Anonymous", "color": "#999", "username": None, "guest": True}


def set_cookie(request: Request, resp: Response, name: str, value: str, max_age: int) -> None:
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "") == "https" or os.environ.get("COOKIE_SECURE") == "1"
    resp.set_cookie(name, value, max_age=max_age, httponly=True, samesite="lax", secure=secure, path="/")


def board_summary(c, b: dict[str, Any], me: str | None = None) -> dict[str, Any]:
    owner = c.execute("SELECT username, display_name, color FROM users WHERE id=?", (b["owner_id"],)).fetchone()
    cnt = c.execute("SELECT COUNT(*) AS n FROM items WHERE board_id=?", (b["id"],)).fetchone()["n"]
    mem = c.execute("SELECT COUNT(*) AS n FROM board_members WHERE board_id=? AND status='active'", (b["id"],)).fetchone()["n"]
    fav = False
    if me:
        fav = bool(c.execute("SELECT 1 FROM board_favorites WHERE user_id=? AND board_id=?", (me, b["id"])).fetchone())
    return {
        **b,
        "owner": dict(owner) if owner else None,
        "item_count": cnt,
        "member_count": mem + 1,
        "favorite": fav,
        "online": len(HUB.rooms.get(b["id"], {})),
    }


# ------------------------------------------------------------------ auth API

class RegisterIn(BaseModel):
    username: str
    password: str = Field(min_length=4, max_length=200)
    display_name: str = Field(default="", max_length=60)


class LoginIn(BaseModel):
    username: str
    password: str


def app_settings() -> dict[str, Any]:
    with db.conn() as c:
        n = c.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    return {
        "setup_needed": n == 0,
        "org_name": db.get_setting("org_name", "Team Whiteboard"),
    }


@app.get("/api/auth/me")
def me(request: Request):
    user, guest = actor(request)
    return {"user": auth.public_user(user), "guest": actor_identity(None, guest) if guest else None, "settings": app_settings()}


@app.post("/api/auth/register")
def register(body: RegisterIn, request: Request, response: Response):
    throttle_login(request)
    if not USERNAME_RE.match(body.username):
        raise HTTPException(400, "ID must be 2-32 chars: letters, numbers, . _ -")
    s = app_settings()
    role = "admin" if s["setup_needed"] else "member"  # anyone may sign themselves up
    user_id = uid()
    with db.conn() as c:
        if c.execute("SELECT 1 FROM users WHERE LOWER(username)=LOWER(?)", (body.username,)).fetchone():
            raise HTTPException(409, "That ID is already taken")
        c.execute(
            "INSERT INTO users(id,username,display_name,password_hash,role,color,active,created_at) VALUES(?,?,?,?,?,?,1,?)",
            (user_id, body.username, body.display_name.strip() or body.username, auth.hash_password(body.password), role,
             auth.pick_color(user_id), db.now()),
        )
        u = dict(c.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())
    token = auth.create_session(user_id)
    set_cookie(request, response, auth.SESSION_COOKIE, token, auth.SESSION_TTL)
    return {"user": auth.public_user(u)}


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request, response: Response):
    throttle_login(request)
    with db.conn() as c:
        u = db.row_to_dict(c.execute("SELECT * FROM users WHERE LOWER(username)=LOWER(?)", (body.username.strip(),)).fetchone())
    if not u or not auth.verify_password(body.password, u["password_hash"]):
        raise HTTPException(401, "Wrong ID or password")
    if not u["active"]:
        raise HTTPException(403, "This account has been deactivated")
    token = auth.create_session(u["id"])
    set_cookie(request, response, auth.SESSION_COOKIE, token, auth.SESSION_TTL)
    return {"user": auth.public_user(u)}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    auth.destroy_session(request.cookies.get(auth.SESSION_COOKIE))
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    response.delete_cookie(auth.GUEST_COOKIE, path="/")
    return {"ok": True}


class ProfileIn(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=60)
    color: Optional[str] = Field(default=None, max_length=20)
    current_password: Optional[str] = None
    new_password: Optional[str] = Field(default=None, min_length=4, max_length=200)


@app.patch("/api/auth/me")
def update_me(body: ProfileIn, user=Depends(auth.require_user)):
    with db.conn() as c:
        if body.display_name is not None and body.display_name.strip():
            c.execute("UPDATE users SET display_name=? WHERE id=?", (body.display_name.strip(), user["id"]))
        if body.color:
            c.execute("UPDATE users SET color=? WHERE id=?", (body.color, user["id"]))
        if body.new_password:
            if not auth.verify_password(body.current_password or "", user["password_hash"]):
                raise HTTPException(400, "Current password is incorrect")
            c.execute("UPDATE users SET password_hash=? WHERE id=?", (auth.hash_password(body.new_password), user["id"]))
        u = dict(c.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone())
    return {"user": auth.public_user(u)}


@app.get("/api/users")
def search_users(q: str = "", user=Depends(auth.require_user)):
    with db.conn() as c:
        rows = c.execute(
            "SELECT id,username,display_name,color FROM users WHERE active=1 AND (LOWER(username) LIKE LOWER(?) OR LOWER(display_name) LIKE LOWER(?)) ORDER BY username LIMIT 20",
            (f"%{q}%", f"%{q}%"),
        ).fetchall()
    return {"users": [dict(r) for r in rows]}


# ------------------------------------------------------------------ admin API

class AdminUserIn(BaseModel):
    username: str
    password: str = Field(min_length=4, max_length=200)
    display_name: str = ""
    role: str = "member"


class AdminUserPatch(BaseModel):
    display_name: Optional[str] = None
    role: Optional[str] = None
    active: Optional[bool] = None
    password: Optional[str] = Field(default=None, min_length=4, max_length=200)


class SettingsIn(BaseModel):
    org_name: Optional[str] = Field(default=None, max_length=60)


@app.get("/api/admin/users")
def admin_users(admin=Depends(auth.require_admin)):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM users ORDER BY created_at").fetchall()
        out = []
        for r in rows:
            u = auth.public_user(dict(r))
            u["board_count"] = c.execute("SELECT COUNT(*) AS n FROM boards WHERE owner_id=?", (r["id"],)).fetchone()["n"]
            out.append(u)
    return {"users": out}


@app.post("/api/admin/users")
def admin_create_user(body: AdminUserIn, admin=Depends(auth.require_admin)):
    if not USERNAME_RE.match(body.username):
        raise HTTPException(400, "ID must be 2-32 chars: letters, numbers, . _ -")
    if body.role not in ("admin", "member"):
        raise HTTPException(400, "Bad role")
    user_id = uid()
    with db.conn() as c:
        if c.execute("SELECT 1 FROM users WHERE LOWER(username)=LOWER(?)", (body.username,)).fetchone():
            raise HTTPException(409, "That ID is already taken")
        c.execute(
            "INSERT INTO users(id,username,display_name,password_hash,role,color,active,created_at) VALUES(?,?,?,?,?,?,1,?)",
            (user_id, body.username, body.display_name.strip() or body.username, auth.hash_password(body.password), body.role,
             auth.pick_color(user_id), db.now()),
        )
        u = dict(c.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())
    return {"user": auth.public_user(u)}


@app.patch("/api/admin/users/{user_id}")
def admin_patch_user(user_id: str, body: AdminUserPatch, admin=Depends(auth.require_admin)):
    with db.conn() as c:
        u = db.row_to_dict(c.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())
        if not u:
            raise HTTPException(404, "User not found")
        if user_id == admin["id"] and (body.role == "member" or body.active is False):
            raise HTTPException(400, "You cannot demote or deactivate yourself")
        if body.display_name is not None and body.display_name.strip():
            c.execute("UPDATE users SET display_name=? WHERE id=?", (body.display_name.strip(), user_id))
        if body.role in ("admin", "member"):
            c.execute("UPDATE users SET role=? WHERE id=?", (body.role, user_id))
        if body.active is not None:
            c.execute("UPDATE users SET active=? WHERE id=?", (1 if body.active else 0, user_id))
            if not body.active:
                c.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        if body.password:
            c.execute("UPDATE users SET password_hash=? WHERE id=?", (auth.hash_password(body.password), user_id))
            c.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        u = dict(c.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())
    return {"user": auth.public_user(u)}


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: str, admin=Depends(auth.require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(400, "You cannot delete yourself")
    with db.conn() as c:
        if not c.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
            raise HTTPException(404, "User not found")
        # Boards owned by the deleted user are transferred to the admin so no work is lost.
        c.execute("UPDATE boards SET owner_id=? WHERE owner_id=?", (admin["id"], user_id))
        c.execute("DELETE FROM board_members WHERE user_id=?", (user_id,))
        c.execute("DELETE FROM board_favorites WHERE user_id=?", (user_id,))
        c.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        c.execute("DELETE FROM users WHERE id=?", (user_id,))
    return {"ok": True}


@app.get("/api/admin/settings")
def admin_settings(admin=Depends(auth.require_admin)):
    return app_settings()


@app.patch("/api/admin/settings")
def admin_patch_settings(body: SettingsIn, admin=Depends(auth.require_admin)):
    if body.org_name is not None and body.org_name.strip():
        db.set_setting("org_name", body.org_name.strip())
    return app_settings()


@app.get("/api/admin/boards")
def admin_boards(admin=Depends(auth.require_admin)):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM boards ORDER BY updated_at DESC").fetchall()
        return {"boards": [board_summary(c, dict(r), admin["id"]) for r in rows]}


# ------------------------------------------------------------------ boards API

class BoardIn(BaseModel):
    name: str = Field(default="Untitled board", max_length=120)
    visibility: str = "private"
    team_permission: str = "edit"
    description: str = Field(default="", max_length=500)


class BoardPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    visibility: Optional[str] = None
    team_permission: Optional[str] = None
    description: Optional[str] = Field(default=None, max_length=500)


@app.get("/api/boards")
def list_boards(user=Depends(auth.require_user)):
    with db.conn() as c:
        owned = [board_summary(c, dict(r), user["id"]) for r in
                 c.execute("SELECT * FROM boards WHERE owner_id=? ORDER BY updated_at DESC", (user["id"],))]
        shared = [board_summary(c, dict(r), user["id"]) | {"my_role": r["role"]} for r in c.execute(
            "SELECT b.*, m.role FROM boards b JOIN board_members m ON m.board_id=b.id "
            "WHERE m.user_id=? AND m.status='active' AND b.owner_id<>? ORDER BY b.updated_at DESC", (user["id"], user["id"]))]
        shared_ids = {b["id"] for b in shared}
        team = [board_summary(c, dict(r), user["id"]) for r in c.execute(
            "SELECT * FROM boards WHERE visibility='team' AND owner_id<>? ORDER BY updated_at DESC", (user["id"],))
                if r["id"] not in shared_ids]
        invitations = [dict(r) for r in c.execute(
            "SELECT b.id AS board_id, b.name, m.role, m.created_at, u.display_name AS inviter_name, u.username AS inviter_username "
            "FROM board_members m JOIN boards b ON b.id=m.board_id LEFT JOIN users u ON u.id=m.invited_by "
            "WHERE m.user_id=? AND m.status='pending' ORDER BY m.created_at DESC", (user["id"],))]
    return {"owned": owned, "shared": shared, "team": team, "invitations": invitations}


@app.post("/api/boards")
def create_board(body: BoardIn, user=Depends(auth.require_user)):
    if body.visibility not in ("private", "team") or body.team_permission not in ("view", "edit"):
        raise HTTPException(400, "Bad visibility")
    bid = uid()
    t = db.now()
    with db.conn() as c:
        c.execute(
            "INSERT INTO boards(id,name,owner_id,visibility,team_permission,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (bid, body.name.strip() or "Untitled board", user["id"], body.visibility, body.team_permission, body.description, t, t),
        )
        b = board_summary(c, get_board(c, bid), user["id"])
    return {"board": b}


@app.get("/api/boards/{board_id}")
def read_board(board_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "view")
    with db.conn() as c:
        items = [db.item_row(r) for r in c.execute("SELECT * FROM items WHERE board_id=? ORDER BY z, created_at", (board_id,))]
        members = list_members_rows(c, board)
        summary = board_summary(c, board, user["id"] if user else None)
    return {"board": summary, "permission": perm, "items": items, "members": members, "me": actor_identity(user, guest)}


@app.patch("/api/boards/{board_id}")
async def patch_board(board_id: str, body: BoardPatch, request: Request):
    board, perm, user, guest = require_board(request, board_id, "edit")
    if (body.visibility or body.team_permission) and perm != "owner":
        raise HTTPException(403, "Only the owner can change sharing")
    with db.conn() as c:
        if body.name is not None and body.name.strip():
            c.execute("UPDATE boards SET name=? WHERE id=?", (body.name.strip(), board_id))
        if body.visibility in ("private", "team"):
            c.execute("UPDATE boards SET visibility=? WHERE id=?", (body.visibility, board_id))
        if body.team_permission in ("view", "edit"):
            c.execute("UPDATE boards SET team_permission=? WHERE id=?", (body.team_permission, board_id))
        if body.description is not None:
            c.execute("UPDATE boards SET description=? WHERE id=?", (body.description, board_id))
        c.execute("UPDATE boards SET updated_at=? WHERE id=?", (db.now(), board_id))
        b = board_summary(c, get_board(c, board_id), user["id"] if user else None)
    await HUB.broadcast(board_id, {"t": "board", "board": b})
    return {"board": b}


@app.delete("/api/boards/{board_id}")
async def delete_board(board_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "owner")
    with db.conn() as c:
        for tbl in ("items", "board_members", "share_links", "board_favorites", "board_snapshots"):
            c.execute(f"DELETE FROM {tbl} WHERE board_id=?", (board_id,))
        c.execute("DELETE FROM boards WHERE id=?", (board_id,))
    await HUB.broadcast(board_id, {"t": "deleted"})
    return {"ok": True}


@app.post("/api/boards/{board_id}/duplicate")
def duplicate_board(board_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "view")
    if not user:
        raise HTTPException(401, "Sign in to duplicate")
    nid = uid()
    t = db.now()
    with db.conn() as c:
        c.execute(
            "INSERT INTO boards(id,name,owner_id,visibility,team_permission,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (nid, board["name"] + " (copy)", user["id"], "private", "edit", board["description"], t, t),
        )
        for r in c.execute("SELECT * FROM items WHERE board_id=?", (board_id,)).fetchall():
            d = dict(r)
            c.execute(
                "INSERT INTO items(id,board_id,type,x,y,w,h,rotation,z,props,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (uid(), nid, d["type"], d["x"], d["y"], d["w"], d["h"], d["rotation"], d["z"], d["props"], user["id"], user["id"], t, t),
            )
        b = board_summary(c, get_board(c, nid), user["id"])
    return {"board": b}


@app.post("/api/boards/{board_id}/favorite")
def toggle_favorite(board_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "view")
    if not user:
        raise HTTPException(401, "Sign in")
    with db.conn() as c:
        if c.execute("SELECT 1 FROM board_favorites WHERE user_id=? AND board_id=?", (user["id"], board_id)).fetchone():
            c.execute("DELETE FROM board_favorites WHERE user_id=? AND board_id=?", (user["id"], board_id))
            return {"favorite": False}
        c.execute("INSERT INTO board_favorites(user_id,board_id) VALUES(?,?)", (user["id"], board_id))
        return {"favorite": True}


@app.get("/api/boards/{board_id}/export")
def export_board(board_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "view")
    with db.conn() as c:
        items = [db.item_row(r) for r in c.execute("SELECT * FROM items WHERE board_id=?", (board_id,))]
    payload = {"format": "whiteboard/v1", "name": board["name"], "description": board["description"], "items": items}
    fname = re.sub(r"[^A-Za-z0-9_-]+", "_", board["name"])[:40] or "board"
    return JSONResponse(payload, headers={"Content-Disposition": f'attachment; filename="{fname}.json"'})


class ImportIn(BaseModel):
    name: Optional[str] = None
    items: list[dict[str, Any]] = []
    description: str = ""


@app.post("/api/boards/import")
def import_board(body: ImportIn, user=Depends(auth.require_user)):
    nid = uid()
    t = db.now()
    with db.conn() as c:
        c.execute(
            "INSERT INTO boards(id,name,owner_id,visibility,team_permission,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (nid, (body.name or "Imported board")[:120], user["id"], "private", "edit", body.description[:500], t, t),
        )
        for i, it in enumerate(body.items[:5000]):
            c.execute(
                "INSERT INTO items(id,board_id,type,x,y,w,h,rotation,z,props,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (uid(), nid, str(it.get("type", "sticky"))[:20], float(it.get("x", 0)), float(it.get("y", 0)), float(it.get("w", 200)),
                 float(it.get("h", 200)), float(it.get("rotation", 0)), int(it.get("z", i)), json.dumps(it.get("props", {})),
                 user["id"], user["id"], t, t),
            )
        b = board_summary(c, get_board(c, nid), user["id"])
    return {"board": b}


# ------------------------------------------------------------------ members & invitations

def list_members_rows(c, board: dict[str, Any]) -> list[dict[str, Any]]:
    owner = c.execute("SELECT id,username,display_name,color FROM users WHERE id=?", (board["owner_id"],)).fetchone()
    out = []
    if owner:
        out.append(dict(owner) | {"role": "owner", "status": "active"})
    rows = c.execute(
        "SELECT u.id,u.username,u.display_name,u.color,m.role,m.status,m.created_at FROM board_members m JOIN users u ON u.id=m.user_id "
        "WHERE m.board_id=? AND u.id<>? ORDER BY m.status DESC, m.created_at", (board["id"], board["owner_id"])).fetchall()
    out.extend(dict(r) for r in rows)
    return out


class InviteIn(BaseModel):
    username: str
    role: str = "editor"


class MemberPatch(BaseModel):
    role: str


@app.get("/api/boards/{board_id}/members")
def list_members(board_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "view")
    with db.conn() as c:
        return {"members": list_members_rows(c, board)}


@app.post("/api/boards/{board_id}/invite")
async def invite_member(board_id: str, body: InviteIn, request: Request):
    board, perm, user, guest = require_board(request, board_id, "edit")
    if not user:
        raise HTTPException(401, "Guests cannot invite")
    if body.role not in ("editor", "viewer"):
        raise HTTPException(400, "Role must be editor or viewer")
    with db.conn() as c:
        target = c.execute("SELECT * FROM users WHERE LOWER(username)=LOWER(?) AND active=1", (body.username.strip(),)).fetchone()
        if not target:
            raise HTTPException(404, "No user with that ID")
        if target["id"] == board["owner_id"]:
            raise HTTPException(400, "That user owns this board")
        existing = c.execute("SELECT * FROM board_members WHERE board_id=? AND user_id=?", (board_id, target["id"])).fetchone()
        if existing and existing["status"] == "active":
            raise HTTPException(409, "Already a member")
        c.execute(
            "INSERT INTO board_members(board_id,user_id,role,status,invited_by,created_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(board_id,user_id) DO UPDATE SET role=excluded.role, status='pending', invited_by=excluded.invited_by, created_at=excluded.created_at",
            (board_id, target["id"], body.role, "pending", user["id"], db.now()),
        )
        members = list_members_rows(c, board)
    await HUB.broadcast(board_id, {"t": "members", "members": members})
    return {"members": members}


@app.patch("/api/boards/{board_id}/members/{member_id}")
async def patch_member(board_id: str, member_id: str, body: MemberPatch, request: Request):
    board, perm, user, guest = require_board(request, board_id, "owner")
    if body.role not in ("editor", "viewer"):
        raise HTTPException(400, "Role must be editor or viewer")
    with db.conn() as c:
        c.execute("UPDATE board_members SET role=? WHERE board_id=? AND user_id=?", (body.role, board_id, member_id))
        members = list_members_rows(c, board)
    await HUB.broadcast(board_id, {"t": "members", "members": members})
    await HUB.refresh_permissions(board_id)
    return {"members": members}


@app.delete("/api/boards/{board_id}/members/{member_id}")
async def remove_member(board_id: str, member_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "owner")
    with db.conn() as c:
        c.execute("DELETE FROM board_members WHERE board_id=? AND user_id=?", (board_id, member_id))
        members = list_members_rows(c, board)
    await HUB.broadcast(board_id, {"t": "members", "members": members})
    await HUB.refresh_permissions(board_id)
    return {"members": members}


@app.post("/api/boards/{board_id}/leave")
async def leave_board(board_id: str, user=Depends(auth.require_user)):
    with db.conn() as c:
        board = get_board(c, board_id)
        if board["owner_id"] == user["id"]:
            raise HTTPException(400, "Owner cannot leave; transfer ownership or delete the board")
        c.execute("DELETE FROM board_members WHERE board_id=? AND user_id=?", (board_id, user["id"]))
        members = list_members_rows(c, board)
    await HUB.broadcast(board_id, {"t": "members", "members": members})
    return {"ok": True}


class TransferIn(BaseModel):
    user_id: str


@app.post("/api/boards/{board_id}/transfer")
async def transfer_board(board_id: str, body: TransferIn, request: Request):
    board, perm, user, guest = require_board(request, board_id, "owner")
    with db.conn() as c:
        target = c.execute("SELECT * FROM users WHERE id=? AND active=1", (body.user_id,)).fetchone()
        if not target:
            raise HTTPException(404, "User not found")
        old_owner = board["owner_id"]
        c.execute("UPDATE boards SET owner_id=?, updated_at=? WHERE id=?", (target["id"], db.now(), board_id))
        c.execute("DELETE FROM board_members WHERE board_id=? AND user_id=?", (board_id, target["id"]))
        if old_owner != target["id"]:
            c.execute(
                "INSERT INTO board_members(board_id,user_id,role,status,invited_by,created_at) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(board_id,user_id) DO UPDATE SET role='editor', status='active'",
                (board_id, old_owner, "editor", "active", target["id"], db.now()),
            )
        board = get_board(c, board_id)
        members = list_members_rows(c, board)
        b = board_summary(c, board, user["id"] if user else None)
    await HUB.broadcast(board_id, {"t": "members", "members": members})
    await HUB.broadcast(board_id, {"t": "board", "board": b})
    await HUB.refresh_permissions(board_id)
    return {"board": b, "members": members}


@app.post("/api/invitations/{board_id}/accept")
def accept_invitation(board_id: str, user=Depends(auth.require_user)):
    with db.conn() as c:
        r = c.execute("SELECT * FROM board_members WHERE board_id=? AND user_id=? AND status='pending'", (board_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "No pending invitation")
        c.execute("UPDATE board_members SET status='active' WHERE board_id=? AND user_id=?", (board_id, user["id"]))
    return {"ok": True, "board_id": board_id}


@app.post("/api/invitations/{board_id}/decline")
def decline_invitation(board_id: str, user=Depends(auth.require_user)):
    with db.conn() as c:
        c.execute("DELETE FROM board_members WHERE board_id=? AND user_id=? AND status='pending'", (board_id, user["id"]))
    return {"ok": True}


# ------------------------------------------------------------------ share links

class LinkIn(BaseModel):
    permission: str = "view"
    allow_guests: bool = True
    label: str = Field(default="", max_length=60)
    expires_days: Optional[int] = None


def link_row(r) -> dict[str, Any]:
    d = dict(r)
    d["allow_guests"] = bool(d["allow_guests"])
    d["expired"] = bool(d["expires_at"] and d["expires_at"] < time.time())
    return d


@app.get("/api/boards/{board_id}/links")
def list_links(board_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "edit")
    with db.conn() as c:
        rows = c.execute("SELECT * FROM share_links WHERE board_id=? ORDER BY created_at", (board_id,)).fetchall()
    return {"links": [link_row(r) for r in rows]}


@app.post("/api/boards/{board_id}/links")
def create_link(board_id: str, body: LinkIn, request: Request):
    board, perm, user, guest = require_board(request, board_id, "owner")
    if body.permission not in ("view", "edit"):
        raise HTTPException(400, "Bad permission")
    token = secrets.token_urlsafe(18)
    exp = db.now() + body.expires_days * 86400 if body.expires_days else None
    with db.conn() as c:
        c.execute(
            "INSERT INTO share_links(token,board_id,permission,allow_guests,label,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
            (token, board_id, body.permission, 1 if body.allow_guests else 0, body.label, user["id"], db.now(), exp),
        )
        rows = c.execute("SELECT * FROM share_links WHERE board_id=? ORDER BY created_at", (board_id,)).fetchall()
    return {"links": [link_row(r) for r in rows]}


@app.delete("/api/boards/{board_id}/links/{token}")
async def delete_link(board_id: str, token: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "owner")
    with db.conn() as c:
        c.execute("DELETE FROM share_links WHERE board_id=? AND token=?", (board_id, token))
        rows = c.execute("SELECT * FROM share_links WHERE board_id=? ORDER BY created_at", (board_id,)).fetchall()
    auth.revoke_guest_access_via_link(board_id, token)  # guests admitted through this link lose access
    await HUB.refresh_permissions(board_id)
    return {"links": [link_row(r) for r in rows]}


@app.get("/api/share/{token}")
def share_info(token: str, request: Request):
    user, guest = actor(request)
    with db.conn() as c:
        r = c.execute("SELECT * FROM share_links WHERE token=?", (token,)).fetchone()
        if not r or (r["expires_at"] and r["expires_at"] < time.time()):
            raise HTTPException(404, "This link is invalid or has expired")
        board = get_board(c, r["board_id"])
        owner = c.execute("SELECT display_name FROM users WHERE id=?", (board["owner_id"],)).fetchone()
    return {
        "board_id": board["id"], "board_name": board["name"], "owner_name": owner["display_name"] if owner else "",
        "permission": r["permission"], "allow_guests": bool(r["allow_guests"]),
        "signed_in": bool(user), "guest": actor_identity(None, guest) if guest else None,
    }


class JoinIn(BaseModel):
    guest_name: Optional[str] = Field(default=None, max_length=40)


@app.post("/api/share/{token}/join")
def share_join(token: str, body: JoinIn, request: Request, response: Response):
    user, guest = actor(request)
    with db.conn() as c:
        r = c.execute("SELECT * FROM share_links WHERE token=?", (token,)).fetchone()
        if not r or (r["expires_at"] and r["expires_at"] < time.time()):
            raise HTTPException(404, "This link is invalid or has expired")
        board = get_board(c, r["board_id"])
        role = "editor" if r["permission"] == "edit" else "viewer"
        if user:
            if user["id"] != board["owner_id"]:
                existing = c.execute("SELECT * FROM board_members WHERE board_id=? AND user_id=?", (board["id"], user["id"])).fetchone()
                if not existing or existing["status"] != "active" or (existing["role"] == "viewer" and role == "editor"):
                    c.execute(
                        "INSERT INTO board_members(board_id,user_id,role,status,invited_by,created_at) VALUES(?,?,?,?,?,?) "
                        "ON CONFLICT(board_id,user_id) DO UPDATE SET role=excluded.role, status='active'",
                        (board["id"], user["id"], role, "active", r["created_by"], db.now()),
                    )
            return {"board_id": board["id"]}
        if not r["allow_guests"]:
            raise HTTPException(401, "Sign in to open this board")
        if not guest:
            gtoken, guest = auth.create_guest((body.guest_name or "Guest").strip())
            set_cookie(request, response, auth.GUEST_COOKIE, gtoken, auth.GUEST_TTL)
        elif body.guest_name:
            guest["display_name"] = body.guest_name.strip()[:40] or guest["display_name"]
        cur = guest["boards"].get(board["id"])
        if PERM_RANK[r["permission"]] >= PERM_RANK[cur]:
            guest["boards"][board["id"]] = r["permission"]
            guest.setdefault("via", {})[board["id"]] = token
        auth.save_guest(guest)
        return {"board_id": board["id"]}


# ------------------------------------------------------------------ realtime hub

ITEM_TYPES = {"sticky", "text", "line", "shape", "frame", "draw"}


class Client:
    def __init__(self, ws: WebSocket, conn_id: str, ident: dict[str, Any], perm: str, user: dict | None, guest: dict | None):
        self.ws = ws
        self.conn_id = conn_id
        self.ident = ident
        self.perm = perm
        self.user = user
        self.guest = guest
        self.cursor: dict | None = None
        self.selection: list[str] = []


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[str, dict[str, Client]] = {}
        self.lock = asyncio.Lock()

    def presence(self, board_id: str) -> list[dict[str, Any]]:
        return [
            {**c.ident, "conn": c.conn_id, "perm": c.perm, "cursor": c.cursor, "selection": c.selection}
            for c in self.rooms.get(board_id, {}).values()
        ]

    async def send(self, client: Client, msg: dict) -> None:
        try:
            await client.ws.send_text(json.dumps(msg))
        except Exception:
            pass

    async def broadcast(self, board_id: str, msg: dict, exclude: str | None = None) -> None:
        clients = list(self.rooms.get(board_id, {}).values())
        data = json.dumps(msg)
        for c in clients:
            if c.conn_id == exclude:
                continue
            try:
                await c.ws.send_text(data)
            except Exception:
                pass

    async def join(self, board_id: str, client: Client) -> None:
        self.rooms.setdefault(board_id, {})[client.conn_id] = client
        await self.broadcast(board_id, {"t": "presence", "users": self.presence(board_id)})

    async def leave(self, board_id: str, conn_id: str) -> None:
        room = self.rooms.get(board_id)
        if room and conn_id in room:
            del room[conn_id]
            if not room:
                del self.rooms[board_id]
            else:
                await self.broadcast(board_id, {"t": "presence", "users": self.presence(board_id)})

    async def refresh_permissions(self, board_id: str) -> None:
        """Recompute each connected client's permission after membership/sharing changes."""
        room = self.rooms.get(board_id)
        if not room:
            return
        with db.conn() as c:
            board = get_board(c, board_id)
            for client in list(room.values()):
                # Refresh user row (role may have changed).
                user = None
                if client.user:
                    user = db.row_to_dict(c.execute("SELECT * FROM users WHERE id=?", (client.user["id"],)).fetchone())
                guest = auth.get_guest(client.guest.get("token")) if client.guest else None
                if client.guest and guest is None:
                    guest = {**client.guest, "boards": {}}  # guest record expired or revoked
                perm = board_permission(c, board, user, guest)
                if perm is None:
                    await self.send(client, {"t": "kicked"})
                    try:
                        await client.ws.close()
                    except Exception:
                        pass
                elif perm != client.perm:
                    client.perm = perm
                    await self.send(client, {"t": "perm", "permission": perm})
        await self.broadcast(board_id, {"t": "presence", "users": self.presence(board_id)})


HUB = Hub()


def apply_ops(board_id: str, ops: list[dict[str, Any]], actor_id: str | None) -> list[dict[str, Any]]:
    """Persist a batch of item operations; returns the normalized ops to broadcast."""
    t = db.now()
    out: list[dict[str, Any]] = []
    with db.conn() as c:
        for op in ops[:500]:
            a = op.get("a")
            if a == "delete":
                ids = [str(i) for i in op.get("ids", [])][:500]
                if ids:
                    c.executemany("DELETE FROM items WHERE board_id=? AND id=?", [(board_id, i) for i in ids])
                    out.append({"a": "delete", "ids": ids})
            elif a in ("create", "update"):
                it = op.get("item") or {}
                iid = str(it.get("id") or uid())[:40]
                typ = str(it.get("type", "sticky"))
                if typ not in ITEM_TYPES:
                    continue
                props = it.get("props") if isinstance(it.get("props"), dict) else {}
                vals = {
                    "x": float(it.get("x", 0)), "y": float(it.get("y", 0)),
                    "w": float(it.get("w", 200)), "h": float(it.get("h", 200)),
                    "rotation": float(it.get("rotation", 0)), "z": int(it.get("z", 0)),
                }
                existing = c.execute("SELECT * FROM items WHERE id=? AND board_id=?", (iid, board_id)).fetchone()
                if existing:
                    c.execute(
                        "UPDATE items SET type=?,x=?,y=?,w=?,h=?,rotation=?,z=?,props=?,updated_by=?,updated_at=? WHERE id=?",
                        (typ, vals["x"], vals["y"], vals["w"], vals["h"], vals["rotation"], vals["z"], json.dumps(props), actor_id, t, iid),
                    )
                else:
                    c.execute(
                        "INSERT INTO items(id,board_id,type,x,y,w,h,rotation,z,props,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (iid, board_id, typ, vals["x"], vals["y"], vals["w"], vals["h"], vals["rotation"], vals["z"], json.dumps(props), actor_id, actor_id, t, t),
                    )
                row = db.item_row(c.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone())
                out.append({"a": "create" if not existing else "update", "item": row})
        if out:
            c.execute("UPDATE boards SET updated_at=? WHERE id=?", (t, board_id))
            maybe_auto_snapshot(c, board_id, actor_id, t)
    return out


# ------------------------------------------------------------------ version history (snapshots)

def board_items(c, board_id: str) -> list[dict[str, Any]]:
    return [db.item_row(r) for r in c.execute("SELECT * FROM items WHERE board_id=? ORDER BY z, created_at", (board_id,))]


def write_snapshot(c, board_id: str, kind: str, label: str, actor_id: str | None, t: float | None = None) -> dict[str, Any]:
    items = board_items(c, board_id)
    sid = uid()
    t = t or db.now()
    c.execute(
        "INSERT INTO board_snapshots(id,board_id,kind,label,created_by,created_at,item_count,data) VALUES(?,?,?,?,?,?,?,?)",
        (sid, board_id, kind, label[:80], actor_id, t, len(items), json.dumps(items)),
    )
    if kind == "auto":
        old = c.execute(
            "SELECT id FROM board_snapshots WHERE board_id=? AND kind='auto' ORDER BY created_at DESC LIMIT 1000 OFFSET ?",
            (board_id, MAX_AUTO_SNAPSHOTS),
        ).fetchall()
        for r in old:
            c.execute("DELETE FROM board_snapshots WHERE id=?", (r["id"],))
    return {"id": sid, "board_id": board_id, "kind": kind, "label": label, "created_by": actor_id, "created_at": t, "item_count": len(items)}


def maybe_auto_snapshot(c, board_id: str, actor_id: str | None, t: float) -> None:
    """Keep a rolling history: one automatic version per AUTO_SNAPSHOT_INTERVAL of activity."""
    last = c.execute("SELECT created_at FROM board_snapshots WHERE board_id=? ORDER BY created_at DESC LIMIT 1", (board_id,)).fetchone()
    if last is None or t - last["created_at"] >= AUTO_SNAPSHOT_INTERVAL:
        write_snapshot(c, board_id, "auto", "", actor_id, t)


def snapshot_meta(c, board_id: str) -> list[dict[str, Any]]:
    rows = c.execute(
        "SELECT s.id, s.kind, s.label, s.created_at, s.item_count, s.created_by, u.display_name AS author "
        "FROM board_snapshots s LEFT JOIN users u ON u.id=s.created_by WHERE s.board_id=? ORDER BY s.created_at DESC LIMIT 200",
        (board_id,),
    ).fetchall()
    return [dict(r) for r in rows]


class SnapshotIn(BaseModel):
    label: str = Field(default="", max_length=80)


@app.get("/api/boards/{board_id}/snapshots")
def list_snapshots(board_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "view")
    with db.conn() as c:
        return {"snapshots": snapshot_meta(c, board_id)}


@app.post("/api/boards/{board_id}/snapshots")
def create_snapshot(board_id: str, body: SnapshotIn, request: Request):
    board, perm, user, guest = require_board(request, board_id, "edit")
    with db.conn() as c:
        write_snapshot(c, board_id, "manual", body.label or "Saved version", (user or guest or {}).get("id"))
        return {"snapshots": snapshot_meta(c, board_id)}


@app.get("/api/boards/{board_id}/snapshots/{snap_id}")
def read_snapshot(board_id: str, snap_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "view")
    with db.conn() as c:
        r = c.execute("SELECT * FROM board_snapshots WHERE id=? AND board_id=?", (snap_id, board_id)).fetchone()
    if not r:
        raise HTTPException(404, "Version not found")
    d = dict(r)
    d["items"] = json.loads(d.pop("data"))
    return {"snapshot": d}


@app.post("/api/boards/{board_id}/snapshots/{snap_id}/restore")
async def restore_snapshot(board_id: str, snap_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "edit")
    actor_id = (user or guest or {}).get("id")
    with db.conn() as c:
        r = c.execute("SELECT * FROM board_snapshots WHERE id=? AND board_id=?", (snap_id, board_id)).fetchone()
        if not r:
            raise HTTPException(404, "Version not found")
        # Safety net: keep the current state as a version before overwriting it.
        write_snapshot(c, board_id, "manual", "Before restore", actor_id)
        items = json.loads(r["data"])
        t = db.now()
        c.execute("DELETE FROM items WHERE board_id=?", (board_id,))
        for it in items:
            c.execute(
                "INSERT INTO items(id,board_id,type,x,y,w,h,rotation,z,props,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (it["id"], board_id, it["type"], it["x"], it["y"], it["w"], it["h"], it.get("rotation", 0), it.get("z", 0),
                 json.dumps(it.get("props", {})), it.get("created_by"), actor_id, it.get("created_at", t), t),
            )
        c.execute("UPDATE boards SET updated_at=? WHERE id=?", (t, board_id))
        items = board_items(c, board_id)
        snaps = snapshot_meta(c, board_id)
    await HUB.broadcast(board_id, {"t": "items", "items": items, "reason": "restore", "by": actor_identity(user, guest)})
    return {"items": items, "snapshots": snaps}


@app.delete("/api/boards/{board_id}/snapshots/{snap_id}")
def delete_snapshot(board_id: str, snap_id: str, request: Request):
    board, perm, user, guest = require_board(request, board_id, "owner")
    with db.conn() as c:
        c.execute("DELETE FROM board_snapshots WHERE id=? AND board_id=?", (snap_id, board_id))
        return {"snapshots": snapshot_meta(c, board_id)}


@app.get("/api/admin/export")
def admin_export(admin=Depends(auth.require_admin)):
    """Full backup of every board (metadata, members, items) as one JSON file."""
    with db.conn() as c:
        boards = []
        for b in c.execute("SELECT * FROM boards ORDER BY created_at").fetchall():
            b = dict(b)
            b["members"] = list_members_rows(c, b)
            b["items"] = board_items(c, b["id"])
            boards.append(b)
        users = [auth.public_user(dict(r)) for r in c.execute("SELECT * FROM users").fetchall()]
    payload = {"format": "whiteboard/backup-v1", "exported_at": db.now(), "users": users, "boards": boards}
    fname = time.strftime("whiteboard-backup-%Y%m%d-%H%M.json")
    return JSONResponse(payload, headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.websocket("/ws/boards/{board_id}")
async def board_ws(ws: WebSocket, board_id: str):
    user = auth.ws_user(ws)
    guest = auth.get_guest(ws.cookies.get(auth.GUEST_COOKIE))
    with db.conn() as c:
        r = c.execute("SELECT * FROM boards WHERE id=?", (board_id,)).fetchone()
        if not r:
            await ws.close(code=4404)
            return
        board = dict(r)
        perm = board_permission(c, board, user, guest)
    if perm is None:
        await ws.close(code=4403)
        return
    await ws.accept()
    conn_id = secrets.token_hex(6)
    client = Client(ws, conn_id, actor_identity(user, guest), perm, user, guest)
    with db.conn() as c:
        items = [db.item_row(rr) for rr in c.execute("SELECT * FROM items WHERE board_id=? ORDER BY z, created_at", (board_id,))]
    await HUB.send(client, {"t": "init", "items": items, "you": {**client.ident, "conn": conn_id, "perm": perm}, "users": HUB.presence(board_id)})
    await HUB.join(board_id, client)
    actor_id = (user or {}).get("id") or client.ident["id"]
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("t")
            if t == "op":
                if PERM_RANK[client.perm] < PERM_RANK["edit"]:
                    await HUB.send(client, {"t": "error", "message": "You have view-only access"})
                    continue
                ops = await asyncio.to_thread(apply_ops, board_id, msg.get("ops", []), actor_id)
                if ops:
                    await HUB.broadcast(board_id, {"t": "op", "ops": ops, "by": client.ident, "conn": conn_id, "echo": msg.get("echo")}, exclude=None)
            elif t == "cursor":
                client.cursor = {"x": msg.get("x"), "y": msg.get("y")} if msg.get("x") is not None else None
                await HUB.broadcast(board_id, {"t": "cursor", "conn": conn_id, "cursor": client.cursor, "user": client.ident}, exclude=conn_id)
            elif t == "select":
                client.selection = [str(i) for i in msg.get("ids", [])][:200]
                await HUB.broadcast(board_id, {"t": "select", "conn": conn_id, "ids": client.selection, "user": client.ident}, exclude=conn_id)
            elif t == "ping":
                await HUB.send(client, {"t": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await HUB.leave(board_id, conn_id)


# ------------------------------------------------------------------ static SPA

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/{full_path:path}")
def spa(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("ws/"):
        raise HTTPException(404)
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
