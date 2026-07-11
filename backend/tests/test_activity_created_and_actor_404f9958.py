"""404f9958: 활동로그 actor_name 미해석 + 생성 이벤트 미기록 회귀 가드.

- Bug1: list_activity_logs가 actor_name을 lookup_members_by_ids(canonical/legacy+user.email)로
  해소한다(직접 team_members 조회 → canonical 휴먼 누락 → '시스템' 표시 회귀 차단).
- Bug2: story/sprint/doc 생성이 record_created_activity로 {entity}_created 활동을 큐잉한다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── Bug2: record_created_activity ────────────────────────────────────────────

class _FakeBG:
    def __init__(self):
        self.tasks: list[tuple] = []

    def add_task(self, fn, **kwargs):
        self.tasks.append((fn, kwargs))


def _resolved(actor_id, org_id, name="x", mtype="human"):
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(
        id=actor_id, user_id=None, name=name, type=mtype,
        role="member", org_id=org_id, project_id=None,
    )


@pytest.mark.anyio
@pytest.mark.parametrize("entity_type", ["story", "sprint", "doc"])
async def test_record_created_activity_queues_created_event(monkeypatch, entity_type):
    from app.services import activity_log as mod

    actor, org, proj, eid = (uuid.uuid4() for _ in range(4))

    async def _fake_resolve(auth, org_id, db):
        return _resolved(actor, org_id)

    monkeypatch.setattr("app.services.member_resolver.resolve_member", _fake_resolve)

    bg = _FakeBG()
    await mod.record_created_activity(
        bg, auth=MagicMock(), org_id=org, db=AsyncMock(),
        entity_type=entity_type, entity_id=eid, project_id=proj, title="T",
    )

    assert len(bg.tasks) == 1
    fn, kw = bg.tasks[0]
    assert fn is mod.record_activity_bg
    assert kw["action"] == f"{entity_type}_created"
    assert kw["actor_id"] == actor
    assert kw["entity_type"] == entity_type
    assert kw["entity_id"] == eid
    assert kw["project_id"] == proj
    assert kw["context"] == {"title": "T"}


@pytest.mark.anyio
async def test_record_created_activity_best_effort_on_resolve_failure(monkeypatch):
    """actor 해석 실패해도 이벤트는 큐잉(best-effort) — 생성 이벤트 누락 0."""
    from app.services import activity_log as mod

    async def _boom(auth, org_id, db):
        raise RuntimeError("resolve down")

    monkeypatch.setattr("app.services.member_resolver.resolve_member", _boom)

    bg = _FakeBG()
    eid = uuid.uuid4()
    await mod.record_created_activity(
        bg, auth=MagicMock(), org_id=uuid.uuid4(), db=AsyncMock(),
        entity_type="story", entity_id=eid, project_id=uuid.uuid4(), title=None,
    )

    assert len(bg.tasks) == 1
    _, kw = bg.tasks[0]
    assert kw["action"] == "story_created"
    assert kw["actor_id"] is None          # 해석 실패 → None 이나 이벤트는 기록
    assert kw["context"] == {}             # title 없음 → {}


# ── Bug1: list_activity_logs actor_name 해소 ─────────────────────────────────

@pytest.mark.anyio
@pytest.mark.parametrize("actor_type,resolved_name", [
    ("human", "alice@example.com"),   # 휴먼: user.email로 정합
    ("agent", "디디 은와추쿠"),         # 에이전트: member name — canonical 경로가 둘 다 커버
])
async def test_list_activity_logs_resolves_actor_name_via_member_resolver(
    monkeypatch, actor_type, resolved_name,
):
    from app.models.activity_log import ActivityLog
    from app.routers import activity_logs as router

    org, actor, eid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    log = ActivityLog(
        id=uuid.uuid4(), org_id=org, project_id=uuid.uuid4(),
        actor_id=actor, actor_type=actor_type, action="story_created",
        entity_type="story", entity_id=eid, context={},
        created_at=datetime.now(tz=timezone.utc),
    )

    count_res = MagicMock()
    count_res.scalar_one.return_value = 1
    items_res = MagicMock()
    items_res.scalars.return_value.all.return_value = [log]
    entity_res = MagicMock()
    entity_res.all.return_value = [SimpleNamespace(id=eid, title="My Story")]

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[count_res, items_res, entity_res])

    # canonical actor(휴먼/에이전트): actor_id가 team_members.id와 달라도 anchor resolver가
    # 이름을 해소(휴먼=user.email, 에이전트=member name).
    async def _fake_lookup(ids, session):
        return {actor: _resolved(actor, org, name=resolved_name, mtype=actor_type)}

    monkeypatch.setattr("app.services.member_resolver.lookup_members_by_ids", _fake_lookup)

    resp = await router.list_activity_logs(
        project_id=None, actor_id=None, action=None, entity_type=None,
        entity_id=None, from_=None, to=None, limit=30, offset=0,
        db=db, org_id=org, auth=MagicMock(user_id=str(uuid.uuid4())),
    )

    assert resp.total == 1
    assert len(resp.items) == 1
    assert resp.items[0].actor_name == resolved_name   # '시스템'/null 아님 — 휴먼·에이전트 공통
    assert resp.items[0].entity_title == "My Story"
