"""story #4761 — the web road's agent-connect step (4759 walk: 18 steps · 29 hands · 10 min 34 s, 416 s of it dead ends).

D1b: «connected» on the hosted (http) road stands on the CURRENT key's first call in the usage ledger, not on a heartbeat that
is gone 90 s after the last call. It lets go by itself when the key is revoked or replaced (the new key has no row yet).
D3: a message is «typing» only for an agent it really reaches (webhook · live gateway stream); for the rest the send answer
carries `agent_wake` (machine fields) so the screen can say what to do.
"""
from __future__ import annotations

import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_agent_member,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [pytest.mark.anyio]
_realdb = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    if _REAL_DB_URL:
        from app.core.database import engine as _global_engine

        await _global_engine.dispose()


# ── D1b — the key-bound latch ────────────────────────────────────────────────

async def _world(Session):
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        agent = await _make_agent_member(s, org.id, project.id)
    return org.id, project.id, agent


async def _key(Session, org_id, agent, *, created_ago_s=0, revoked=False, expired=False) -> uuid.UUID:
    from app.models.api_key import ApiKey

    now = datetime.now(timezone.utc)
    k = ApiKey(
        id=uuid.uuid4(), team_member_id=agent, member_id=agent, key_prefix="sk_live_ab", key_hash=uuid.uuid4().hex,
        created_at=now - timedelta(seconds=created_ago_s),
        revoked_at=now if revoked else None,
        expires_at=(now - timedelta(seconds=1)) if expired else None,
    )
    async with Session() as s:
        s.add(k)
        await s.commit()
    return k.id


async def _call(Session, org_id, agent, key_id, *, ago_s: int) -> datetime:
    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog

    at = datetime.now(timezone.utc) - timedelta(seconds=ago_s)
    async with Session() as s:
        s.add(AgentApiKeyUsageLog(
            id=uuid.uuid4(), api_key_id=key_id, org_id=org_id, member_id=agent, endpoint="/api/v2/dashboard", method="GET",
            mcp_transport="http", occurred_at=at,
        ))
        await s.commit()
    return at


async def _state(Session, org_id, agent) -> dict:
    from app.services.agent_verify import get_verification_state

    async with Session() as s:
        return await get_verification_state(s, agent, org_id=org_id, transport="http")


@_realdb
async def test_01_a_key_nobody_has_used_is_not_connected():
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        await _key(Session, org_id, agent)
        st = await _state(Session, org_id, agent)
        assert st["verified"] is False and st["first_call_at"] is None
        assert [r["state"] for r in st["rail"] if r["status"] == "done"] == ["config_copied"]
    finally:
        await engine.dispose()


@_realdb
async def test_02_a_call_long_past_the_heartbeat_window_still_counts_and_is_named():
    """D1b: the last call was 10 minutes ago (the 90 s heartbeat window is long gone, there is no heartbeat row at all) —
    the person who presses [다시 테스트] now still sees «connected», with when the first call was."""
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        key = await _key(Session, org_id, agent)
        first = await _call(Session, org_id, agent, key, ago_s=600)
        await _call(Session, org_id, agent, key, ago_s=500)
        st = await _state(Session, org_id, agent)
        assert st["verified"] is True
        assert st["first_call_at"] == first.isoformat()  # the FIRST call, not the last
        assert all(r["status"] == "done" for r in st["rail"])
    finally:
        await engine.dispose()


@_realdb
async def test_03_a_revoked_key_does_not_vouch_for_its_replacement():
    """The old key was used; it is revoked and a new key is issued. The new key has not been called → not connected (the old
    key's first call must not say the new key works). Then the new key's own first call → connected, at ITS time."""
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        old = await _key(Session, org_id, agent, created_ago_s=3600)
        await _call(Session, org_id, agent, old, ago_s=1800)
        assert (await _state(Session, org_id, agent))["verified"] is True

        from sqlalchemy import update

        from app.models.api_key import ApiKey

        async with Session() as s:
            await s.execute(update(ApiKey).where(ApiKey.id == old).values(revoked_at=datetime.now(timezone.utc)))
            await s.commit()
        new = await _key(Session, org_id, agent, created_ago_s=10)
        st = await _state(Session, org_id, agent)
        assert st["verified"] is False and st["first_call_at"] is None

        second = await _call(Session, org_id, agent, new, ago_s=2)
        st = await _state(Session, org_id, agent)
        assert st["verified"] is True and st["first_call_at"] == second.isoformat()
    finally:
        await engine.dispose()


