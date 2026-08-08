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


async def _make_approval(
    session, org_id, project_id, *, step_run_id, approver_member_id, status="pending", approval_group_id=None,
):
    from app.models.workflow_line import WorkflowLineStepApproval

    approval = WorkflowLineStepApproval(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        step_run_id=step_run_id, approval_group_id=approval_group_id or uuid.uuid4(),
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


async def test_waiting_on_others_absent_when_i_am_quorum_approver_among_others_realdb():
    """story #2527(까심 QA 확認 대기, PO 오르테가 AC 락 2026-08-08): 내가 assignee 이면서
    동시에 쿼럼(멀티어프루버) gate의 pending blocking 승인자 중 한 명이면 — 다른 승인자의
    pending row가 waiting_on_others를 오노출시키면 안 된다(내 승인 행동이 실제로 남아있으므로
    gate_approval로만 떠야 한다). quorum_policy.type(all/any/count) 무관하게 동일해야 한다 —
    개별 approver row의 pending 여부는 quorum 집계 타입과 무관한 축이기 때문.

    ⛔뮤테이션 자가검증(2026-08-08): command_center.py의 `~exists(_my_pending_approval_on_step)`
    가드를 실제로 지우고 이 테스트를 돌려 RED 確認함(waiting_on_others에 이 story가 새는 것을
    직접 관측 — 재현조건 그대로) → 복원 → GREEN 재확認."""
    from app.main import app

    for qtype in ("all", "any", "count"):
        engine, Session = await _session_factory()
        try:
            async with Session() as s:
                org = await _make_org(s)
                project = await _make_project(s, org.id)
                caller_id, caller_user_id = await _make_member(s, org.id, project.id)
                other_id, _ = await _make_member(s, org.id, project.id)
                story = await _make_story(s, org.id, project.id, title=f"QuorumIAmApprover-{qtype}")
                story.assignee_id = caller_id
                await s.commit()
                run = await _make_step_run(s, org.id, project.id, entity_type="story", entity_id=story.id)
                run.quorum_policy = {"type": qtype, "count": 2 if qtype == "count" else None}
                await s.commit()
                group_id = uuid.uuid4()
                await _make_approval(
                    s, org.id, project.id, step_run_id=run.id, approver_member_id=caller_id,
                    approval_group_id=group_id,
                )
                await _make_approval(
                    s, org.id, project.id, step_run_id=run.id, approver_member_id=other_id,
                    approval_group_id=group_id,
                )

            await _setup_app_human(app, Session, caller_user_id, org.id)
            client = _client_for(app)
            try:
                resp = await client.get("/api/v2/command-center/my-actions")
                assert resp.status_code == 200, resp.text
                items = resp.json()["action_queue"]["items"]
                assert not any(
                    i["type"] == "waiting_on_others" and i["context"]["story_id"] == str(story.id)
                    for i in items
                ), f"quorum type={qtype}: waiting_on_others falsely surfaced (story #2527 regression)"
                assert any(i["type"] == "gate_approval" for i in items), (
                    f"quorum type={qtype}: gate_approval missing — my own pending approval should still surface there"
                )
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


# ─── BE 명세1(태스크 줄)·명세2(무게)·명세5(담당 판정 확장) — 2026-07-29 ────────────


async def _make_task(session, org_id, story_id, *, assignee_id=None, title="Task", status="todo"):
    from app.models.pm import Task

    task = Task(
        id=uuid.uuid4(), org_id=org_id, story_id=story_id, assignee_id=assignee_id,
        title=title, status=status,
    )
    session.add(task)
    await session.commit()
    return task


async def _make_dependency(session, org_id, *, from_id, to_id, dep_type="blocks", item_type="story"):
    from app.models.dependency import ItemDependency

    dep = ItemDependency(
        id=uuid.uuid4(), org_id=org_id, from_id=from_id, to_id=to_id,
        dep_type=dep_type, item_type=item_type,
    )
    session.add(dep)
    await session.commit()
    return dep


async def test_my_task_shows_for_incomplete_assigned_task_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Parent")
            task = await _make_task(s, org.id, story.id, assignee_id=caller_id, title="구현", status="in-progress")
            # 양성대조: done task는 안 뜬다.
            await _make_task(s, org.id, story.id, assignee_id=caller_id, title="이미끝남", status="done")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            my_tasks = [i for i in items if i["type"] == "my_task"]
            assert len(my_tasks) == 1
            assert my_tasks[0]["context"]["task_id"] == str(task.id)
            assert my_tasks[0]["context"]["story_id"] == str(story.id)
            assert my_tasks[0]["context"]["story_title"] == "Parent"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_review_merge_now_includes_non_in_review_assigned_stories_realdb():
    """BE 명세5: status=='in-review' 하나가 아니라 done 아닌 전체로 넓어졌는지 실PG로 확인."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            in_progress_story = await _make_story(s, org.id, project.id, title="InProgress")
            in_progress_story.assignee_id = caller_id
            in_progress_story.status = "in-progress"
            done_story = await _make_story(s, org.id, project.id, title="Done")
            done_story.assignee_id = caller_id
            done_story.status = "done"
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            review_story_ids = {i["context"]["story_id"] for i in items if i["type"] == "review_merge"}
            assert str(in_progress_story.id) in review_story_ids
            assert str(done_story.id) not in review_story_ids
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_review_merge_excludes_story_blocked_by_open_dependency_realdb():
    """BE 명세5 「선행 대기」 제외 — 아직 안 풀린 blocks 의존성이 있으면 review_merge에서 빠진다.
    양성대조: blocker가 done이면(선행이 풀렸으면) 다시 뜬다.

    ⛔뮤테이션 자가검증(2026-07-29, PO 지시 — "없으면 「제외했다」가 주장"): command_center.py의
    `~exists(_blocked_by_open_dependency)` 조건을 실제로 지우고 이 테스트를 돌려 RED 확認함
    (blocked_story.id가 review_story_ids에 새는 것을 직접 관측) → 복원 → GREEN 재확認."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            blocked_story = await _make_story(s, org.id, project.id, title="Blocked")
            blocked_story.assignee_id = caller_id
            blocked_story.status = "in-progress"
            open_blocker = await _make_story(s, org.id, project.id, title="OpenBlocker")
            open_blocker.status = "in-progress"
            await s.commit()
            await _make_dependency(s, org.id, from_id=open_blocker.id, to_id=blocked_story.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            review_story_ids = {i["context"]["story_id"] for i in items if i["type"] == "review_merge"}
            assert str(blocked_story.id) not in review_story_ids

            # 양성대조: blocker를 done으로 풀면 다시 뜬다.
            from sqlalchemy import select as sa_select
            from app.models.pm import Story as StoryModel

            async with Session() as s2:
                res = await s2.execute(sa_select(StoryModel).where(StoryModel.id == open_blocker.id))
                row = res.scalar_one()
                row.status = "done"
                await s2.commit()

            resp2 = await client.get("/api/v2/command-center/my-actions")
            assert resp2.status_code == 200, resp2.text
            items2 = resp2.json()["action_queue"]["items"]
            review_story_ids2 = {i["context"]["story_id"] for i in items2 if i["type"] == "review_merge"}
            assert str(blocked_story.id) in review_story_ids2
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_gate_approval_waiting_count_quorum_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            other_id, _ = await _make_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="QuorumGate")
            run = await _make_step_run(s, org.id, project.id, entity_type="story", entity_id=story.id)
            group_id = uuid.uuid4()
            await _make_approval(
                s, org.id, project.id, step_run_id=run.id, approver_member_id=caller_id,
                approval_group_id=group_id,
            )
            await _make_approval(
                s, org.id, project.id, step_run_id=run.id, approver_member_id=other_id,
                approval_group_id=group_id,
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            ga = next(i for i in items if i["type"] == "gate_approval")
            assert ga["context"]["waiting_count_approx"] == 1  # 나 제외 1명 더.
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_my_blockers_waiting_count_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            blocker = await _make_story(s, org.id, project.id, title="MultiBlocker")
            blocker.assignee_id = caller_id
            blocked_a = await _make_story(s, org.id, project.id, title="A")
            blocked_a.status = "in-progress"
            blocked_b = await _make_story(s, org.id, project.id, title="B")
            blocked_b.status = "in-progress"
            await s.commit()
            await _make_dependency(s, org.id, from_id=blocker.id, to_id=blocked_a.id)
            await _make_dependency(s, org.id, from_id=blocker.id, to_id=blocked_b.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["action_queue"]["items"]
            my_blockers_items = [i for i in items if i["type"] == "my_blockers"]
            assert len(my_blockers_items) == 2  # 여전히 blocked story당 한 항목(변경 없음).
            assert all(i["context"]["waiting_count_approx"] == 2 for i in my_blockers_items)  # 무게는 공유.
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
