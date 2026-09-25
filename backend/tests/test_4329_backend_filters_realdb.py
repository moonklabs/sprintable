"""story #4329 PR B — MCP가 보내던 거름 셋을 백엔드가 실제로 읽는다(전엔 조용히 버려 전체 목록이 왔다).

- `GET /api/v2/stories?priority=` — MCP `list_stories`.
- `GET /api/v2/stories?no_assignee=true` — MCP `get_unassigned_stories`(예전엔 모르는 이름 `unassigned`를 보내 **스토리 전부**가 왔다).
  정의는 응답의 `assignee_ids`와 같다: 복수 담당 join(`story_assignees`) 행 0 · 레거시 `assignee_id` 비어 있음.
- `GET /api/v2/notifications?type=` — MCP `check_notifications`.

스토리 목록은 분기가 셋(제네릭 · board(status) · backlog(no_sprint))이라 #2188 부류(분기가 바뀌며 필터가 사라짐)를 막으려
세 분기 모두에서 같은 결과를 확인한다.
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from tests.test_2188_board_branch_filter_drop_realdb import _call_list_stories, _session_factory
from tests.test_e_security_sec_s8_ratchet_round7_activity_logs_stream_realdb import (
    _client_for,
    _setup_app,
)
from tests.test_e_security_sec_s8_ratchet_round7_activity_logs_stream_realdb import (
    _session_factory as _http_session_factory,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _seed_stories(session):
    """우선순위 × 담당 상태 네 가지. 전부 같은 project · backlog · sprint 없음(세 분기 모두 네 건이 보이는 조건)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.story_assignee import StoryAssignee

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted"))
    await session.commit()

    def story(title, priority, assignee_id=None, n=0):
        return Story(
            id=uuid.uuid4(), org_id=org.id, project_id=project.id, title=title, status="backlog",
            priority=priority, assignee_id=assignee_id, story_number=n,
        )

    high_nobody = story("high-nobody", "high", n=1)
    high_legacy = story("high-legacy-assignee", "high", assignee_id=agent.id, n=2)  # 레거시 단일 담당만
    low_join = story("low-join-assignee", "low", n=3)  # 복수 담당 join 행만(assignee_id 비어 있음)
    low_nobody = story("low-nobody", "low", n=4)
    session.add_all([high_nobody, high_legacy, low_join, low_nobody])
    await session.commit()
    session.add(StoryAssignee(id=uuid.uuid4(), org_id=org.id, story_id=low_join.id, member_id=agent.id))
    await session.commit()
    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id}


_BRANCHES = {
    "generic": {},
    "board": {"status_filter": "backlog"},
    "backlog": {"no_sprint": True},
}


@pytest.mark.parametrize("branch", list(_BRANCHES))
async def test_priority_and_no_assignee_narrow_in_every_list_branch(branch):
    """뮤테이션: 한 분기에서 넘기기를 빼면 그 분기만 RED(#2188 부류) · `_no_assignee_clause`에서 join 조건을 빼면 low-join이 섞여 RED ·
    레거시 조건을 빼면 high-legacy가 섞여 RED."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_stories(s)
        async with Session() as s:
            async def titles(**extra):
                rows = await _call_list_stories(
                    s, w["org_id"], w["agent_id"], project_id=w["project_id"], **_BRANCHES[branch], **extra,
                )
                return sorted(r.title for r in rows)

            everything = await titles()
            assert everything == ["high-legacy-assignee", "high-nobody", "low-join-assignee", "low-nobody"], "거름 없으면 전부(회귀 0)"
            assert await titles(priority="high") == ["high-legacy-assignee", "high-nobody"]
            assert await titles(no_assignee=True) == ["high-nobody", "low-nobody"]
            assert await titles(priority="high", no_assignee=True) == ["high-nobody"]
            assert await titles(no_assignee=False) == everything
    finally:
        await engine.dispose()


async def test_priority_outside_the_four_values_is_a_422_and_the_http_path_reads_both_filters():
    """HTTP 경로(쿼리 이름 · Literal 검증까지). MCP가 실제로 보내는 이름 그대로 — `priority` · `no_assignee=true`."""
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    engine, Session = await _http_session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()
            user_id = uuid.uuid4()
            s.add(User(id=user_id, email=f"s-{user_id.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="member")
            s.add(om)
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted", role="member"))
            for title, priority in (("h", "high"), ("l", "low")):
                await s.execute(
                    text("INSERT INTO stories (id, org_id, project_id, title, status, priority) VALUES (:id, :org, :pid, :t, 'backlog', :p)"),
                    {"id": uuid.uuid4(), "org": org.id, "pid": project.id, "t": title, "p": priority},
                )
            await s.commit()
        await _setup_app(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            base = f"/api/v2/stories?project_id={project.id}"
            r = await client.get(f"{base}&priority=high")
            assert r.status_code == 200, r.text
            assert [x["title"] for x in r.json()] == ["h"]
            r = await client.get(f"{base}&no_assignee=true")
            assert sorted(x["title"] for x in r.json()) == ["h", "l"]
            assert (await client.get(f"{base}&priority=urgent")).status_code == 422
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── 알림 type ───────────────────────────────────────────────────────────────────────────────────────
async def test_notifications_type_filter_narrows_and_combines_with_unread():
    from app.dependencies.auth import AuthContext
    from app.repositories.notification import NotificationRepository
    from app.routers.notifications import list_notifications

    org, user = uuid.uuid4(), uuid.uuid4()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            await s.execute(text("INSERT INTO organizations (id,name,slug,plan) VALUES (:id,'O',:slug,'free')"), {"id": org, "slug": f"n4329-{org.hex[:8]}"})
            await s.execute(text(
                "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
                "VALUES (:id,:email,'x','N',true,true,0,false,0)"
            ), {"id": user, "email": f"n4329-{user.hex[:8]}@test.com"})
            base = datetime(2026, 9, 1, tzinfo=UTC)
            for i, (kind, read) in enumerate((("mention", False), ("gate", False), ("mention", True), ("mention", False))):
                await s.execute(text(
                    "INSERT INTO notifications (id,org_id,user_id,type,title,is_read,created_at) VALUES (:id,:org,:user,:t,:title,:r,:at)"
                ), {"id": uuid.uuid4(), "org": org, "user": user, "t": kind, "title": f"{kind}-{i}", "r": read, "at": base + timedelta(seconds=i)})
            await s.commit()
        auth = AuthContext(user_id=str(user), email=None, claims={"app_metadata": {"org_id": str(org)}}, org_id=str(org))

        async def titles(**kw):
            async with Session() as s:
                page = await list_notifications(
                    unread=kw.get("unread"), is_read=None, limit=50, before=None, type_filter=kw.get("type"),
                    db=s, auth=auth, repo=NotificationRepository(s, org),
                )
            return [n.title for n in page["data"]]

        assert await titles() == ["mention-3", "mention-2", "gate-1", "mention-0"], "거름 없으면 전부(회귀 0)"
        assert await titles(type="mention") == ["mention-3", "mention-2", "mention-0"]
        assert await titles(type="gate") == ["gate-1"]
        assert await titles(type="mention", unread=True) == ["mention-3", "mention-0"]
        assert await titles(type="nothing-like-this") == []
    finally:
        await engine.dispose()
