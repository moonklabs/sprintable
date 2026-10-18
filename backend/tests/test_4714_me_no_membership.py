"""story 4714 AC6 — `GET /api/v2/me` for an account with no organization yet (no member row) answers 404 with a machine-readable `reason`.

The web's proxy sends exactly this person to the onboarding (instead of leaving the phone app on a 404) and reads ONLY `error.reason`, never the
message's words. Pinned here: the code is still NOT_FOUND and the message is unchanged (every other reader is untouched), and `reason` is on the envelope.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import httpx
import pytest

from app.dependencies.auth import AuthContext, get_current_user
from app.main import app
from app.routers.me import NO_MEMBERSHIP_REASON

USER = uuid.UUID("47140000-0000-0000-0000-0000000000b1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _NoRows:
    """get_db stand-in: no team member, no org member — a brand-new account"""

    async def execute(self, _stmt):
        return SimpleNamespace(scalars=lambda: SimpleNamespace(first=lambda: None, all=lambda: []), scalar_one_or_none=lambda: None)


@pytest.fixture
def world():
    from tests.conftest import override_db_and_read  # story #2451: the one way a get_db override is hung

    async def _db():
        yield _NoRows()

    app.dependency_overrides[get_current_user] = lambda: AuthContext(user_id=str(USER), email="new@example.test", claims={})
    override_db_and_read(app, _db)
    yield
    from app.dependencies.database import get_db, get_read_db

    for k in (get_current_user, get_db, get_read_db):
        app.dependency_overrides.pop(k, None)


@pytest.mark.anyio
async def test_a_no_organization_account_gets_404_not_found_with_a_machine_readable_reason(world):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/v2/me")
    assert r.status_code == 404
    body = r.json()
    assert body["data"] is None
    assert body["error"]["code"] == "NOT_FOUND"  # unchanged: every other reader of the envelope still works
    assert body["error"]["message"] == "Member not found"  # unchanged words
    assert body["error"]["reason"] == NO_MEMBERSHIP_REASON == "no_membership"


def test_the_reason_word_is_the_one_the_web_proxy_reads():
    import re
    from pathlib import Path

    proxy = (Path(__file__).resolve().parents[2] / "apps" / "web" / "src" / "proxy.ts").read_text(encoding="utf-8")
    assert re.search(r"error\?\.reason\s*===\s*'no_membership'", proxy), "proxy.ts must read the reason field this route writes"
