"""story 4675 (UX-1 · F2) — «which computer» for every list: `device_name` on /team-members · /team-presence · a conversation's
participants (real HTTP · migrated PG · the 4424 world).

AC1: an agent bound by a live desktop key names that setup's computer; no live key → null; a move to a second computer
(4565 · the first key revoked in the exchange) → the second; the key revoked (disconnect) → null. PO 09:54Z: only this
organization's computers — a participant from another organization never carries one.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    EXISTING,
    ORG,
    ORG2,
    OWNER,
    PROJ,
    RECIPE,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _exchange,
    _person,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)

CONV = uuid.UUID("d4675000-0000-0000-0000-000000000001")
OTHER_ORG_AGENT = uuid.UUID("d4675000-0000-0000-0000-000000000002")


def _attach() -> dict:
    return {"project_id": str(PROJ), "recipe_id": str(RECIPE), "roles": [{"role": "Writer", "agent_id": str(EXISTING)}, {"role": "Reviewer", "runtime": "codex"}]}


@pytest.fixture
async def attachable(world):
    await _sql(
        f"UPDATE members SET runtime_type='claude-code' WHERE id='{EXISTING}'",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{EXISTING}','granted')",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active,runtime_type) VALUES ('{OTHER_ORG_AGENT}','{ORG2}',NULL,'agent','Elsewhere',true,'claude-code')",
    )
    yield


async def _device_of(c, member_id: uuid.UUID) -> tuple[str | None, str | None, str | None]:
    """(team-members · team-presence · conversation participant) device_name for one agent, as the org owner reads them."""
    r = await c.get("/api/v2/team-members?type=agent", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    tm = next((m for m in r.json() if m["id"] == str(member_id)), None)
    r = await c.get("/api/v2/team-presence", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    tp = next((m for m in r.json() if m["member_id"] == str(member_id)), None)
    r = await c.get(f"/api/v2/conversations/{CONV}", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    cp = next((p for p in r.json()["participants"] if p["member_id"] == str(member_id)), None)
    return (tm["device_name"] if tm else None, tp["device_name"] if tp else None, cp.get("device_name") if cp else None)


@pytest.fixture
async def conversation(attachable):
    """A DM in ORG with the owner, the attached agent, and an agent of another organization (the leak check)."""
    owner_member = (await _sql(fetch=f"SELECT id FROM members WHERE org_id='{ORG}' AND user_id='{OWNER}' LIMIT 1"))[0][0]
    await _sql(
        f"INSERT INTO conversations (id,org_id,project_id,type,title,status) VALUES ('{CONV}','{ORG}','{PROJ}','group','d4675','open')",
        f"INSERT INTO conversation_participants (id,conversation_id,member_id) VALUES "
        f"(gen_random_uuid(),'{CONV}','{owner_member}'),(gen_random_uuid(),'{CONV}','{EXISTING}'),(gen_random_uuid(),'{CONV}','{OTHER_ORG_AGENT}')",
    )
    yield


@pytest.mark.anyio
async def test_device_name_follows_the_live_key(conversation):
    async with _client() as c:
        # no live desktop key → null everywhere
        assert await _device_of(c, EXISTING) == (None, None, None)

        # bound to the first computer by its exchange
        code_a, verifier_a = await _code(c, "d4675 first mac")
        assert (await _confirm(c, code_a, body=_attach())).status_code == 200
        assert (await _exchange(c, code_a, verifier_a)).status_code == 200
        assert await _device_of(c, EXISTING) == ("d4675 first mac", "d4675 first mac", "d4675 first mac")

        # moved to a second computer: the first key is revoked in the exchange — the second computer, everywhere
        code_b, verifier_b = await _code(c, "d4675 second mac")
        assert (await _confirm(c, code_b, body=_attach())).status_code == 200
        r = await _exchange(c, code_b, verifier_b)
        assert r.status_code == 200, r.text
        setup_b = (await _sql(fetch="SELECT id::text FROM desktop_setups WHERE device_name='d4675 second mac'"))[0][0]
        assert await _device_of(c, EXISTING) == ("d4675 second mac", "d4675 second mac", "d4675 second mac")
        tm = next(m for m in (await c.get("/api/v2/team-members?type=agent", headers=_person(OWNER))).json() if m["id"] == str(EXISTING))
        assert tm["desktop_setup_id"] == setup_b  # the link target of «연결된 기기 보기»

        # two live keys at once (the moment after a move, before the old one is cut): the newest exchanged setup wins (Kadir 5068 —
        # pins `exchanged_at.desc()`; asc would name the first mac here)
        setup_a = (await _sql(fetch="SELECT id::text FROM desktop_setups WHERE device_name='d4675 first mac'"))[0][0]
        await _sql(
            "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,scope,desktop_setup_id) VALUES "
            f"('d4675000-0000-0000-0000-000000000008','{EXISTING}','{EXISTING}','sk_d4675_old','h4675old',ARRAY['core'],'{setup_a}')"
        )
        assert (await _sql(fetch=f"SELECT count(*) FROM agent_api_keys WHERE team_member_id='{EXISTING}' AND revoked_at IS NULL"))[0][0] == 2
        assert await _device_of(c, EXISTING) == ("d4675 second mac", "d4675 second mac", "d4675 second mac")
        await _sql("DELETE FROM agent_api_keys WHERE id='d4675000-0000-0000-0000-000000000008'")

        # the detail's own read says the bound computer even with no session reported
        r = await c.get(f"/api/v2/agents/{EXISTING}/desktop-session", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert (r.json()["bound_device_name"], r.json()["bound_setup_id"], r.json()["state"]) == ("d4675 second mac", setup_b, None)

        # disconnected → the key is revoked → null again
        assert (await c.delete(f"/api/v2/desktop/setups/{setup_b}", headers=_person(OWNER))).status_code == 200
        assert await _device_of(c, EXISTING) == (None, None, None)


@pytest.mark.anyio
async def test_another_organizations_agent_never_carries_a_computer(conversation):
    """PO 09:54Z — a participant from another organization: its own setup's computer is not this org's to show."""
    await _sql(
        # the columns as the model names them (desktop_setup.py: code_hash · code_challenge — Kadir 5068)
        "INSERT INTO desktop_setups (id,org_id,device_name,code_challenge,code_hash,expires_at,confirmed_at,exchanged_at,keys_issued) VALUES "
        f"('d4675000-0000-0000-0000-000000000009','{ORG2}','elsewhere mac','c4675','h4675',now()+interval '1 hour',now(),now(),1)",
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,scope,desktop_setup_id) VALUES "
        f"(gen_random_uuid(),'{OTHER_ORG_AGENT}','{OTHER_ORG_AGENT}','sk_d4675_x','h4675x',ARRAY['core'],'d4675000-0000-0000-0000-000000000009')",
    )
    async with _client() as c:
        r = await c.get(f"/api/v2/conversations/{CONV}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        other = next(p for p in r.json()["participants"] if p["member_id"] == str(OTHER_ORG_AGENT))
        assert other["device_name"] is None
        # and the helper itself, asked with this org, finds nothing for it
        from app.core.database import get_session_factory  # noqa: F401 — real session below
        from app.services.desktop_commands import bound_devices
        from tests.test_4424_desktop_setup_realdb import _ASYNC
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from sqlalchemy.pool import NullPool

        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with async_sessionmaker(eng)() as s:
                assert await bound_devices(s, org_id=ORG, member_ids=[OTHER_ORG_AGENT]) == {}
                assert (await bound_devices(s, org_id=ORG2, member_ids=[OTHER_ORG_AGENT]))[OTHER_ORG_AGENT]["device_name"] == "elsewhere mac"
        finally:
            await eng.dispose()
