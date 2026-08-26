"""WebRTC video via a managed SFU, with the tracking feed kept separate.

The phone publishes H.264 to the SFU and viewers subscribe from it, so the live
video never passes through this server at all. That matters more than it
sounds: with video relayed by us, every extra watcher cost another full copy of
the stream on our uplink - which is what made the feed unwatchable when the rig
was tunnelled through a laptop on cellular.

Tracking does NOT use this path. The phone keeps sending low-rate JPEGs over the
existing WebSocket, because the two jobs want opposite things:

    viewing   - high frame rate, high quality, interpolation is fine
    tracking  - a few frames a second, only marker geometry matters

A 0.8 RPM wheel moves 2.4 degrees between frames at 2fps, so tracking at that
rate costs nothing measurable and about 0.2 Mbps. Decoding an H.264 stream on
the server to recover frames we would then throw most of away would burn CPU to
make the numbers worse.

Tokens are signed here rather than fetched from the SFU: they are short-lived
HS256 JWTs over a documented claim set, so a dependency would buy nothing.

Unconfigured, every function here reports "disabled" and the rest of the system
falls back to sending video over the WebSocket as before. That fallback is not
courtesy - it is what lets the rig run at all before SFU credentials exist, and
what it degrades to if the SFU is unreachable.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

# One room for the rig. There is one wheel; naming it per-session would only
# make the viewer page guess which room to join.
ROOM = os.environ.get("EVAPOFLEX_STREAM_ROOM", "rig")

PUBLISH_TTL_S = 12 * 60 * 60   # the phone is mounted; re-minting hourly is noise
VIEW_TTL_S = 60 * 60


def config() -> dict:
    """SFU connection details. Public - viewers need the URL to subscribe."""
    url = os.environ.get("EVAPOFLEX_LIVEKIT_URL", "").strip()
    key = os.environ.get("EVAPOFLEX_LIVEKIT_KEY", "").strip()
    secret = os.environ.get("EVAPOFLEX_LIVEKIT_SECRET", "").strip()
    return {
        "enabled": bool(url and key and secret),
        "url": url,
        "room": ROOM,
        "key": key,
        "secret": secret,
    }


def public_config() -> dict:
    """What the browser is allowed to know: where to connect, not how to sign."""
    c = config()
    return {"enabled": c["enabled"], "url": c["url"], "room": c["room"]}


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def mint_token(identity: str, *, publish: bool) -> str:
    """Sign a LiveKit access token (HS256 JWT).

    `publish` separates the phone from everyone else. A viewer token carries
    canPublish=false, so a token handed to the public page cannot be replayed to
    push video into the room - the feed is watchable by anyone but writable only
    by the camera account.
    """
    c = config()
    if not c["enabled"]:
        raise RuntimeError("streaming is not configured")

    now = int(time.time())
    ttl = PUBLISH_TTL_S if publish else VIEW_TTL_S
    payload = {
        "iss": c["key"],
        "sub": identity,
        "nbf": now - 10,          # tolerate small clock skew on the phone
        "exp": now + ttl,
        "jti": f"{identity}-{now}",
        "video": {
            "room": c["room"],
            "roomJoin": True,
            "canPublish": publish,
            "canSubscribe": True,
            "canPublishData": False,
        },
    }
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = (
        _b64(json.dumps(header, separators=(",", ":")).encode())
        + "." + _b64(json.dumps(payload, separators=(",", ":")).encode())
    )
    sig = hmac.new(c["secret"].encode(), signing_input.encode(),
                   hashlib.sha256).digest()
    return f"{signing_input}.{_b64(sig)}"
