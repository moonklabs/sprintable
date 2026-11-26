"""story 5049 (PR 1) — a bridge line goes only into a room its mapping's project owns. Real Postgres, the real Slack and Teams entrances.

The mapping (`messaging_bridge_channels`) names a project AND a room (`config.conversation_id`); the author is found as a member of the mapping's project. Nothing checked that the room belongs to that
project, so a mapping that named another project's room (a hand-written row) posted the author's line there and seated them in it. Now:

  · a room of another project, or with no project  → skipped (`conversation_project_mismatch`): no message, no participant row
  · a project's CHANNEL                             → written only by an author already seated in it who holds the project NOW (`channel_author_not_seated` · `channel_author_lost_project`)
  · a DM, even of the mapping's own project         → skipped (`conversation_is_dm`): its participant rows are «the two of them», an external line never seats a third
  · an ordinary room of the SAME project            → as always (the author joins it by speaking)
  · a skip answers 200 at once (no memo fallback = no 500 and no lost-message resend storm), calls no workflow hook, logs, and leaves ONE audit row (`bridge.inbound_skipped`, ids and reason only — no
    words, no external name) per (mapping, reason) per hour for the organization's admin
  · the audit row failing never changes the answer
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_agent_member,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

SECRET = "s5049-secret"
WORDS = "bridge words 5049 secret-ish"
EXTERNAL_USER = "U5049EXT"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _slack_secret(monkeypatch):
    monkeypatch.setenv("SLACK_SIGNING_SECRET", SECRET)


class _W:
    """one organization, two projects, an author who is a member of project A (human, or an agent), a mapping of project A, and the ways to post through it."""

    def __init__(self, Session, org, pa, pb, author, author_user):
        self.Session, self.org, self.pa, self.pb, self.author, self.author_user = Session, org, pa, pb, author, author_user
        self.channel_id = f"C{uuid.uuid4().hex[:10]}"
        self.mapping_id = uuid.uuid4()

    async def room(self, project, *, type="group", channel=False, seat_author=False) -> uuid.UUID:
        async with self.Session() as s:
            conv = await _make_conversation(s, self.org, project, [self.author] if seat_author else [], self.author, conv_type=type)
            if project is None:
                await s.execute(text("UPDATE conversations SET project_id = NULL WHERE id = :c"), {"c": conv})
            if channel:
                await s.execute(text("UPDATE conversations SET is_project_channel = true WHERE id = :c"), {"c": conv})
            await s.commit()
        return conv

    async def map_to(self, conv, *, platform="slack", project=None):
        from app.models.bridge import BridgeChannelMapping, BridgeUserMapping

        async with self.Session() as s:
            s.add(BridgeChannelMapping(
                id=self.mapping_id, org_id=self.org, project_id=project or self.pa, platform=platform, channel_id=self.channel_id,
                config={"conversation_id": str(conv)},
            ))
            s.add(BridgeUserMapping(org_id=self.org, platform=platform, platform_user_id=EXTERNAL_USER, team_member_id=self.author))
            await s.commit()

    async def post(self, platform: str, monkeypatch=None):
        """one external message through the real entrance; returns (response, process_event mock, create_memo mock)."""
        from unittest.mock import patch

        from app.dependencies.database import get_db
        from app.main import app
        from app.repositories.bridge_inbound import BridgeInboundRepository
        from app.services import workflow_pipeline

        async def _db():
            async with self.Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        app.dependency_overrides[get_db] = _db
        pe, memo = AsyncMock(), AsyncMock(return_value="memo-id")
        try:
            with patch.object(workflow_pipeline, "process_event", pe), patch.object(BridgeInboundRepository, "create_memo", memo):
                async with _client_for(app) as c:
                    if platform == "slack":
                        body = json.dumps({
                            "type": "event_callback", "event_id": f"Ev{uuid.uuid4().hex[:8]}", "team_id": "T1",
                            "event": {"type": "message", "channel": self.channel_id, "user": EXTERNAL_USER, "text": WORDS, "ts": f"{time.time():.6f}"},
                        })
                        ts = str(int(time.time()))
                        sig = "v0=" + hmac.new(SECRET.encode(), f"v0:{ts}:{body}".encode(), hashlib.sha256).hexdigest()
                        r = await c.post("/api/v2/bridge/slack/events", content=body, headers={
                            "x-slack-signature": sig, "x-slack-request-timestamp": ts, "content-type": "application/json"})
                    else:
                        activity = {
                            "type": "message", "id": f"act-{uuid.uuid4().hex[:8]}", "text": WORDS, "serviceUrl": "https://smba.example/",
                            "from": {"aadObjectId": EXTERNAL_USER}, "conversation": {"id": self.channel_id},
                            "channelData": {"channel": {"id": self.channel_id}, "team": {"id": "T1"}},
                        }
                        with patch("app.routers.bridge.verify_teams_request", AsyncMock(return_value=True)):
                            r = await c.post("/api/v2/bridge/teams/events", json=activity)
        finally:
            app.dependency_overrides.clear()
        return r, pe, memo

    async def counts(self, conv) -> tuple[int, int]:
        async with self.Session() as s:
            m = (await s.execute(text("SELECT count(*) FROM conversation_messages WHERE conversation_id = :c"), {"c": conv})).scalar_one()
            p = (await s.execute(text("SELECT count(*) FROM conversation_participants WHERE conversation_id = :c AND member_id = :m"), {"c": conv, "m": self.author})).scalar_one()
        return m, p

    async def audit(self) -> list[dict]:
        async with self.Session() as s:
            rows = (await s.execute(text(
                "SELECT actor_id, action, metadata, created_at FROM permission_audit_logs WHERE org_id = :o AND action = 'bridge.inbound_skipped' ORDER BY created_at"), {"o": self.org})).all()
        return [{"actor": r[0], "action": r[1], "meta": r[2], "at": r[3]} for r in rows]


async def _world(*, agent_author: bool = False):
    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        pa = (await _make_project(s, org.id)).id
        pb = (await _make_project(s, org.id)).id
        if agent_author:
            author, user = await _make_agent_member(s, org.id, pa), None
        else:
            author, user = await _make_human_member(s, org.id, pa)
    return engine, _W(Session, org.id, pa, pb, author, user)


def _is_skip(r, platform, reason):
    assert r.status_code == 200, r.text
    body = r.json()
    result = body["data"] if platform == "slack" else body["result"]
    assert result == {"action": "skipped", "detail": reason}, body


PLATFORMS = ("slack", "teams")


@pytest.mark.parametrize("platform", PLATFORMS)
@pytest.mark.parametrize("kind", ["other_project_group", "no_project_group", "other_project_dm", "no_project_dm", "other_project_channel"])
async def test_01_a_room_the_mapping_project_does_not_own_is_skipped_with_nothing_written(platform, kind):
    engine, w = await _world()
    try:
        conv = await w.room(
            None if kind.startswith("no_project") else w.pb,
            type="dm" if "dm" in kind else "group", channel=kind.endswith("channel"),
        )
        await w.map_to(conv, platform=platform)
        r, pe, memo = await w.post(platform)
        _is_skip(r, platform, "conversation_project_mismatch")
        assert await w.counts(conv) == (0, 0), "a message or a seat was written in a room the mapping's project does not own"
        pe.assert_not_awaited()
        memo.assert_not_awaited()  # no fall to the retired memo path
        [row] = await w.audit()
        assert row["actor"] == w.author and row["meta"]["reason"] == "conversation_project_mismatch"
        assert row["meta"] == {
            "platform": platform, "mapping_id": str(w.mapping_id), "mapping_project_id": str(w.pa), "conversation_id": str(conv),
            "conversation_project_id": None if kind.startswith("no_project") else str(w.pb), "reason": "conversation_project_mismatch",
        }
        assert WORDS not in json.dumps(row["meta"]) and EXTERNAL_USER not in json.dumps(row["meta"])  # ids and the reason only
    finally:
        await engine.dispose()


@pytest.mark.parametrize("platform", PLATFORMS)
async def test_02_an_ordinary_room_of_the_same_project_is_as_before_the_author_joins_and_the_line_is_written(platform):
    engine, w = await _world()
    try:
        conv = await w.room(w.pa)
        await w.map_to(conv, platform=platform)
        r, pe, memo = await w.post(platform)
        assert r.status_code == 200, r.text
        result = r.json()["data"] if platform == "slack" else r.json()["result"]
        assert result["action"] == "conversation_message_created", r.json()
        assert await w.counts(conv) == (1, 1)  # the author joined by speaking — the existing product behaviour
        pe.assert_awaited_once()
        assert await w.audit() == []
    finally:
        await engine.dispose()


@pytest.mark.parametrize("platform", PLATFORMS)
async def test_03_a_channel_of_the_same_project_is_written_by_an_author_already_seated_who_holds_the_project(platform):
    engine, w = await _world()
    try:
        conv = await w.room(w.pa, channel=True, seat_author=True)
        await w.map_to(conv, platform=platform)
        r, pe, _memo = await w.post(platform)
        assert r.status_code == 200, r.text
        result = r.json()["data"] if platform == "slack" else r.json()["result"]
        assert result["action"] == "conversation_message_created", r.json()
        assert await w.counts(conv) == (1, 1)
        pe.assert_awaited_once()
        assert await w.audit() == []
    finally:
        await engine.dispose()


@pytest.mark.parametrize("platform", PLATFORMS)
async def test_04_a_channel_is_never_given_a_new_seat_by_the_bridge(platform):
    engine, w = await _world()
    try:
        conv = await w.room(w.pa, channel=True, seat_author=False)
        await w.map_to(conv, platform=platform)
        r, pe, memo = await w.post(platform)
        _is_skip(r, platform, "channel_author_not_seated")
        assert await w.counts(conv) == (0, 0)
        pe.assert_not_awaited()
        memo.assert_not_awaited()
        [row] = await w.audit()
        assert row["meta"]["reason"] == "channel_author_not_seated" and row["meta"]["conversation_project_id"] == str(w.pa)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("platform", PLATFORMS)
async def test_05_a_seated_author_who_lost_the_project_does_not_write_in_the_channel(platform):
    """an agent mapped as the author keeps its project PROFILE (so the mapping still finds it) after its grant is taken away: it is seated and no longer holds the project."""
    engine, w = await _world(agent_author=True)
    try:
        conv = await w.room(w.pa, channel=True, seat_author=True)
        await w.map_to(conv, platform=platform)
        async with w.Session() as s:
            await s.execute(text("DELETE FROM project_access WHERE project_id = :p AND member_id = :m"), {"p": w.pa, "m": w.author})
            await s.commit()
        r, pe, memo = await w.post(platform)
        _is_skip(r, platform, "channel_author_lost_project")
        assert await w.counts(conv) == (0, 1)  # seated before, not removed now, and nothing new written
        pe.assert_not_awaited()
        memo.assert_not_awaited()
        [row] = await w.audit()
        assert row["meta"]["reason"] == "channel_author_lost_project"
        # control: the same agent with its grant back writes
        async with w.Session() as s:
            from app.models.project_access import ProjectAccess

            s.add(ProjectAccess(id=uuid.uuid4(), project_id=w.pa, org_member_id=None, member_id=w.author, permission="granted", role="member"))
            await s.commit()
        r2, _pe2, _m2 = await w.post(platform)
        result = r2.json()["data"] if platform == "slack" else r2.json()["result"]
        assert result["action"] == "conversation_message_created", r2.json()
    finally:
        await engine.dispose()


async def test_06_one_audit_row_per_mapping_and_reason_in_an_hour_a_new_one_after_it_and_one_per_reason():
    engine, w = await _world()
    try:
        conv = await w.room(w.pb)
        await w.map_to(conv)
        for _ in range(3):
            r, _pe, _m = await w.post("slack")
            _is_skip(r, "slack", "conversation_project_mismatch")
        assert len(await w.audit()) == 1, "a busy channel wrote an audit row per line"
        # an hour has passed: the next skip is a row again
        async with w.Session() as s:
            await s.execute(text("UPDATE permission_audit_logs SET created_at = now() - interval '2 hours' WHERE org_id = :o AND action = 'bridge.inbound_skipped'"), {"o": w.org})
            await s.commit()
        await w.post("slack")
        assert len(await w.audit()) == 2
        # another mapping (another channel) of the same organization is its own row
        w2_channel = f"C{uuid.uuid4().hex[:10]}"
        from app.models.bridge import BridgeChannelMapping

        async with w.Session() as s:
            s.add(BridgeChannelMapping(org_id=w.org, project_id=w.pa, platform="slack", channel_id=w2_channel, config={"conversation_id": str(conv)}))
            await s.commit()
        w.channel_id = w2_channel
        w.mapping_id = None
        await w.post("slack")
        assert len(await w.audit()) == 3
    finally:
        await engine.dispose()


async def test_07_a_failing_audit_write_never_changes_the_answer(monkeypatch):
    engine, w = await _world()
    try:
        conv = await w.room(w.pb)
        await w.map_to(conv)
        from app.models.audit import AuditLog

        def boom(self, *a, **k):
            raise RuntimeError("audit write broke")

        monkeypatch.setattr(AuditLog, "__init__", boom)
        r, pe, memo = await w.post("slack")
        _is_skip(r, "slack", "conversation_project_mismatch")  # still 200 and still skipped
        assert await w.counts(conv) == (0, 0)
        pe.assert_not_awaited()
        memo.assert_not_awaited()
    finally:
        await engine.dispose()


async def test_08_a_skip_is_logged_with_ids_and_reason_and_no_words(caplog):
    engine, w = await _world()
    try:
        conv = await w.room(w.pb)
        await w.map_to(conv)
        import logging

        with caplog.at_level(logging.WARNING, logger="app.routers.bridge"):
            await w.post("slack")
        line = next(r.getMessage() for r in caplog.records if "bridge inbound skipped" in r.getMessage())
        for needle in ("platform=slack", f"mapping={w.mapping_id}", f"conversation={conv}", f"conversation_project={w.pb}", f"mapping_project={w.pa}", f"author={w.author}", "reason=conversation_project_mismatch"):
            assert needle in line, (needle, line)
        assert WORDS not in line and EXTERNAL_USER not in line
    finally:
        await engine.dispose()


async def test_09_the_old_refusals_are_as_they_were_a_missing_room_and_another_orgs_room_still_fall_to_the_memo_path():
    """not part of this change: a room that is missing or belongs to another organization keeps answering with the error (and the memo fallback that follows) — `test_4502` pins the org case at the helper."""
    engine, w = await _world()
    try:
        await w.map_to(uuid.uuid4())  # no such room
        r, pe, memo = await w.post("slack")
        memo.assert_awaited_once()  # the fallback ran, as before
        pe.assert_not_awaited()
        assert await w.audit() == []  # and no skip row: it is not a project mismatch
    finally:
        await engine.dispose()


async def test_10_the_audit_row_is_what_the_admins_audit_log_route_serves():
    """the trace has to be where an admin looks: `GET /api/v2/audit-logs` (and the MCP `list_audit_logs` on it) lists the organization's `permission_audit_logs` rows — the new action is accepted by the
    table's CHECK (migration 0503) and read back there."""
    engine, w = await _world()
    try:
        conv = await w.room(w.pb)
        await w.map_to(conv)
        await w.post("slack")
        from app.dependencies.auth import AuthContext, get_current_user
        from app.dependencies.database import get_db, get_read_db
        from app.main import app

        async def _db():
            async with w.Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_read_db] = _db
        app.dependency_overrides[get_current_user] = lambda: AuthContext(
            user_id=str(w.author_user), email="a@test", claims={"app_metadata": {"org_id": str(w.org)}})
        try:
            async with _client_for(app) as c:
                r = await c.get("/api/v2/audit-logs")
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 200, r.text
        rows = [x for x in r.json() if x["action"] == "bridge.inbound_skipped"]
        assert len(rows) == 1 and rows[0]["audit_metadata"]["reason"] == "conversation_project_mismatch", r.json()
    finally:
        await engine.dispose()


