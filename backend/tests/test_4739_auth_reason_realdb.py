"""story 4739 — an agent key's 401 names its reason in a closed word (a response header), and says nothing else new (real HTTP · migrated PG).

`key_revoked`: no live key by that hash (unknown · revoked) · `agent_inactive`: the key is live but its agent is not (stopped on the web). The status and the `detail` text of
those 401s are the same as before — MCP, the web and realtime read them (auth.py is shared); a 401 of another kind (a person's token, a human key) and every 403 carry NO header
(the desktop daemon reads «no word» as «unknown», never as a revocation).
"""
from __future__ import annotations

import secrets
import uuid

import pytest

from app.dependencies.auth import AUTH_REASON_HEADER
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    EXISTING,
    OWNER,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4565_attach_existing_agent_realdb import _plain_key, attachable  # noqa: F401

ME = "/api/v2/auth/me"


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.anyio
async def test_a_live_key_of_a_live_agent_is_not_refused(attachable):
    key = await _plain_key(EXISTING)
    async with _client() as c:
        r = await c.get(ME, headers=_bearer(key))
        assert r.status_code == 200, r.text
        assert AUTH_REASON_HEADER.lower() not in r.headers


@pytest.mark.anyio
async def test_an_unknown_key_says_key_revoked_and_the_old_status_and_text(attachable):
    async with _client() as c:
        r = await c.get(ME, headers=_bearer("sk_live_" + secrets.token_urlsafe(24)))
    assert r.status_code == 401
    assert r.json()["error"]["message"] == "Invalid API key"  # the text as before (reverted header → still green: the next test pins the word)
    assert r.headers[AUTH_REASON_HEADER.lower()] == "key_revoked"


@pytest.mark.anyio
async def test_a_revoked_key_says_key_revoked(attachable):
    key = await _plain_key(EXISTING)
    await _sql(f"UPDATE agent_api_keys SET revoked_at = now() WHERE member_id = '{EXISTING}'")
    async with _client() as c:
        r = await c.get(ME, headers=_bearer(key))
    assert r.status_code == 401
    assert r.json()["error"]["message"] == "Invalid API key"
    assert r.headers[AUTH_REASON_HEADER.lower()] == "key_revoked"  # reverted (no header on that raise) → KeyError


@pytest.mark.anyio
async def test_the_stopped_agents_live_key_says_agent_inactive_and_the_old_status_and_text(attachable):
    key = await _plain_key(EXISTING)
    await _sql(f"UPDATE members SET is_active = false WHERE id = '{EXISTING}'")
    async with _client() as c:
        r = await c.get(ME, headers=_bearer(key))
    assert r.status_code == 401
    assert r.json()["error"]["message"] == "API key member not found"
    assert r.headers[AUTH_REASON_HEADER.lower()] == "agent_inactive"  # reverted → KeyError (and the daemon would read it as «unknown»)


@pytest.mark.anyio
async def test_the_stopped_agent_comes_back_when_it_is_turned_on_again_with_the_same_key(attachable):
    key = await _plain_key(EXISTING)
    await _sql(f"UPDATE members SET is_active = false WHERE id = '{EXISTING}'")
    async with _client() as c:
        assert (await c.get(ME, headers=_bearer(key))).status_code == 401
        await _sql(f"UPDATE members SET is_active = true WHERE id = '{EXISTING}'")
        assert (await c.get(ME, headers=_bearer(key))).status_code == 200  # what makes «agent_inactive» a state that passes


@pytest.mark.anyio
async def test_other_refusals_carry_no_word_at_all(attachable):
    key = await _plain_key(EXISTING)
    async with _client() as c:
        garbage = await c.get(ME, headers=_bearer("not-a-token"))  # a person's token that is none
        human = await c.get(ME, headers=_bearer("hu_live_" + secrets.token_urlsafe(24)))  # a human key: not an agent key's word
        nothing = await c.get(ME)  # no credentials
        scope = await c.get("/api/v2/remote-devices", headers=_bearer(key))  # an agent key where a person's session is required: a 403
    for r in (garbage, human, nothing):
        assert r.status_code == 401
    assert scope.status_code == 403
    for r in (garbage, human, nothing, scope):
        assert AUTH_REASON_HEADER.lower() not in r.headers, r.text


@pytest.mark.anyio
async def test_a_key_revoked_between_the_two_reads_says_key_revoked_not_agent_inactive(attachable):
    """the race: the key was live when read, then a disconnect committed its revocation and the agent's deactivation together — the member read fails, the key is no longer live"""
    from app.core.database import async_session_factory
    from app.dependencies.auth import _member_missing_401
    from app.models.api_key import ApiKey
    from sqlalchemy import select

    await _plain_key(EXISTING)
    async with async_session_factory() as db:
        key = (await db.execute(select(ApiKey).where(ApiKey.member_id == EXISTING))).scalars().first()
        live = await _member_missing_401(db, key)
        assert live.headers[AUTH_REASON_HEADER] == "agent_inactive"  # key still live: the agent is the one that is gone
    await _sql(f"UPDATE agent_api_keys SET revoked_at = now() WHERE member_id = '{EXISTING}'")
    async with async_session_factory() as db:
        key = (await db.execute(select(ApiKey).where(ApiKey.member_id == EXISTING))).scalars().first()
        gone = await _member_missing_401(db, key)
        assert gone.headers[AUTH_REASON_HEADER] == "key_revoked"  # reverted (no second read) → agent_inactive for a key that never comes back
        assert (gone.status_code, gone.detail) == (401, "API key member not found")
