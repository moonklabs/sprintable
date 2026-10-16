"""story #4710 (Kadir's security lens on web PR 5123) — the hero path of the recruiter hires an agent inside the desktop app and
never shows the key, but `POST /agents/{id}/recruit` still answers with a plaintext key the browser holds for a moment. That key
must not outlive the hand-over: when the app takes the hired agent through the setup (the «이미 있는 에이전트» way · story #4565),
the exchange revokes every key the agent had — the recruit's too — so no live key is left that nobody uses.

Real HTTP · migrated PG (the 4424/4565 harness). The key is issued by `recruit_service._rotate_or_create_key`, the one place the
recruit endpoint takes its key from (story #2838), not planted by SQL."""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    _ASYNC,
    EXISTING,
    ORG,
    PROJ,
    RECIPE,
    _addresses,
    _client,
    _confirm,
    _dispose_global_engine_after_test,
    _exchange,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4565_attach_existing_agent_realdb import _live_keys, attachable  # noqa: F401
# the confirmation the recruiter's hero opens in the app is the MOVE shape (an app that can take a move · roles = existing agents), not 4565's recipe attach
from tests.test_4576_move_setup_realdb import _move, _move_code


async def _recruit_key(member) -> str:
    """The plaintext the recruit endpoint answers with — issued by the endpoint's own key function."""
    from app.services.recruit_service import _rotate_or_create_key

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            _key, plain = await _rotate_or_create_key(s, agent_id=member, scope=["stories"])
            await s.commit()
            return plain
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_the_key_the_recruit_answered_with_is_dead_once_the_app_has_the_agent(attachable, _addresses):
    recruit_key = await _recruit_key(EXISTING)
    async with _client() as c:
        # between the hire and the hand-over the key is live (the recruit rotated the agent's earlier key into it)
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {recruit_key}"})).status_code != 401
        assert await _live_keys(EXISTING) == 1

        code, verifier, _setup = await _move_code(c, "d4710 hire")  # a code as the app asks for it: capabilities ["move"]
        r = await _confirm(c, code, body=_move(EXISTING))  # the setup the recruiter's hero opens: the hired agent, moved to the app
        assert r.status_code == 200, r.text
        assert await _live_keys(EXISTING) == 1  # nothing revoked at the confirmation — the app has not taken it yet
        # the setup is the «이미 있는 에이전트» shape: the hired agent carries the `existing` mark — without it the exchange would not go
        # through `_rotate_existing_agent` and the recruit's key would stay alive (Kadir 5123)
        marks = await _sql(fetch=(
            "SELECT m->>'existing' FROM desktop_setups s, jsonb_array_elements(s.members::jsonb) m "
            f"WHERE m->>'member_id'='{EXISTING}' AND m->>'kind'='agent'"
        ))
        assert [row[0] for row in marks] == ["true"], marks

        r = await _exchange(c, code, verifier)
        assert r.status_code == 200, r.text
        mine = next(a for a in r.json()["agents"] if a["member_id"] == str(EXISTING))

        # the hand-over: the recruit's key (the one a browser's developer tools or a HAR could have kept) is dead
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {recruit_key}"})).status_code == 401
        assert await _live_keys(EXISTING) == 1  # only the app's own key lives
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {mine['api_key']}"})).status_code == 200
        assert mine["api_key"] != recruit_key
