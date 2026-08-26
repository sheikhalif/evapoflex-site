"""Authentication and role-based permissions for the Evapoflex live rig.

Sessions are opaque random tokens stored in SQLite and handed to the browser as
an HttpOnly cookie, so the same cookie authenticates page loads, REST calls and
WebSocket upgrades without the frontend ever touching a token. Passwords are
PBKDF2-HMAC-SHA256 with a per-user salt.

Four roles. Three are nested; `camera` sits off to the side.

    viewer    read the live feed, stats and the run archive
    operator  + start/stop runs, calibrate, stream from the phone
    admin     + create/delete users and change roles

    camera    a device account for the mounted phone: it may stream and drive
              a run, but it cannot read the archive or touch users

`camera` is deliberately NOT a superset of viewer. The phone is an unattended
device zip-tied to a rig - its credentials live in a browser on a screen anyone
walking past can pick up. Scoping it to "push frames and run the wheel" means a
stolen handset costs you the camera, not the test history.

The rig is a single physical wheel, so "operator" is deliberately a small club:
two people calibrating at once would fight over one tracker's HSV window.
"""

import hashlib
import hmac
import os
import secrets
import sqlite3
import time

SESSION_COOKIE = "evapoflex_session"
SESSION_TTL_S = 30 * 24 * 3600  # 30 days; the rig page is left open for weeks

PBKDF2_ROUNDS = 240_000

ROLES = ("viewer", "operator", "admin", "camera")

# view    read the dashboard and the run archive
# control start/stop runs, calibrate the tracker
# stream  open the ingest socket and push camera frames
# admin   manage users
PERMISSIONS = {
    "viewer": {"view"},
    "operator": {"view", "control", "stream"},
    "admin": {"view", "control", "stream", "admin"},
    "camera": {"control", "stream"},
}


class AuthError(Exception):
    """Raised for any failed credential or session check."""


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------
def hash_password(password: str, salt: bytes | None = None) -> str:
    """Return 'salt_hex$hash_hex'. A fresh salt is generated when omitted."""
    if salt is None:
        salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"{salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, hash_hex = stored.split("$", 1)
        salt = bytes.fromhex(salt_hex)
    except ValueError:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    # compare_digest so a wrong password costs the same time as a right one
    return hmac.compare_digest(dk.hex(), hash_hex)


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------
def create_user(db: sqlite3.Connection, username: str, password: str,
                role: str = "viewer") -> dict:
    if role not in ROLES:
        raise AuthError(f"unknown role {role!r}")
    username = username.strip().lower()
    if not username:
        raise AuthError("username required")
    if len(password) < 8:
        raise AuthError("password must be at least 8 characters")
    try:
        cur = db.execute(
            "INSERT INTO users (username, password_hash, role, created_at) "
            "VALUES (?, ?, ?, ?)",
            (username, hash_password(password), role, time.time()),
        )
    except sqlite3.IntegrityError:
        raise AuthError(f"user {username!r} already exists")
    db.commit()
    return {"id": cur.lastrowid, "username": username, "role": role}


def set_password(db: sqlite3.Connection, username: str, password: str) -> None:
    if len(password) < 8:
        raise AuthError("password must be at least 8 characters")
    db.execute("UPDATE users SET password_hash = ? WHERE username = ?",
               (hash_password(password), username.strip().lower()))
    db.commit()


def set_role(db: sqlite3.Connection, username: str, role: str) -> None:
    if role not in ROLES:
        raise AuthError(f"unknown role {role!r}")
    db.execute("UPDATE users SET role = ? WHERE username = ?",
               (role, username.strip().lower()))
    db.commit()


def delete_user(db: sqlite3.Connection, username: str) -> None:
    username = username.strip().lower()
    row = db.execute("SELECT id FROM users WHERE username = ?",
                     (username,)).fetchone()
    if row is None:
        raise AuthError("no such user")
    admins = db.execute(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").fetchone()["n"]
    is_admin = db.execute("SELECT role FROM users WHERE username = ?",
                          (username,)).fetchone()["role"] == "admin"
    if is_admin and admins <= 1:
        # Locking every admin out of a rig that lives behind a tunnel would
        # mean editing the database by hand to get back in.
        raise AuthError("cannot delete the last admin")
    db.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
    db.execute("DELETE FROM users WHERE id = ?", (row["id"],))
    db.commit()


def list_users(db: sqlite3.Connection) -> list[dict]:
    rows = db.execute(
        "SELECT username, role, created_at, last_login FROM users "
        "ORDER BY username").fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------
def login(db: sqlite3.Connection, username: str, password: str) -> str:
    """Verify credentials and return a new session token."""
    username = (username or "").strip().lower()
    row = db.execute(
        "SELECT id, password_hash FROM users WHERE username = ?",
        (username,)).fetchone()
    if row is None:
        # Hash anyway so a missing user and a wrong password take the same
        # time; otherwise the response latency enumerates valid usernames.
        hash_password(password or "")
        raise AuthError("invalid username or password")
    if not verify_password(password or "", row["password_hash"]):
        raise AuthError("invalid username or password")

    token = secrets.token_urlsafe(32)
    now = time.time()
    db.execute(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) "
        "VALUES (?, ?, ?, ?)",
        (token, row["id"], now, now + SESSION_TTL_S),
    )
    db.execute("UPDATE users SET last_login = ? WHERE id = ?", (now, row["id"]))
    db.commit()
    return token


def logout(db: sqlite3.Connection, token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token = ?", (token,))
    db.commit()


def user_for_token(db: sqlite3.Connection, token: str | None) -> dict | None:
    """Resolve a session token to a user dict, or None if invalid/expired."""
    if not token:
        return None
    row = db.execute(
        "SELECT u.id, u.username, u.role, s.expires_at "
        "FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ?", (token,)).fetchone()
    if row is None:
        return None
    if row["expires_at"] < time.time():
        db.execute("DELETE FROM sessions WHERE token = ?", (token,))
        db.commit()
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "permissions": sorted(PERMISSIONS[row["role"]]),
    }


def purge_expired_sessions(db: sqlite3.Connection) -> int:
    cur = db.execute("DELETE FROM sessions WHERE expires_at < ?",
                     (time.time(),))
    db.commit()
    return cur.rowcount


def has_permission(user: dict | None, permission: str) -> bool:
    if not user:
        return False
    return permission in PERMISSIONS.get(user["role"], set())


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
def ensure_admin(db: sqlite3.Connection) -> tuple[str, str] | None:
    """Create the first admin if the user table is empty.

    The password comes from EVAPOFLEX_ADMIN_PASSWORD when set, otherwise one is
    generated and returned so the caller can print it exactly once.
    """
    n = db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    if n:
        return None
    username = os.environ.get("EVAPOFLEX_ADMIN_USER", "admin")
    password = os.environ.get("EVAPOFLEX_ADMIN_PASSWORD")
    generated = password is None
    if generated:
        password = secrets.token_urlsafe(12)
    create_user(db, username, password, role="admin")
    return (username, password) if generated else None