@_realdb
async def test_04_the_newest_active_key_is_the_one_that_counts():
    """An older key still active and used, a newer active key not yet used (a replacement that was not revoked) → not connected."""
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        older = await _key(Session, org_id, agent, created_ago_s=3600)
        await _call(Session, org_id, agent, older, ago_s=1800)
        await _key(Session, org_id, agent, created_ago_s=5)
        assert (await _state(Session, org_id, agent))["verified"] is False
    finally:
        await engine.dispose()


@_realdb
async def test_05_an_expired_newest_key_is_not_the_current_key():
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        older = await _key(Session, org_id, agent, created_ago_s=3600)
        first = await _call(Session, org_id, agent, older, ago_s=1800)
        await _key(Session, org_id, agent, created_ago_s=5, expired=True)
        st = await _state(Session, org_id, agent)
        assert st["verified"] is True and st["first_call_at"] == first.isoformat()
    finally:
        await engine.dispose()


@_realdb
async def test_05b_a_revoked_newer_key_is_not_the_current_key_either():
    """The newer key was revoked unused; the older one is still active and was used → the current key is the older one."""
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        older = await _key(Session, org_id, agent, created_ago_s=3600)
        first = await _call(Session, org_id, agent, older, ago_s=1800)
        await _key(Session, org_id, agent, created_ago_s=5, revoked=True)
        st = await _state(Session, org_id, agent)
        assert st["verified"] is True and st["first_call_at"] == first.isoformat()
    finally:
        await engine.dispose()


@_realdb
async def test_06_a_fresh_heartbeat_alone_still_counts_when_the_ledger_write_was_lost():
    """The ledger write is fail-silent. A live agent (fresh heartbeat) with no ledger row is connected (no `first_call_at`)."""
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        await _key(Session, org_id, agent)
        from sqlalchemy import update

        from app.models.member import AgentProjectProfile

        async with Session() as s:
            await s.execute(update(AgentProjectProfile).where(AgentProjectProfile.member_id == agent)
                            .values(last_seen_at=datetime.now(timezone.utc)))
            await s.commit()
        st = await _state(Session, org_id, agent)
        assert st["verified"] is True and st["first_call_at"] is None
    finally:
        await engine.dispose()


def test_07_nothing_in_app_deletes_from_the_usage_ledger():
    """The latch reads the first row of a key. A retention job that cleared old rows would let it go for a key in use for long —
    this is the guard that says so before anyone adds one."""
    root = Path(__file__).resolve().parents[1] / "app"
    pat = re.compile(r"DELETE\s+FROM\s+agent_api_key_usage_logs|TRUNCATE[^;\n]*agent_api_key_usage_logs|delete\(\s*AgentApiKeyUsageLog", re.I)
    hits = [str(p.relative_to(root)) for p in root.rglob("*.py") if pat.search(p.read_text(encoding="utf-8"))]
    assert hits == [], f"the key-usage ledger is append-only (4761 latch reads its first row): {hits}"


# ── D3 — «typing» only where a message reaches; the rest is told ─────────────

async def _dm_with_agent(Session):
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        human_id, human_user = await _make_human_member(s, org.id, project.id)
        agent = await _make_agent_member(s, org.id, project.id)
        conv = await _make_conversation(s, org.id, project.id, [human_id, agent], human_id)
    return org.id, human_user, agent, conv