async def test_11_the_skip_commits_its_own_audit_row_whoever_calls_it():
    """the entrances' request session commits at its end, but the helper must not depend on that: called with a session nobody commits, the skip's audit row still lands (and still nothing else is written)."""
    from app.routers.bridge import _inbound_to_conversation

    engine, w = await _world()
    try:
        conv = await w.room(w.pb)
        async with w.Session() as s:
            result = await _inbound_to_conversation(
                s, conv, w.author, "x", None, message_ts="1.0", org_id=w.org, mapping_project_id=w.pa, mapping_id=w.mapping_id, platform="slack",
            )
        assert result == {"action": "skipped", "detail": "conversation_project_mismatch"}
        assert len(await w.audit()) == 1
        assert await w.counts(conv) == (0, 0)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("platform", PLATFORMS)
async def test_12_a_dm_of_the_mapping_project_is_skipped_too_no_third_person_is_seated(platform):
    engine, w = await _world()
    try:
        other, _other_user = None, None
        async with w.Session() as s:
            other, _other_user = await _make_human_member(s, w.org, w.pa)
            conv = await _make_conversation(s, w.org, w.pa, [other], other, conv_type="dm")  # a DM of two people (the author is not one of them), in the mapping's own project
        await w.map_to(conv, platform=platform)
        r, pe, memo = await w.post(platform)
        _is_skip(r, platform, "conversation_is_dm")
        assert await w.counts(conv) == (0, 0)  # no message, the author not seated
        async with w.Session() as s:
            n = (await s.execute(text("SELECT count(*) FROM conversation_participants WHERE conversation_id = :c"), {"c": conv})).scalar_one()
        assert n == 1, "the DM got a participant it did not have"
        pe.assert_not_awaited()
        memo.assert_not_awaited()
        [row] = await w.audit()
        assert row["meta"]["reason"] == "conversation_is_dm" and row["meta"]["conversation_project_id"] == str(w.pa)
        # the same words in a plain group room of that project are still written (control)
        group = await w.room(w.pa)
        async with w.Session() as s:  # the same mapping now names the group room
            await s.execute(text("UPDATE messaging_bridge_channels SET config = jsonb_build_object('conversation_id', CAST(:c AS text)) WHERE id = :m"), {"c": str(group), "m": w.mapping_id})
            await s.commit()
        r2, _pe, _m = await w.post(platform)
        result = r2.json()["data"] if platform == "slack" else r2.json()["result"]
        assert result["action"] == "conversation_message_created", r2.json()
    finally:
        await engine.dispose()
