"""story 4858 — the sentence «the key is wrong or revoked» also rides in the 401's `WWW-Authenticate` header (`error_description`, RFC 6750 §3).

Measured on 2026-11-08 (4849 AC5, then 4858 AC1): Claude Code prints the 401's BODY («Error detail: {…message…}»); Codex 0.159.3 prints the HEADER value whole on its one error line
(`AuthRequired(AuthRequiredError { www_authenticate_header: "…" })`) and nothing of the body. Against two local fake servers that differed only in the header, the same Codex command printed
`Bearer error="invalid_token"` for the plain one and `Bearer error="invalid_token", error_description="The API key is wrong or has been revoked. …"` for the one with the description.

What these tests hold:
  · the 401 for a key the server does not know carries the description in the header, byte for byte, and the body (what Claude Code shows) is the same as before;
  · the description is ONE sentence with the line the body carries (its English half, arrow written «>»): a header value is ASCII, and may not hold a double quote or a backslash;
  · a wrong key and a revoked key are the same answer (the door cannot tell them apart: both are «the server does not know the key», 401 or 403 on the check);
  · the key is nowhere in the answer;
  · nothing else changed: no key at all keeps the old plain `Bearer`; the 503 («the server could not be asked») carries no challenge.
"""
from __future__ import annotations

import json
import re
from unittest.mock import AsyncMock, patch

import pytest

from sprintable_mcp import api_client as ac
from sprintable_mcp.api_client import (
    INVALID_KEY_HEADER_DESCRIPTION,
    INVALID_KEY_LINE,
    InvalidApiKey,
    ServerUnreachable,
)

KEY = "sk_live_" + "ab12cd34" * 8   # well-formed, made up here; never a real key
DESCRIPTION = "The API key is wrong or has been revoked. Get a new key in Sprintable: Agents > Recruit."


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _Door:
    """drives the ASGI middleware with one POST /mcp and records what it sent and whether the app behind it was reached"""

    def __init__(self, auth: bytes | None = b"Bearer " + KEY.encode()):
        self.sent: list[dict] = []
        self.reached = False
        headers = [(b"content-type", b"application/json")] + ([(b"authorization", auth)] if auth else [])
        self.scope = {"type": "http", "path": "/mcp", "method": "POST", "headers": headers}

    async def _app(self, scope, receive, send):
        self.reached = True
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    async def run(self):
        from sprintable_mcp.http_auth import bearer_auth_asgi

        async def receive():
            return {"type": "http.request", "body": b"{}", "more_body": False}

        async def send(msg):
            self.sent.append(msg)

        await bearer_auth_asgi(self._app)(self.scope, receive, send)
        start = next(m for m in self.sent if m["type"] == "http.response.start")
        body = b"".join(m.get("body", b"") for m in self.sent if m["type"] == "http.response.body")
        return start["status"], {k.decode("ascii"): v for k, v in start["headers"]}, body


@pytest.mark.anyio
@pytest.mark.parametrize("status_of_the_check", [401, 403])
async def test_a_key_the_server_does_not_know_gets_the_sentence_in_the_challenge_header(status_of_the_check):
    door = _Door()
    with patch.object(ac.client, "ensure_auth_context", new=AsyncMock(side_effect=InvalidApiKey(status_of_the_check))):
        status, headers, body = await door.run()
    assert status == 401 and door.reached is False
    assert headers["www-authenticate"] == f'Bearer error="invalid_token", error_description="{DESCRIPTION}"'.encode("ascii")
    # what Claude Code shows is untouched
    payload = json.loads(body.decode("utf-8"))
    assert payload["error"]["code"] == "invalid_api_key" and payload["error"]["message"] == INVALID_KEY_LINE
    # the key is nowhere
    blob = (body + b"".join(headers.values())).decode("utf-8")
    assert KEY not in blob and KEY[:12] not in blob and "ab12cd34" not in blob


def test_the_description_is_the_english_half_of_the_line_in_header_safe_ascii():
    assert INVALID_KEY_HEADER_DESCRIPTION == DESCRIPTION
    assert INVALID_KEY_HEADER_DESCRIPTION == INVALID_KEY_LINE.split(" / ")[0].replace("→", ">")   # one sentence, one source
    INVALID_KEY_HEADER_DESCRIPTION.encode("ascii")                                                  # a header value is ASCII
    # RFC 6750 §3: error_description = %x20-21 / %x23-5B / %x5D-7E (no double quote, no backslash, no control character)
    assert re.fullmatch(r"[\x20\x21\x23-\x5B\x5D-\x7E]+", INVALID_KEY_HEADER_DESCRIPTION)


@pytest.mark.anyio
async def test_no_key_at_all_keeps_the_old_plain_challenge():
    door = _Door(auth=None)
    status, headers, body = await door.run()
    assert status == 401 and door.reached is False and b"Bearer <api_key> required" in body
    assert headers["www-authenticate"] == b"Bearer"


@pytest.mark.anyio
async def test_a_server_that_could_not_be_asked_carries_no_challenge():
    door = _Door()
    with patch.object(ac.client, "ensure_auth_context", new=AsyncMock(side_effect=ServerUnreachable())):
        status, headers, _ = await door.run()
    assert status == 503 and "www-authenticate" not in headers
