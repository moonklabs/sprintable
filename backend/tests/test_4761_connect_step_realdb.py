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


async def _key(Session, org_id, agent, *, created_ago_s=0, revoked=False, expired=False, created_at=None, legacy_only=False,
               key_id=None) -> uuid.UUID:
    from app.models.api_key import ApiKey

    now = datetime.now(timezone.utc)
    k = ApiKey(
        id=key_id or uuid.uuid4(), team_member_id=agent, member_id=None if legacy_only else agent, key_prefix="sk_live_ab",
        key_hash=uuid.uuid4().hex,
        created_at=created_at or now - timedelta(seconds=created_ago_s),
        revoked_at=now if revoked else None,
        expires_at=(now - timedelta(seconds=1)) if expired else None,
    )
    async with Session() as s:
        s.add(k)
        await s.commit()
    return k.id


async def _call(Session, org_id, agent, key_id, *, ago_s: int, row_org=None) -> datetime:
    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog

    at = datetime.now(timezone.utc) - timedelta(seconds=ago_s)
    async with Session() as s:
        s.add(AgentApiKeyUsageLog(
            id=uuid.uuid4(), api_key_id=key_id, org_id=row_org or org_id, member_id=agent, endpoint="/api/v2/dashboard", method="GET",
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


@_realdb
async def test_06b_a_row_another_org_left_for_this_key_is_not_this_orgs_connection():
    """The ledger keeps the org each call was made under. A row under another org (a key id that was seen elsewhere) does not
    verify this org's agent; the same key's row under THIS org does."""
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        key = await _key(Session, org_id, agent)
        await _call(Session, org_id, agent, key, ago_s=60, row_org=uuid.uuid4())
        assert (await _state(Session, org_id, agent))["verified"] is False
        mine = await _call(Session, org_id, agent, key, ago_s=30)
        st = await _state(Session, org_id, agent)
        assert st["verified"] is True and st["first_call_at"] == mine.isoformat()
    finally:
        await engine.dispose()


@_realdb
async def test_06c_a_key_that_only_the_legacy_member_column_names_counts():
    """`agent_api_keys` carries two member columns (member_id the mirror, team_member_id the legacy one). A key written with only the
    legacy one is still the agent's key."""
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        key = await _key(Session, org_id, agent, legacy_only=True)
        first = await _call(Session, org_id, agent, key, ago_s=30)
        st = await _state(Session, org_id, agent)
        assert st["verified"] is True and st["first_call_at"] == first.isoformat()
    finally:
        await engine.dispose()


@_realdb
async def test_06d_two_keys_made_in_the_same_instant_give_one_answer_the_newer_id_wins():
    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        at = datetime.now(timezone.utc) - timedelta(seconds=120)
        low, high = sorted([uuid.uuid4(), uuid.uuid4()])
        k_low = await _key(Session, org_id, agent, created_at=at, key_id=low)
        k_high = await _key(Session, org_id, agent, created_at=at, key_id=high)
        await _call(Session, org_id, agent, k_low, ago_s=60)
        assert (await _state(Session, org_id, agent))["verified"] is False  # the higher id is «current» and has not been used
        await _call(Session, org_id, agent, k_high, ago_s=30)
        assert (await _state(Session, org_id, agent))["verified"] is True
    finally:
        await engine.dispose()


@_realdb
async def test_06e_a_row_whose_org_was_never_resolved_is_this_keys_call_all_the_same():
    """codex round 2: `org_id` of the ledger is nullable (resolution is best-effort at write time). A legitimate call of the agent's
    current key with no org recorded still connects it — the org filter is there to keep out ANOTHER org's rows, not unresolved ones."""
    from sqlalchemy import update

    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog

    engine, Session = await _session_factory()
    try:
        org_id, _, agent = await _world(Session)
        key = await _key(Session, org_id, agent)
        first = await _call(Session, org_id, agent, key, ago_s=300)
        async with Session() as s:
            await s.execute(update(AgentApiKeyUsageLog).where(AgentApiKeyUsageLog.api_key_id == key).values(org_id=None))
            await s.commit()
        st = await _state(Session, org_id, agent)
        assert st["verified"] is True and st["first_call_at"] == first.isoformat()
    finally:
        await engine.dispose()


def test_07_the_usage_ledger_is_named_only_by_the_files_that_read_and_write_it():
    """The latch reads the first row of a key. A retention job that cleared old rows would let it go for a key in use for long.
    A guard that looks for spellings of a delete misses the ones it did not think of (a schema-qualified or quoted name, an alias,
    `__table__.delete()`, `query(...).delete()`, a split string — and `ee/`, which the first guard never walked). So the property is
    held by NAME: across `app/` and `ee/`, the ledger may be named only by the four files that read or write it — a new reference
    to it has to be read by a person here first. (Kadir's lens on 5199.)"""
    backend = Path(__file__).resolve().parents[1]
    allowed = {
        "app/models/agent_api_key_usage_log.py", "app/models/__init__.py",
        "app/services/agent_api_key_usage.py", "app/services/agent_verify.py",
    }
    names = ("agent_api_key_usage_logs", "AgentApiKeyUsageLog")
    deletes = re.compile(r"DELETE|TRUNCATE|\.delete\(|\bdelete\(|\bDROP\b", re.I)
    hits: list[str] = []
    for top in ("app", "ee"):
        root = backend / top
        if not root.exists():
            continue
        for p in root.rglob("*.py"):
            text = p.read_text(encoding="utf-8")
            if not any(n in text for n in names):
                continue
            rel = p.relative_to(backend).as_posix()
            if rel not in allowed:
                hits.append(rel)
            elif rel in ("app/services/agent_verify.py", "app/services/agent_api_key_usage.py"):
                # the two services that may name it must not delete from it either
                near = [m for m in deletes.finditer(text) if any(n in text[max(0, m.start() - 200): m.end() + 200] for n in names)]
                if near:
                    hits.append(f"{rel} (a delete next to the ledger)")
    assert hits == [], f"the key-usage ledger is append-only (the 4761 latch reads its first row) — new references: {hits}"


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


def _rows(*ids):
    r = MagicMock()
    r.scalars.return_value.all.return_value = list(ids)
    return r


async def test_14_a_webhook_covered_agent_is_reached_without_asking_the_database():
    from app.services.agent_push_reach import push_reachable_agent_ids

    a, b = uuid.uuid4(), uuid.uuid4()
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_rows())
    assert await push_reachable_agent_ids(db, {a}, webhook_covered={a}) == {a}
    assert db.execute.await_count == 0
    assert await push_reachable_agent_ids(db, {a, b}, webhook_covered={a}) == {a}  # b asked, not found
    assert db.execute.await_count == 1


async def test_14b_every_agent_is_asked_in_one_read_not_one_per_agent():
    """codex round 2: a group message must not cost a read per agent recipient."""
    from app.services.agent_push_reach import push_reachable_agent_ids

    ids = {uuid.uuid4() for _ in range(6)}
    live = sorted(ids)[:2]
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_rows(*live))
    assert await push_reachable_agent_ids(db, ids, webhook_covered=set()) == set(live)
    assert db.execute.await_count == 1


