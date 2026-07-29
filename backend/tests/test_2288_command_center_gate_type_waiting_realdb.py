"""story #2288(E-CONNECT) BE 명세3+4(2026-07-29, 미르코 명세·PO 강조 — 이 스토리의 심장) —
GET /api/v2/command-center/my-actions의 두 신규 조각을 실PG로 검증한다. 기존
test_command_center.py는 mock 세션이라 SQLAlchemy 조인 문법 자체가 유효한지는 증명하지
못한다(모킹된 session.execute는 실제로 쿼리를 실행하지 않는다) — 이 파일이 그 공백을 메운다.

명세3: gate_approval 항목의 context.gate_type이 WorkflowLineStepRun.effective_gate_type을
  그대로 실어 나른다(새 값 발명 없음, step_run_id 조인).
명세4: 「내 것인데 남이 잡음」 — 내가 담당(assignee)인 story의 워크플로 라인에 pending
  blocking 승인이 있는데 approver가 내가 아니면 waiting_on_others(§3-1㉢, 버튼 없음)로 뜬다.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_2301_story_body_mentions_realdb import (
    _REAL_DB_URL,
    _client_for,
    _make_org,
    _make_project,
    _make_story,
    _session_factory,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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


async def _make_member(session, org_id, project_id, *, type_="human"):
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type=type_, user_id=user.id, name="Human")
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_step_run(session, org_id, project_id, *, entity_type, entity_id, status="pending"):
    from app.models.workflow_line import WorkflowLineStepRun

    run = WorkflowLineStepRun(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        entity_type=entity_type, entity_id=entity_id,
        from_status="in-review", to_status="done", status=status, mode="enforcing",
        effective_gate_type="merge", correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
    )
    session.add(run)
    await session.commit()
    return run


async def _make_approval(session, org_id, project_id, *, step_run_id, approver_member_id, status="pending"):
    from app.models.workflow_line import WorkflowLineStepApproval

    approval = WorkflowLineStepApproval(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        step_run_id=step_run_id, approval_group_id=uuid.uuid4(),
        approver_member_id=approver_member_id, approver_member_type="human",
        kind="approver", blocking=True, status=status,
    )
    session.add(approval)
    await session.commit()
    return approval


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

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

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def test_gate_approval_carries_gate_type_from_step_run_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Gated")
            run = await _make_step_run(s, org.id, project.id, entity_type="story", entity_id=story.id)
            await _make_approval(s, org.id, project.id, step_run_id=run.id, approver_member_id=caller_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            ga = next(i for i in items if i["type"] == "gate_approval")
            assert ga["context"]["gate_type"] == "merge"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_waiting_on_others_shows_when_assignee_but_approver_is_someone_else_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            other_id, _ = await _make_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="MyStoryWaitingOnOther")
            story.assignee_id = caller_id
            await s.commit()
            run = await _make_step_run(s, org.id, project.id, entity_type="story", entity_id=story.id)
            await _make_approval(s, org.id, project.id, step_run_id=run.id, approver_member_id=other_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            w = next(i for i in items if i["type"] == "waiting_on_others")
            assert w["context"]["story_id"] == str(story.id)
            assert w["context"]["gate_type"] == "merge"
            assert w["context"]["approver_member_id"] == str(other_id)
            assert w["priority"] == "info"
            # ⭐양성대조: 승인 대기가 «나에게» 있으면 gate_approval로 뜨지 waiting_on_others로
            # 안 뜬다(§3-1㉠ vs ㉢ 구분 — 발이 나한테 있으면 행동 항목).
            assert not any(i["type"] == "waiting_on_others" and i["context"]["story_id"] == str(story.id)
                            for i in items if i.get("context", {}).get("approver_member_id") == str(caller_id))
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_waiting_on_others_absent_when_i_am_the_approver_realdb():
    """⛔뮤테이션 성격 양성대조: 내가 담당이면서 «내가 approver»인 경우엔 waiting_on_others가
    안 뜬다(발이 나한테 있다 — gate_approval만 떠야 한다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="MyStoryIAmApprover")
            story.assignee_id = caller_id
            await s.commit()
            run = await _make_step_run(s, org.id, project.id, entity_type="story", entity_id=story.id)
            await _make_approval(s, org.id, project.id, step_run_id=run.id, approver_member_id=caller_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            assert not any(i["type"] == "waiting_on_others" for i in items)
            assert any(i["type"] == "gate_approval" for i in items)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_waiting_on_others_absent_when_not_assignee_realdb():
    """양성대조: 담당이 아니면(§3-1㉢ 전제 자체가 성립 안 함) waiting_on_others도 안 뜬다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            other_assignee_id, _ = await _make_member(s, org.id, project.id)
            approver_id, _ = await _make_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="NotMyStory")
            story.assignee_id = other_assignee_id
            await s.commit()
            run = await _make_step_run(s, org.id, project.id, entity_type="story", entity_id=story.id)
            await _make_approval(s, org.id, project.id, step_run_id=run.id, approver_member_id=approver_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            assert not any(i["type"] == "waiting_on_others" for i in items)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_waiting_on_others_dedupes_multi_approver_quorum_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            other_a, _ = await _make_member(s, org.id, project.id)
            other_b, _ = await _make_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="QuorumStory")
            story.assignee_id = caller_id
            await s.commit()
            run = await _make_step_run(s, org.id, project.id, entity_type="story", entity_id=story.id)
            await _make_approval(s, org.id, project.id, step_run_id=run.id, approver_member_id=other_a)
            await _make_approval(s, org.id, project.id, step_run_id=run.id, approver_member_id=other_b)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            matches = [i for i in items if i["type"] == "waiting_on_others" and i["context"]["story_id"] == str(story.id)]
            assert len(matches) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
