"""Username/password auth with scrypt hashing and opaque session tokens (cookie)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Any

from fastapi import HTTPException, Request, WebSocket

from . import db

SESSION_COOKIE = "wb_session"
SESSION_TTL = 60 * 60 * 24 * 30  # 30 days
GUEST_COOKIE = "wb_guest"

# In-memory guest sessions (link visitors without an account). token -> {name, color, boards:{board_id: permission}}
GUESTS: dict[str, dict[str, Any]] = {}

AVATAR_COLORS = [
    "#F24E1E", "#FF7262", "#A259FF", "#1ABCFE", "#0ACF83", "#FFB800",
    "#E91E63", "#3F51B5", "#009688", "#795548", "#607D8B", "#8BC34A",
]


def pick_color(seed: str) -> str:
    h = int(hashlib.sha1(seed.encode()).hexdigest(), 16)
    return AVATAR_COLORS[h % len(AVATAR_COLORS)]


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt_b64, dk_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
        dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


def public_user(u: dict[str, Any] | None) -> dict[str, Any] | None:
    if not u:
        return None
    return {
        "id": u["id"],
        "username": u["username"],
        "display_name": u["display_name"],
        "role": u["role"],
        "color": u["color"],
        "active": bool(u.get("active", 1)),
        "created_at": u.get("created_at"),
    }


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    t = time.time()
    with db.conn() as c:
        c.execute(
            "INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)",
            (token, user_id, t, t + SESSION_TTL),
        )
        c.execute("DELETE FROM sessions WHERE expires_at < ?", (t,))
    return token


def destroy_session(token: str | None) -> None:
    if not token:
        return
    with db.conn() as c:
        c.execute("DELETE FROM sessions WHERE token=?", (token,))


def user_from_token(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    with db.conn() as c:
        r = c.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?",
            (token, time.time()),
        ).fetchone()
        u = db.row_to_dict(r)
        if u and not u["active"]:
            return None
        return u


def current_user(request: Request) -> dict[str, Any] | None:
    return user_from_token(request.cookies.get(SESSION_COOKIE))


def require_user(request: Request) -> dict[str, Any]:
    u = current_user(request)
    if not u:
        raise HTTPException(401, "Not signed in")
    return u


def require_admin(request: Request) -> dict[str, Any]:
    u = require_user(request)
    if u["role"] != "admin":
        raise HTTPException(403, "Admin only")
    return u


def ws_user(ws: WebSocket) -> dict[str, Any] | None:
    return user_from_token(ws.cookies.get(SESSION_COOKIE))


# ---- guests -----------------------------------------------------------------

def get_guest(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    return GUESTS.get(token)


def create_guest(name: str) -> tuple[str, dict[str, Any]]:
    token = secrets.token_urlsafe(24)
    g = {"id": "guest_" + token[:10], "display_name": name[:40] or "Guest", "color": pick_color(token), "boards": {}, "guest": True}
    GUESTS[token] = g
    return token, g
