"""story #4350 PR 2 — project 필터 없는 목록 · 집계 라우트가 같은 org 안 **접근 권한 없는 프로젝트**의 내용을 싣지 않는다.

부류 전수(PR 본문 표)에서 새던 자리 + PO 판정(2026-09-26 · SEC-S8 선생님 확정 «org-level = 갭»이 상위 규칙):
activity-stream · activity-logs · dashboard · session-context · exclusion · loop-measure-due · standups · team-members(에이전트
active_story) · merge-gate(명시 project_id) · command-center attention.

한 시드: project A · B, 부르는 사람은 A에만 grant. B 쪽 모든 행에 «SECRET-B» 표지, A 쪽엔 «VISIBLE-A» — 응답 글 전체에서
B 표지가 0이고 A 표지는 남는지(모양이 달라도 같은 판정)를 본다.
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta

import pytest

from tests.test_1994_backlink_api_realdb import _make_agent_member
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_e_security_sec_s8_g_cross_project_access_realdb import _REAL_DB_URL, _session_factory

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_PAST = datetime(2020, 1, 1, tzinfo=UTC)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed(s) -> dict:
    from app.models.activity_event import ActivityEvent
    from app.models.activity_log import ActivityLog
    from app.models.hypothesis import Hypothesis
    from app.models.organization import Organization
    from app.models.pm import Goal, Story, Task
    from app.models.project import Project
    from app.models.standup import StandupEntry, StandupEntryProject

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.commit()
    pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    s.add_all([pa, pb])
    await s.commit()
    caller_member, caller_user = await _make_member(s, org.id, pa.id)  # 사람 · project A에만
    # 일하는 에이전트 둘: 하나는 A 스토리, 하나는 B 스토리를 «지금 하는 스토리»로.
    agent_a = await _make_agent_member(s, org.id, pa.id)
    agent_b = await _make_agent_member(s, org.id, pb.id)

    story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=pa.id, title="VISIBLE-A-story", story_points=21, assignee_id=agent_a)
    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=pb.id, title="SECRET-B-story", story_points=21, assignee_id=agent_a)
    s.add_all([story_a, story_b])
    await s.commit()
    s.add_all([
        Task(id=uuid.uuid4(), org_id=org.id, story_id=story_a.id, title="VISIBLE-A-task", assignee_id=agent_a),
        Task(id=uuid.uuid4(), org_id=org.id, story_id=story_b.id, title="SECRET-B-task", assignee_id=agent_a),
    ])
    # «지금 하는 스토리»는 agent_project_profiles에 산다(team_members 뷰가 거기서 읽는다).
    from sqlalchemy import update

    from app.models.member import AgentProjectProfile

    for agent, story in ((agent_a, story_a), (agent_b, story_b)):
        await s.execute(update(AgentProjectProfile).where(AgentProjectProfile.member_id == agent).values(active_story_id=story.id))
    now = datetime.now(UTC)
    for proj, mark in ((pa, "VISIBLE-A"), (pb, "SECRET-B")):
        s.add(ActivityEvent(
            org_id=org.id, project_id=proj.id, verb="story.updated", occurred_at=now,
            payload={"marker": f"{mark}-event"}, dedup_key=f"{mark}-{uuid.uuid4()}",
        ))
        s.add(ActivityLog(
            org_id=org.id, project_id=proj.id, actor_type="human", action="story.updated", context={"marker": f"{mark}-log"},
        ))
        s.add(Hypothesis(
            org_id=org.id, project_id=proj.id, owner_member_id=caller_member, statement=f"{mark}-hypothesis",
            metric_definition={"metric": "m", "source": "db", "target": 1, "direction": "increase"},
            measure_after=_PAST, status="active",
        ))
        s.add(Goal(id=uuid.uuid4(), org_id=org.id, project_id=proj.id, title=f"{mark}-goal", status="active", measure_after=_PAST))
    s.add(ActivityLog(org_id=org.id, project_id=None, actor_type="platform", action="org.setting", context={"marker": "VISIBLE-ORG-log"}))
    await s.commit()
    entries = {}
    for key, proj, mark in (("a", pa, "VISIBLE-A"), ("b", pb, "SECRET-B"), ("none", None, "VISIBLE-ORG")):
        e = StandupEntry(
            id=uuid.uuid4(), org_id=org.id, project_id=proj.id if proj else None, author_id=agent_a if key != "none" else agent_b,
            date=date.today() - timedelta(days={"a": 0, "b": 1, "none": 2}[key]), done=f"{mark}-standup",
        )
        s.add(e)
        await s.flush()
        if proj is not None:
            s.add(StandupEntryProject(id=uuid.uuid4(), entry_id=e.id, project_id=proj.id, org_id=org.id))
        entries[key] = e.id
    await s.commit()
    return {"org": org.id, "pa": pa.id, "pb": pb.id, "user": caller_user, "agent_a": agent_a}


async def _call(Session, seeded, path):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read
    from app.main import app

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(
            user_id=str(seeded["user"]), email="h@test",
            claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            return await c.get(path)
    finally:
        app.dependency_overrides.clear()


@asynccontextmanager
async def _world():
    """엔진은 테스트 본문의 이벤트 루프에서 만든다(async fixture로 만들면 다른 루프에 묶인다)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        yield Session, seeded
    finally:
        await engine.dispose()