async def test_15_with_presence_on_redis_online_is_what_counts_not_a_quiet_session_row(monkeypatch):
    """codex round 1: with presence on Redis the session row's last_seen_at is not kept fresh — «online» comes from Redis (the way the
    connection test judges it). Redis online → reached even when the row says nothing; Redis says offline → not; Redis down (None) → the
    row's existence. All agents are asked of Redis together; only the ones Redis could not answer for go to the database, in one read."""
    from app.core.config import settings
    from app.services import presence_online
    from app.services.agent_push_reach import push_reachable_agent_ids

    monkeypatch.setattr(settings, "presence_online_redis_enabled", True, raising=False)
    monkeypatch.setattr(settings, "redis_url", "redis://example:6379", raising=False)
    a, b, c = sorted(uuid.uuid4() for _ in range(3))
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_rows())

    monkeypatch.setattr(presence_online, "is_online", AsyncMock(return_value=True))
    assert await push_reachable_agent_ids(db, {a}, webhook_covered=set()) == {a}
    assert db.execute.await_count == 0  # Redis answered

    monkeypatch.setattr(presence_online, "is_online", AsyncMock(return_value=False))
    assert await push_reachable_agent_ids(db, {a}, webhook_covered=set()) == set()
    assert db.execute.await_count == 0

    answers = {a: True, b: False, c: None}  # a online · b offline · c: Redis cannot say
    monkeypatch.setattr(presence_online, "is_online", AsyncMock(side_effect=lambda x: answers[x]))
    db.execute = AsyncMock(return_value=_rows(c))  # c has a session row
    assert await push_reachable_agent_ids(db, {a, b, c}, webhook_covered=set()) == {a, c}
    assert db.execute.await_count == 1  # one read, only for c
    db.execute = AsyncMock(return_value=_rows())  # c has none
    assert await push_reachable_agent_ids(db, {a, b, c}, webhook_covered=set()) == {a}


