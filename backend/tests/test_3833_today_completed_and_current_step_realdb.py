"""story #3833(UX-v3·오늘·BE 2, 페드루 PO 判定 2026-09-13) — ``GET /api/v2/today``
2갭 처방 실PG 검증. 3823(story #3823/test_3823_today_aggregate_route.py)의 실PG
헬퍼(``_session_factory``/``_make_org``/``_make_project``/``_make_story``/
``_client_for``/``_make_member``/``_make_agent_run``/``_setup_app_human``)를 그대로
재사용(cross-import 관례, 이 저장소 기존 선례 그대로) — 이 파일은 3833 전용 픽스처
(tool-call·completed-run·conversation)만 추가한다.

핵심 검증축:
①current_step = agent_run_tool_calls 최신 1건(없으면 null)·배치 쿼리 1
②completed_today = 오늘(tz 자정 이후) 종료·참여 필터(agent_progress와 동일 술어)
③completed_today.conversation_id = 캐폴러 참여 검증 통과 시만
④「정지」— 신규 API 0, 기존 PATCH 전이(update_agent_run) 그대로 재사용됨을 pin."""
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


async def _finish_run(session, run, *, status="completed", finished_at=None, result_summary=None, conversation_id=None):
    run.status = status
    run.finished_at = finished_at or datetime.now(timezone.utc)
    run.result_summary = result_summary
    run.conversation_id = conversation_id
    await session.commit()
    return run


async def _make_tool_call(session, org_id, agent_id, run_id, *, tool, started_at):
    from app.models.agent_run_tool_call import AgentRunToolCall

    c = AgentRunToolCall(
        id=uuid.uuid4(), org_id=org_id, agent_id=agent_id, run_id=run_id,
        tool=tool, method="POST", path="/api/v2/x", status_code=200,
        duration_ms=10, started_at=started_at, attribution_reason="header",
    )
    session.add(c)
    await session.commit()
    return c


async def _shadow_team_member(session, org_id, project_id, member_id, *, type_="human", name="m"):
    """team_members는 prod에서 members ⋈ project_access VIEW(0088, app/models/team.py
    주석 근거)라 `Base.metadata.create_all()`(이 파일의 디스포저블 스키마)에서는 빈
    평범한 테이블로 잡힌다 — conversation_participants.member_id FK가 이 테이블을
    가리켜서, ConversationParticipant를 직접 INSERT하는 테스트는 그 id로 이 그림자
    행을 먼저 심어야 한다(_make_member가 이미 만든 members/project_access와 별개—
    실 뷰의 투영을 이 디스포저블 스키마에서 손으로 흉내)."""
    from app.models.team import TeamMember

    session.add(TeamMember(id=member_id, org_id=org_id, project_id=project_id, type=type_, name=name))
    await session.commit()


async def _make_conversation(session, org_id, project_id, *, member_ids):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="group")
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv


async def test_completed_today_terminal_runs_today_and_participation_realdb():
    """AC2 — 오늘 종료·참여 필터. 양성대조 3(진행 中·어제 종료·비참여 story)은 전부 제외."""
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

            done_today = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="running")
            await _finish_run(s, done_today, result_summary="완료 요약")

            still_running = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="running")

            done_yesterday = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="running")
            await _finish_run(s, done_yesterday, finished_at=datetime.now(timezone.utc) - timedelta(hours=26))

            not_mine = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=other_story.id, status="running")
            await _finish_run(s, not_mine)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today", params={"tz": "UTC"})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            completed = body["completed_today"]
            assert len(completed) == 1, completed
            item = completed[0]
            assert item["run_id"] == str(done_today.id)
            assert item["result_summary"] == "완료 요약"
            assert item["work_item"]["id"] == str(my_story.id)
            assert item["status"] == "completed"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_completed_today_conversation_id_only_when_participant_realdb():
    """AC3 — conversation_id는 캐폴러가 실제 참여자인 대화만(비참여=null, 죽은 링크·
    DM 존재 노출 방지 원칙, agent_progress와 동일)."""
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
            await s.commit()

            await _shadow_team_member(s, org.id, project.id, caller_id, type_="human", name="캐폴러")
            await _shadow_team_member(s, org.id, project.id, agent_id, type_="agent", name="에이전트")

            participant_conv = await _make_conversation(s, org.id, project.id, member_ids=[caller_id])
            non_participant_conv = await _make_conversation(s, org.id, project.id, member_ids=[agent_id])

            run_in_conv = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="running")
            await _finish_run(s, run_in_conv, conversation_id=participant_conv.id)

            run_not_participant = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="running")
            await _finish_run(s, run_not_participant, conversation_id=non_participant_conv.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today", params={"tz": "UTC"})
            assert resp.status_code == 200, resp.text
            by_run = {i["run_id"]: i for i in resp.json()["completed_today"]}
            assert by_run[str(run_in_conv.id)]["conversation_id"] == str(participant_conv.id)
            assert by_run[str(run_not_participant.id)]["conversation_id"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_current_step_last_tool_call_name_or_null_batch_one_query_realdb():
    """AC1 — current_step = 그 run의 마지막 도구 호출 이름(없으면 null)·배치 쿼리 1
    (run 개수와 무관, N+1 0)."""
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
            await s.commit()

            run_with_calls = await _make_agent_run(
                s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="running",
            )
            now = datetime.now(timezone.utc)
            await _make_tool_call(s, org.id, agent_id, run_with_calls.id, tool="search_stories", started_at=now - timedelta(minutes=5))
            await _make_tool_call(s, org.id, agent_id, run_with_calls.id, tool="update_story", started_at=now)

            run_without_calls = await _make_agent_run(
                s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="running",
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)

        call_count = 0

        def _count_tool_call_queries(conn, cursor, statement, parameters, context, executemany):
            nonlocal call_count
            if "agent_run_tool_calls" in statement:
                call_count += 1

        from sqlalchemy import event

        event.listen(engine.sync_engine, "before_cursor_execute", _count_tool_call_queries)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            by_run = {i["run_id"]: i for i in resp.json()["agent_progress"]}
            assert by_run[str(run_with_calls.id)]["current_step"] == "update_story"
            assert by_run[str(run_without_calls.id)]["current_step"] is None
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _count_tool_call_queries)
            await client.aclose()
        assert call_count == 1, f"run 개수(2)와 무관하게 배치 쿼리는 1이어야 한다: {call_count}회"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_stop_via_existing_patch_transition_realdb():
    """AC4 — 「정지」신규 API 0 확認 pin. 기존 PATCH /api/v2/agent-runs/{id}
    (status=abandoned)가 사람 손으로도 그대로 도달 가능함을 잠근다(PO 判定
    2026-09-13 — abandoned=사람이 멈춘 것, 신규 상태값·신규 route 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")

            my_story = await _make_story(s, org.id, project.id, title="정지 대상")
            my_story.assignee_id = caller_id
            await s.commit()

            run = await _make_agent_run(s, org.id, project.id, agent_id=agent_id, story_id=my_story.id, status="running")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/agent-runs/{run.id}", json={"status": "abandoned"})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["status"] == "abandoned"
            assert body["finished_at"] is not None, "터미널 전이는 서버가 finished_at을 채운다(story #2161)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
