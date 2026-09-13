"""story #3823(UX-v3·오늘·BE 1, 페드루 PO 確定 2026-09-13) — ``GET /api/v2/today``
실PG 검증. PO 결정(갈림①): Gate·HitlRequest(agent_hitl_requests)·
WorkflowLineStepApproval 3계를 모델로 합치지 않고 이 route가 읽기 전용으로만
합류시킨다 — 핵심 검증축:
①needs_me = 3계 합집합, 같은 (work_item_type, work_item_id, gate_type) 1행
②kind·risk 매핑 4경로 ③merge gate 행 title 채움 ④agent_progress 위임/참여 필터
⑤published_today 채널별 집계·tz 자정 경계 ⑥usage.platform 연결 N개에 쿼리 수 고정.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _make_org(session, name="Org3823"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org3823-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        status="backlog", description="", acceptance_criteria="",
    )
    session.add(story)
    await session.commit()
    return story


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _make_member(session, org_id, project_id, *, type_="human", org_role="member", name="member"):
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=org_role)
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type=type_, user_id=user.id, name=name)
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_gate(
    session, org_id, *, work_item_type, work_item_id, gate_type, status="pending", pr_number=None,
):
    from app.models.gate import Gate

    g = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type=work_item_type,
        gate_type=gate_type, status=status, pr_number=pr_number,
    )
    session.add(g)
    await session.commit()
    return g


async def _make_hitl_request(session, org_id, project_id, *, story_id, work_type="done", status="pending"):
    from app.models.hitl import HitlRequest

    r = HitlRequest(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=uuid.uuid4(),
        request_type="gate_approval", title="승인 필요", prompt="사람 승인이 필요합니다.",
        requested_for=uuid.uuid4(), status=status,
        hitl_metadata={"work_item_id": str(story_id), "work_type": work_type},
    )
    session.add(r)
    await session.commit()
    return r


async def _make_step_run(
    session, org_id, project_id, *, entity_type, entity_id, effective_gate_type="qa",
    risk_snapshot=None,
):
    from app.models.workflow_line import WorkflowLineStepRun

    run = WorkflowLineStepRun(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        entity_type=entity_type, entity_id=entity_id,
        from_status="in-review", to_status="done", status="pending", mode="enforcing",
        effective_gate_type=effective_gate_type, correlation_id=uuid.uuid4(),
        transition_id=uuid.uuid4().hex, risk_snapshot=risk_snapshot or {},
    )
    session.add(run)
    await session.commit()
    return run


async def _make_workflow_approval(
    session, org_id, project_id, *, step_run_id, approver_member_id, requested_by_member_id=None,
    status="pending",
):
    from app.models.workflow_line import WorkflowLineStepApproval

    a = WorkflowLineStepApproval(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        step_run_id=step_run_id, approval_group_id=uuid.uuid4(),
        approver_member_id=approver_member_id, approver_member_type="human",
        requested_by_member_id=requested_by_member_id,
        kind="approver", blocking=True, status=status,
    )
    session.add(a)
    await session.commit()
    return a


async def _make_channel_connection(session, org_id, *, channel="youtube", account_id=None):
    from app.models.channel_connection import ChannelConnection

    c = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", credential_kind="oauth",
    )
    session.add(c)
    await session.commit()
    return c


async def _make_publication_command(
    session, org_id, *, destination, status="completed", updated_at=None,
):
    from app.models.publication_command import PublicationCommand

    pc = PublicationCommand(
        id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), destination=destination,
        approved_version=uuid.uuid4(), status=status, requested_by_member_id=uuid.uuid4(),
        updated_at=updated_at or datetime.now(timezone.utc),
    )
    session.add(pc)
    await session.commit()
    return pc


async def _make_agent_run(session, org_id, project_id, *, agent_id, story_id, status="running"):
    from app.models.agent_run import AgentRun

    run = AgentRun(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=agent_id,
        story_id=story_id, status=status,
    )
    session.add(run)
    await session.commit()
    return run


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="human@test", claims={"app_metadata": {"org_id": str(org_id)}})

    # story #2451 가드(get_db만 걸고 get_read_db를 빠뜨리는 재발 클래스) — raw
    # dependency_overrides[get_db]=... 직접 대입 금지, 이 헬퍼 하나로만 건다.
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def test_needs_me_unions_three_sources_and_collapses_duplicate_realdb():
    """AC2 — gate 2(같은 story 재오픈 흉내, pr_number만 다름·같은 일 취급) + hitl 1
    + workflow 1 → needs_me 3·needs_me_count 3."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")

            merge_story = await _make_story(s, org.id, project.id, title="머지 대상 스토리")
            await _make_gate(
                s, org.id, work_item_type="story", work_item_id=merge_story.id,
                gate_type="merge", pr_number=1,
            )
            await _make_gate(
                s, org.id, work_item_type="story", work_item_id=merge_story.id,
                gate_type="merge", pr_number=2,
            )

            hitl_story = await _make_story(s, org.id, project.id, title="HITL 대상 스토리")
            await _make_hitl_request(s, org.id, project.id, story_id=hitl_story.id)

            wf_story = await _make_story(s, org.id, project.id, title="워크플로 대상 스토리")
            run = await _make_step_run(s, org.id, project.id, entity_type="story", entity_id=wf_story.id)
            await _make_workflow_approval(s, org.id, project.id, step_run_id=run.id, approver_member_id=caller_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["needs_me_count"] == 3
            assert len(body["needs_me"]) == 3
            sources = sorted(item["source"] for item in body["needs_me"])
            assert sources == ["gate", "hitl", "workflow_step"]
            merge_items = [i for i in body["needs_me"] if i["work_item"]["id"] == str(merge_story.id)]
            assert len(merge_items) == 1, "같은 (work_item_type, work_item_id, gate_type)이 접히지 않았다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_needs_me_dedupe_keeps_gate_and_hitl_of_same_story_separate_by_kind_realdb():
    """정정 1(페드루 PO 리뷰, PR #4250) — 같은 story에 merge gate(kind=approval)와
    merge 단계 HITL 질문(kind=answer)이 함께 있으면 dedupe 키가 gate_type만
    보던 시절엔 (story, id, "merge") 한 키로 접혀 하나가 사라졌다. kind를 키에
    더해 승인/답변 축을 분리 — needs_me 2건(approval 1·answer 1) 모두 남아야
    한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")

            story = await _make_story(s, org.id, project.id, title="같은 스토리·다른 손")
            await _make_gate(s, org.id, work_item_type="story", work_item_id=story.id, gate_type="merge")
            await _make_hitl_request(s, org.id, project.id, story_id=story.id, work_type="merge")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            same_story_items = [i for i in body["needs_me"] if i["work_item"]["id"] == str(story.id)]
            kinds = sorted(i["kind"] for i in same_story_items)
            assert kinds == ["answer", "approval"], (
                f"gate_type만으로 dedupe하면 kind가 달라도 접혀 하나가 사라진다: {kinds}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_needs_me_kind_and_risk_mapping_four_paths_realdb():
    """AC3 — external_publish→signature/high, 그 외 gate→approval/low, hitl→answer/low,
    workflow_step(고위험 표시)→approval/high 4경로."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")

            ext_story = await _make_story(s, org.id, project.id, title="외부발행")
            await _make_gate(s, org.id, work_item_type="story", work_item_id=ext_story.id, gate_type="external_publish")

            merge_story = await _make_story(s, org.id, project.id, title="머지")
            await _make_gate(s, org.id, work_item_type="story", work_item_id=merge_story.id, gate_type="merge")

            hitl_story = await _make_story(s, org.id, project.id, title="답변대상")
            await _make_hitl_request(s, org.id, project.id, story_id=hitl_story.id)

            wf_story = await _make_story(s, org.id, project.id, title="고위험워크플로")
            run = await _make_step_run(
                s, org.id, project.id, entity_type="story", entity_id=wf_story.id,
                effective_gate_type="qa", risk_snapshot={"high_risk": True},
            )
            await _make_workflow_approval(s, org.id, project.id, step_run_id=run.id, approver_member_id=caller_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            items = resp.json()["needs_me"]
            by_work_item = {i["work_item"]["id"]: i for i in items}

            ext = by_work_item[str(ext_story.id)]
            assert ext["kind"] == "signature" and ext["risk"] == "high"

            merge = by_work_item[str(merge_story.id)]
            assert merge["kind"] == "approval" and merge["risk"] == "low"

            hitl = by_work_item[str(hitl_story.id)]
            assert hitl["kind"] == "answer" and hitl["risk"] == "low"
            assert hitl["actions"] == ["answer"]

            wf = by_work_item[str(wf_story.id)]
            assert wf["kind"] == "approval" and wf["risk"] == "high"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_merge_gate_item_title_filled_realdb():
    """AC4 — merge gate 행도 story 제목이 채워진다(빈 title 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            story = await _make_story(s, org.id, project.id, title="제목 확認용 스토리")
            await _make_gate(s, org.id, work_item_type="story", work_item_id=story.id, gate_type="merge")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            items = resp.json()["needs_me"]
            item = next(i for i in items if i["work_item"]["id"] == str(story.id))
            assert item["work_item"]["title"] == "제목 확認용 스토리"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_agent_progress_shows_only_delegated_or_owned_stories_realdb():
    """AC5 — caller가 assignee_id 또는 human_owner_member_id인 story의 진행 中
    agent_run만 노출. 양성대조: 무관 story·완료된 run은 제외."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")

            my_story = await _make_story(s, org.id, project.id, title="내 스토리")
            my_story.assignee_id = caller_id
            other_story = await _make_story(s, org.id, project.id, title="남의 스토리")
            await s.commit()

            my_run = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="running")
            await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=other_story.id, status="running")
            await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="completed")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            progress = resp.json()["agent_progress"]
            assert len(progress) == 1
            assert progress[0]["run_id"] == str(my_run.id)
            assert progress[0]["work_item"]["id"] == str(my_story.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_published_today_aggregates_by_channel_within_tz_boundary_realdb():
    """AC6 — tz 기준 오늘 자정 이후 완료 건만·채널별 집계. 양성대조: 어제(tz 기준) 완료·
    미완료 상태는 제외."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")

            yt_conn = await _make_channel_connection(s, org.id, channel="youtube")
            wp_conn = await _make_channel_connection(s, org.id, channel="wordpress")

            now = datetime.now(timezone.utc)
            await _make_publication_command(s, org.id, destination=yt_conn.id, status="completed", updated_at=now)
            await _make_publication_command(s, org.id, destination=wp_conn.id, status="completed", updated_at=now)
            # 양성대조: 어제 완료(tz=UTC 기준 26시간 전 — 확실히 어제) → 제외.
            await _make_publication_command(
                s, org.id, destination=yt_conn.id, status="completed",
                updated_at=now - timedelta(hours=26),
            )
            # 양성대조: 오늘이지만 미완료 → 제외.
            await _make_publication_command(s, org.id, destination=yt_conn.id, status="pending", updated_at=now)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today", params={"tz": "UTC"})
            assert resp.status_code == 200, resp.text
            pub = resp.json()["published_today"]
            assert pub["count"] == 2
            by_channel = {row["channel_kind"]: row["count"] for row in pub["by_channel"]}
            assert by_channel == {"youtube": 1, "wordpress": 1}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_usage_platform_query_count_fixed_regardless_of_connection_count_realdb():
    """AC7 — youtube 연결이 N개여도 플랫폼 사용량 조회(get_platform_youtube_quota_spent_units)는
    distinct 채널 종류 수만큼만(이 테스트에선 1회) 호출된다 — N+1 없음."""
    from app.main import app
    from app.services import youtube_quota as youtube_quota_module

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            for _ in range(3):
                await _make_channel_connection(s, org.id, channel="youtube")
            # 사용량 개념이 없는 채널 — usage.platform에서 빠져야 한다.
            await _make_channel_connection(s, org.id, channel="wordpress")

        call_count = 0
        _orig = youtube_quota_module.get_platform_youtube_quota_spent_units

        async def _counting(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return await _orig(*args, **kwargs)

        youtube_quota_module.get_platform_youtube_quota_spent_units = _counting
        try:
            await _setup_app_human(app, Session, caller_user_id, org.id)
            client = _client_for(app)
            try:
                resp = await client.get("/api/v2/today")
                assert resp.status_code == 200, resp.text
                platform = resp.json()["usage"]["platform"]
                assert len(platform) == 3  # 연결 3개(wordpress는 usage 개념 없어 제외).
                assert all(row["channel_kind"] == "youtube" for row in platform)
                used_values = {row["used"] for row in platform}
                assert len(used_values) == 1, "같은 플랫폼 카운터인데 연결마다 값이 다르다"
                assert resp.json()["usage"]["ad_spend"] == {"measured": False}
            finally:
                await client.aclose()
        finally:
            youtube_quota_module.get_platform_youtube_quota_spent_units = _orig
        assert call_count == 1, f"distinct 채널 종류(youtube 1개)보다 많이 호출됐다: {call_count}회"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