async def _send(Session, org_id, human_user, conv, text="안녕"):
    from app.main import app

    await _setup_app_human(app, Session, human_user, org_id)
    try:
        async with _client_for(app) as client:
            return await client.post(f"/api/v2/conversations/{conv}/messages", json={"content": text})
    finally:
        app.dependency_overrides.clear()


async def _live_session(Session, agent, *, age_s: int) -> None:
    from app.models.agent_gateway import AgentGatewaySession

    async with Session() as s:
        s.add(AgentGatewaySession(id=uuid.uuid4(), agent_id=agent, last_seen_at=datetime.now(timezone.utc) - timedelta(seconds=age_s)))
        await s.commit()


async def _working(conv) -> list[str]:
    from app.services import chat_presence

    return [w["member_id"] for w in await chat_presence.list_working(str(conv))]


@_realdb
async def test_10_an_agent_nothing_pushes_to_is_not_typing_and_the_sender_is_told():
    engine, Session = await _session_factory()
    try:
        org_id, human_user, agent, conv = await _dm_with_agent(Session)
        r = await _send(Session, org_id, human_user, conv)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["agent_wake"]["required"] == [{"member_id": str(agent), "name": body["agent_wake"]["required"][0]["name"]}]
        assert body["agent_wake"]["required"][0]["member_id"] == str(agent)
        assert await _working(conv) == []  # the lie: «typing» for 180 s with nobody who could be
    finally:
        await engine.dispose()


@_realdb
async def test_11_an_agent_with_a_live_gateway_stream_is_typing_and_nothing_is_said():
    engine, Session = await _session_factory()
    try:
        org_id, human_user, agent, conv = await _dm_with_agent(Session)
        await _live_session(Session, agent, age_s=5)
        r = await _send(Session, org_id, human_user, conv)
        assert r.status_code == 201, r.text
        assert "agent_wake" not in r.json()
        assert await _working(conv) == [str(agent)]
    finally:
        await engine.dispose()


@_realdb
async def test_12_a_stream_that_went_quiet_longer_than_the_session_window_is_not_a_way_in():
    engine, Session = await _session_factory()
    try:
        from app.routers.agent_gateway import _SESSION_FRESH_TTL

        org_id, human_user, agent, conv = await _dm_with_agent(Session)
        await _live_session(Session, agent, age_s=int(_SESSION_FRESH_TTL) + 30)
        r = await _send(Session, org_id, human_user, conv)
        assert r.status_code == 201, r.text
        assert [x["member_id"] for x in r.json()["agent_wake"]["required"]] == [str(agent)]
        assert await _working(conv) == []
    finally:
        await engine.dispose()


@_realdb
async def test_13_in_a_group_only_the_agent_that_is_not_reached_is_listed():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            human_id, human_user = await _make_human_member(s, org.id, project.id)
            reached = await _make_agent_member(s, org.id, project.id)
            silent = await _make_agent_member(s, org.id, project.id)
            conv = await _make_conversation(s, org.id, project.id, [human_id, reached, silent], human_id, conv_type="group")
        await _live_session(Session, reached, age_s=3)
        r = await _send(Session, org.id, human_user, conv)
        assert r.status_code == 201, r.text
        assert [x["member_id"] for x in r.json()["agent_wake"]["required"]] == [str(silent)]
        assert await _working(conv) == [str(reached)]
    finally:
        await engine.dispose()


async def test_14_a_webhook_covered_agent_is_reached_without_asking_the_database():
    from app.services.agent_push_reach import push_reachable_agent_ids

    a, b = uuid.uuid4(), uuid.uuid4()
    db = AsyncMock()
    r = MagicMock()
    r.scalars.return_value.all.return_value = []
    db.execute = AsyncMock(return_value=r)
    assert await push_reachable_agent_ids(db, {a}, webhook_covered={a}) == {a}
    assert db.execute.await_count == 0
    assert await push_reachable_agent_ids(db, {a, b}, webhook_covered={a}) == {a}  # b asked, not found
    assert db.execute.await_count == 1
