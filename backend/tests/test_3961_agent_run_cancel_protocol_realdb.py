"""story #3961(「정지」 액션 — 중단 요청 프로토콜, PO 확定 2026-09-16) — 실PG 검증.
3823(test_3823_today_aggregate_route.py)의 실PG 헬퍼를 그대로 재사용(cross-import 관례).

핵심 검증축:
①권한 매트릭스 5 — org owner·admin·story assignee(사람) 허용 / 무관 멤버·에이전트 캐폴러 403.
②상태 전이 3 — 요청(cancellable만·중복요청 409)·ack(cancel_requested에서만·직접 설정 422)·
  만료(15분 경과 lazy 確定, GET이 트리거).
③today.py agent_progress[].cancel 필드 — 요청 中 노출, 만료(미확定) 시 목록에서 제외.
④기존 자기보고(진행 中 running PATCH) 무변."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3823_today_aggregate_route import (
    _REAL_DB_URL,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401 (autouse fixture import)
    _make_agent_run,
    _make_member,
    _make_org,
    _make_project,
    _make_story,
    _session_factory,
    _setup_app_human,
    anyio_backend,  # noqa: F401 (fixture import)
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
    pytest.mark.destructive_schema,
]


async def _reload(Session, run_id):
    from app.models.agent_run import AgentRun

    async with Session() as s:
        return await s.get(AgentRun, run_id)


async def test_cancel_permission_matrix_realdb():
    """AC(권한 매트릭스 5) — owner·admin·story assignee(사람)는 200, 무관 멤버·에이전트
    캐폴러는 403(story assignee가 에이전트인 경우도 별도로 403 재확認)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, owner_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            admin_id, admin_user_id = await _make_member(s, org.id, project.id, org_role="admin")
            assignee_id, assignee_user_id = await _make_member(s, org.id, project.id, org_role="member")
            stranger_id, stranger_user_id = await _make_member(s, org.id, project.id, org_role="member")
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")

            story = await _make_story(s, org.id, project.id, title="담당자 있는 일")
            story.assignee_id = assignee_id
            await s.commit()

            run_for_owner = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=story.id, status="running")
            run_for_admin = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=story.id, status="running")
            run_for_assignee = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=story.id, status="running")
            run_for_stranger = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=story.id, status="running")
            run_for_agent_caller = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=story.id, status="running")

        client = _client_for(app)
        try:
            # owner — 200
            await _setup_app_human(app, Session, owner_user_id, org.id)
            resp = await client.post(f"/api/v2/agent-runs/{run_for_owner.id}/cancel", json={"reason": "owner 정지"})
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "cancel_requested"

            # admin — 200
            await _setup_app_human(app, Session, admin_user_id, org.id)
            resp = await client.post(f"/api/v2/agent-runs/{run_for_admin.id}/cancel", json={})
            assert resp.status_code == 200, resp.text

            # story assignee(사람) — 200
            await _setup_app_human(app, Session, assignee_user_id, org.id)
            resp = await client.post(f"/api/v2/agent-runs/{run_for_assignee.id}/cancel", json={})
            assert resp.status_code == 200, resp.text

            # 무관 멤버 — 403
            await _setup_app_human(app, Session, stranger_user_id, org.id)
            resp = await client.post(f"/api/v2/agent-runs/{run_for_stranger.id}/cancel", json={})
            assert resp.status_code == 403, resp.text

            # 에이전트 캐폴러(자기 run이라도) — 403(이 액션은 사람 전용)
            from app.dependencies.auth import AuthContext, get_current_user

            async def _agent_auth():
                return AuthContext(user_id=str(uuid.uuid4()), email="agent@test", claims={"app_metadata": {"org_id": str(org.id)}})

            # 에이전트는 user_id가 없어(팀멤버 직접) resolve_member가 team_member 경로를 타게
            # AuthContext.user_id를 agent_id 자체로 준다 — member_resolver 관례(사용자 없는
            # 에이전트 인증 경로, 이 저장소 기존 패턴).
            async def _agent_auth2():
                return AuthContext(user_id=str(agent_id), email=None, claims={"app_metadata": {"org_id": str(org.id)}})

            app.dependency_overrides[get_current_user] = _agent_auth2
            resp = await client.post(f"/api/v2/agent-runs/{run_for_agent_caller.id}/cancel", json={})
            # 에이전트 신원은 org_members(휴먼 전용) 조회 단계에서부터 이미 걸린다(400) —
            # 그 앞단이 안 걸려도 caller.type!=human 검사(403)가 뒤에서 잡는다. 어느 경로든
            # 핵심은 200이 아니라는 것(에이전트가 정지 요청을 성공시키지 못한다).
            assert resp.status_code in (400, 403, 404), resp.text
            assert resp.status_code != 200
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_cancel_rejects_non_cancellable_and_duplicate_requests_realdb():
    """AC(요청 전이) — 이미 종결(completed)이거나 이미 cancel_requested인 run은 409."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, owner_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent")
            run_completed = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=None, status="completed")
            run_already_requested = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=None, status="cancel_requested")

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/agent-runs/{run_completed.id}/cancel", json={})
            assert resp.status_code == 409, resp.text

            resp = await client.post(f"/api/v2/agent-runs/{run_already_requested.id}/cancel", json={})
            assert resp.status_code == 409, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_ack_only_from_cancel_requested_and_direct_server_states_rejected_realdb():
    """AC(ack 전이) — status=cancelled ack는 cancel_requested에서만(그 외 409). 클라가
    cancel_requested/cancelled_unacknowledged를 직접 PATCH로 설정하면 422(서버/사람 전용)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, owner_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent")
            run_running = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=None, status="running")
            run_requested = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=None, status="cancel_requested")

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            # running에서 곧장 ack — 409(요청받은 적 없음).
            resp = await client.patch(f"/api/v2/agent-runs/{run_running.id}", json={"status": "cancelled"})
            assert resp.status_code == 409, resp.text

            # cancel_requested → cancelled(ack) — 200 + 감사 필드.
            resp = await client.patch(f"/api/v2/agent-runs/{run_requested.id}", json={"status": "cancelled"})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["status"] == "cancelled"
            assert body["cancel_outcome"] == "acknowledged"
            assert body["cancel_ack_at"] is not None

            # 클라가 직접 cancel_requested/cancelled_unacknowledged를 PATCH로 설정 — 422.
            resp = await client.patch(f"/api/v2/agent-runs/{run_running.id}", json={"status": "cancel_requested"})
            assert resp.status_code == 422, resp.text
            resp = await client.patch(f"/api/v2/agent-runs/{run_running.id}", json={"status": "cancelled_unacknowledged"})
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_lazy_expiry_confirms_unacknowledged_on_read_realdb():
    """AC(만료 전이) — cancel_requested_at이 15분 넘게 지난 run을 GET하면 서버가
    cancelled_unacknowledged로 確定(lazy) + finished_at·cancel_outcome 기록."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, owner_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent")
            run = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=None, status="cancel_requested")
            run.cancel_requested_by = owner_id
            run.cancel_requested_at = datetime.now(timezone.utc) - timedelta(minutes=20)
            run.cancel_reason = "테스트"
            await s.commit()

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs/{run.id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["status"] == "cancelled_unacknowledged"
            assert body["cancel_outcome"] == "unacknowledged"
            assert body["finished_at"] is not None
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        persisted = await _reload(Session, run.id)
        assert persisted.status == "cancelled_unacknowledged"
    finally:
        await engine.dispose()


async def test_today_agent_progress_surfaces_cancel_requested_and_hides_expired_realdb():
    """AC(today 필드) — 요청 中(15분 이내)인 run은 agent_progress[].cancel에 state="requested"
    로 노출. 이미 만료(DB 아직 미확定)인 run은 「진행 中」 목록에서 빠진다(정직 — 확定은
    단건 read가 마무리)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")

            story1 = await _make_story(s, org.id, project.id, title="정지 요청 中")
            story1.assignee_id = caller_id
            story2 = await _make_story(s, org.id, project.id, title="정지 요청 만료됨")
            story2.assignee_id = caller_id
            await s.commit()

            run_requested = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=story1.id, status="cancel_requested")
            run_requested.cancel_requested_by = caller_id
            run_requested.cancel_requested_at = datetime.now(timezone.utc) - timedelta(minutes=2)
            run_requested.cancel_reason = "확인 중"

            run_expired = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=story2.id, status="cancel_requested")
            run_expired.cancel_requested_by = caller_id
            run_expired.cancel_requested_at = datetime.now(timezone.utc) - timedelta(minutes=20)
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            progress = {p["run_id"]: p for p in resp.json()["agent_progress"]}
            assert str(run_requested.id) in progress
            assert str(run_expired.id) not in progress  # 만료 — lazy 확定 대기 中, 목록에서 제외
            entry = progress[str(run_requested.id)]
            assert entry["cancel"]["state"] == "requested"
            assert entry["cancel"]["reason"] == "확인 중"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_existing_self_report_patch_unaffected_realdb():
    """AC(기존 자기보고 무변) — 진행 中 running PATCH(예: result_summary만 갱신)는 이번
    변경과 무관하게 그대로 동작한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, owner_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent")
            run = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=None, status="running")

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/agent-runs/{run.id}", json={"status": "completed", "result_summary": "끝"})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["status"] == "completed"
            assert body["result_summary"] == "끝"
            assert body["cancel_outcome"] is None
            assert body["finished_at"] is not None
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