@pytest.mark.parametrize("route,visible", [
    ("/api/v2/activity-stream", "VISIBLE-A-event"),
    ("/api/v2/activity-logs", "VISIBLE-A-log"),
    ("/api/v2/loop-measure-due/queue", "VISIBLE-A-hypothesis"),
    ("/api/v2/standups", "VISIBLE-A-standup"),
    ("/api/v2/command-center/my-actions", "VISIBLE-A-hypothesis"),
    ("/api/v2/team-members?type=agent", "VISIBLE-A-story"),
    ("/api/v2/team-presence", "VISIBLE-A-story"),
    ("/api/v2/dashboard?member_id={agent_a}", "VISIBLE-A-task"),
    ("/api/v2/session-context?member_id={agent_a}", "VISIBLE-A-task"),
])
async def test_no_project_filter_shows_only_accessible_projects(route, visible):
    async with _world() as (Session, seeded):
        resp = await _call(Session, seeded, route.format(agent_a=seeded["agent_a"]))
        assert resp.status_code == 200, resp.text[:500]
        assert "SECRET-B" not in resp.text, f"{route}: 접근 권한 없는 프로젝트(B)의 내용이 응답에 있다"
        assert visible in resp.text, f"{route}: 접근 가능한 프로젝트(A)의 내용은 그대로 나와야 한다(회귀 0)"


async def test_org_level_rows_without_a_project_stay_visible():
    """프로젝트에 매이지 않은 org 수준 행(활동 로그 · 스탠드업)은 어느 프로젝트의 내용도 아니라 그대로 보인다."""
    async with _world() as (Session, seeded):
        logs = await _call(Session, seeded, "/api/v2/activity-logs")
        standups = await _call(Session, seeded, "/api/v2/standups")
        assert "VISIBLE-ORG-log" in logs.text
        assert "VISIBLE-ORG-standup" in standups.text


@pytest.mark.parametrize("route", [
    "/api/v2/exclusion/dry-run?project_id={pb}",
    "/api/v2/merge-gate/metrics?project_id={pb}",
])
async def test_explicit_inaccessible_project_is_404(route):
    async with _world() as (Session, seeded):
        resp = await _call(Session, seeded, route.format(pb=seeded["pb"]))
        assert resp.status_code == 404, resp.text[:300]
        assert "SECRET-B" not in resp.text


async def test_exclusion_counts_only_accessible_projects():
    """exclusion 리포트는 제목 목록(50점 이상 — stories_sp_check 상한 21이라 지금은 비어 있음)보다 **수**를 싣는다 —
    총계 · 담당자 분포가 접근 불가 프로젝트를 세면 존재가 샌다."""
    async with _world() as (Session, seeded):
        resp = await _call(Session, seeded, "/api/v2/exclusion/dry-run")
        assert resp.status_code == 200, resp.text[:300]
        body = resp.json()
        assert body["total_stories"] == 1, body
        assert sum(d["count"] for d in body["assignee_distribution"]) == 1, body


async def test_merge_gate_org_totals_drop_only_inaccessible_project_gates():
    """PO 판정(2026-09-26) — 무필터 집계: 전체 접근(owner)은 옛 수 그대로 · 제한 구성원은 B 몫만 빠짐 · 어느 프로젝트에도 안 걸린
    org 수준 게이트는 둘 다 센다(수로 접근 불가 프로젝트의 존재가 새지 않게)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.pm import Story
    from app.models.project import OrgMember
    from app.models.user import User

    async with _world() as (Session, seeded):
        async with Session() as s:
            stories = {st.project_id: st.id for st in (await s.execute(select(Story).where(Story.org_id == seeded["org"]))).scalars()}
            for wtype, wid in (("story", stories[seeded["pa"]]), ("story", stories[seeded["pb"]]), ("wf_line_version", uuid.uuid4())):
                s.add(Gate(
                    id=uuid.uuid4(), org_id=seeded["org"], work_item_id=wid, work_item_type=wtype,
                    gate_type="merge", status="auto_passed", neutral_facts={},
                ))
            owner_uid = uuid.uuid4()
            s.add(User(id=owner_uid, email=f"o-{owner_uid.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            s.add(OrgMember(id=uuid.uuid4(), org_id=seeded["org"], user_id=owner_uid, role="owner"))
            await s.commit()

        restricted = await _call(Session, seeded, "/api/v2/merge-gate/metrics")
        full = await _call(Session, {**seeded, "user": owner_uid}, "/api/v2/merge-gate/metrics")
        assert restricted.status_code == 200 and full.status_code == 200, (restricted.text, full.text)
        assert full.json()["trustworthy_merge_throughput"] == 3, "전체 접근은 옛 수 그대로(A + B + org 수준)"
        assert restricted.json()["trustworthy_merge_throughput"] == 2, "제한 구성원은 B 몫만 빠진다(A + org 수준)"
