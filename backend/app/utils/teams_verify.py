from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any

import httpx


_OPENID_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration"
_JWKS_CACHE: dict[str, Any] = {}
_JWKS_FETCHED_AT: float = 0.0
_JWKS_TTL = 3600


def _b64decode(s: str) -> bytes:
    pad = (4 - len(s) % 4) % 4
    return base64.urlsafe_b64decode(s + "=" * pad)


def _decode_json(segment: str) -> dict[str, Any]:
    try:
        return json.loads(_b64decode(segment))
    except Exception:
        return {}


async def _get_jwks() -> list[dict[str, Any]]:
    global _JWKS_CACHE, _JWKS_FETCHED_AT
    now = time.time()
    if _JWKS_CACHE and (now - _JWKS_FETCHED_AT) < _JWKS_TTL:
        return _JWKS_CACHE.get("keys", [])
    async with httpx.AsyncClient(timeout=5.0) as client:
        oidc = (await client.get(_OPENID_URL)).json()
        jwks = (await client.get(oidc["jwks_uri"])).json()
    _JWKS_CACHE = jwks
    _JWKS_FETCHED_AT = now
    return jwks.get("keys", [])


def _rsa_verify(token: str, key: dict[str, Any]) -> bool:
    try:
        from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers
        from cryptography.hazmat.primitives.asymmetric import padding
        from cryptography.hazmat.primitives import hashes
        from cryptography.exceptions import InvalidSignature

        n = int.from_bytes(_b64decode(key["n"]), "big")
        e = int.from_bytes(_b64decode(key["e"]), "big")
        pub = RSAPublicNumbers(e, n).public_key()

        parts = token.split(".")
        message = f"{parts[0]}.{parts[1]}".encode()
        sig = _b64decode(parts[2])
        pub.verify(sig, message, padding.PKCS1v15(), hashes.SHA256())
        return True
    except (ImportError, InvalidSignature, Exception):
        return False


async def verify_teams_request(
    authorization_header: str | None,
    service_url: str | None,
    bot_app_id: str | None,
) -> bool:
    if not authorization_header or not bot_app_id or not service_url:
        return False
    if not authorization_header.lower().startswith("bearer "):
        return False
    token = authorization_header[7:].strip()
    parts = token.split(".")
    if len(parts) != 3:
        return False

    header = _decode_json(parts[0])
    payload = _decode_json(parts[1])
    if header.get("alg") != "RS256" or not header.get("kid"):
        return False

    keys = await _get_jwks()
    key = next((k for k in keys if k.get("kid") == header["kid"]), None)
    if not key:
        return False

    if not _rsa_verify(token, key):
        return False

    now = int(time.time())
    if payload.get("nbf", 0) > now + 60:
        return False
    if payload.get("exp", 0) < now - 60:
        return False
    if payload.get("aud") != bot_app_id:
        return False

    return True