@_realdb
async def test_16_an_agent_mentioned_from_outside_the_conversation_is_told_about_too():
    """codex round 1: a mention-only agent never went through the participant dispatch — the sender still has to hear that it will
    not notice."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            human_id, human_user = await _make_human_member(s, org.id, project.id)
            partner_id, _ = await _make_human_member(s, org.id, project.id)
            outsider = await _make_agent_member(s, org.id, project.id)
            conv = await _make_conversation(s, org.id, project.id, [human_id, partner_id], human_id, conv_type="group")
        from app.main import app

        await _setup_app_human(app, Session, human_user, org.id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/conversations/{conv}/messages",
                                      json={"content": "@agent look", "mentioned_ids": [str(outsider)]})
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 201, r.text
        assert [x["member_id"] for x in r.json()["agent_wake"]["required"]] == [str(outsider)]
    finally:
        await engine.dispose()


@_realdb
async def test_17_a_failed_reachability_read_never_costs_the_message(monkeypatch):
    """The read only decides «typing» and what the sender is told. If it fails the message is still sent, the agent shows as before
    (typing — no worse than until now) and no wake claim is made."""
    engine, Session = await _session_factory()
    try:
        import app.services.agent_push_reach as reach

        async def boom(*_a, **_k):
            raise RuntimeError("redis and database both gone")

        monkeypatch.setattr(reach, "push_reachable_agent_ids", boom)
        org_id, human_user, agent, conv = await _dm_with_agent(Session)
        r = await _send(Session, org_id, human_user, conv)
        assert r.status_code == 201, r.text
        assert "agent_wake" not in r.json()
        assert await _working(conv) == [str(agent)]
    finally:
        await engine.dispose()


@_realdb
async def test_18_a_failed_read_of_the_agent_names_never_turns_the_answer_into_an_error(monkeypatch):
    """Kadir's lens: the read that names the agents for `agent_wake` runs after the commit. If it fails the message is already stored
    and delivered — the sender must still get its 201 (no `agent_wake`), or the retry the client offers sends the same message twice."""
    from sqlalchemy import func, select
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        org_id, human_user, agent, conv = await _dm_with_agent(Session)
        real = AsyncSession.execute
        hits = {"n": 0}

        async def flaky(self, stmt, *a, **k):
            if "ORDER BY team_members.name, team_members.id" in str(stmt):
                hits["n"] += 1
                raise RuntimeError("db blip")
            return await real(self, stmt, *a, **k)

        monkeypatch.setattr(AsyncSession, "execute", flaky)
        r = await _send(Session, org_id, human_user, conv)
        monkeypatch.setattr(AsyncSession, "execute", real)
        assert hits["n"] >= 1  # the read really ran and failed
        assert r.status_code == 201, r.text
        assert "agent_wake" not in r.json()
        async with Session() as s:
            stored = (await s.execute(select(func.count()).select_from(ConversationMessage).where(ConversationMessage.conversation_id == conv))).scalar_one()
        assert stored == 1  # once
    finally:
        await engine.dispose()
