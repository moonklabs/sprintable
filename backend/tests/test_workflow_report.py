"""report-done API 단위 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
AGENT_ID = uuid.UUID("9cac9d96-5474-45f7-941e-787407597b52")

_PO_ID = uuid.UUID("05f52181-ea2a-42be-b9a8-9a418b72feb1")
_DEV_ID = uuid.UUID("9cac9d96-5474-45f7-941e-787407597b52")
_QA_ID = uuid.UUID("685f3f72-c85c-4a32-898f-3d3320ba39ad")


def _mock_story(status: str = "in-progress") -> MagicMock:
    s = MagicMock()
    s.id = STORY_ID
    s.org_id = ORG_ID
    s.project_id = PROJECT_ID
    s.title = "테스트 스토리"
    s.status = status
    return s


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(AGENT_ID)
    ctx.email = "agent@test.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    ctx.org_id = str(ORG_ID)

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_invalid_stage_400():
    """유효하지 않은 stage는 400 반환."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/workflow/report-done", json={
                "story_id": str(STORY_ID),
                "stage": "invalid_stage",
                "agent_id": str(AGENT_ID),
            })
        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_story_not_found_404():
    """존재하지 않는 story_id는 404 반환."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.post("/api/v2/workflow/report-done", json={
                "story_id": str(uuid.uuid4()),
                "stage": "kickoff",
                "agent_id": str(AGENT_ID),
            })
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_kickoff_to_dev():
    """kickoff 완료 → 스토리 in-progress 전환, memo_id=None."""
    client, session, app = await _client()
    try:
        story = _mock_story(status="ready-for-dev")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = story

            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json={
                    "story_id": str(STORY_ID),
                    "stage": "kickoff",
                    "agent_id": str(AGENT_ID),
                })

        assert resp.status_code == 200
        data = resp.json()
        assert data["completed_stage"] == "kickoff"
        assert data["next_stage"] == "dev"
        assert data["story_status"] == "in-progress"
        assert data["memo_id"] is None
        mock_update.assert_called_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_s20_line_active_blocks_non_merge_transition():
    """⭐S20: line engine 이 비-merge 전이를 enforcing 차단하면 report-done 도 409(LINE_BLOCKED).
    default-off 면 line 이 plain→proceeds 라 기존 동작 유지(무회귀)는 기존 stage 테스트가 입증."""
    from app.services.workflow_line_engine import LineDecision
    client, session, app = await _client()
    try:
        story = _mock_story(status="ready-for-dev")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)
        blocked = LineDecision(mode="blocked_by_policy", status_to_apply=None,
                               blocking_reason="workflow line blocks", http_status=409)
        with patch("app.services.workflow_line_engine.evaluate_line_for_transition",
                   new=AsyncMock(return_value=blocked)):
            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json={
                    "story_id": str(STORY_ID), "stage": "kickoff", "agent_id": str(AGENT_ID)})
        # ⭐비-merge 전이가 line enforcing 으로 차단됨(409). 에러 envelope 변형 대비 텍스트로 검증.
        assert resp.status_code == 409 and "LINE_BLOCKED" in resp.text
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dev_to_review():
    """dev 완료 → 스토리 in-review 전환, memo_id=None."""
    client, session, app = await _client()
    try:
        story = _mock_story(status="in-progress")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = story

            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json={
                    "story_id": str(STORY_ID),
                    "stage": "dev",
                    "agent_id": str(AGENT_ID),
                })

        assert resp.status_code == 200
        data = resp.json()
        assert data["completed_stage"] == "dev"
        assert data["next_stage"] == "review"
        assert data["story_status"] == "in-review"
        assert data["memo_id"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_merge_to_done():
    """H1-S4: merge 완료 + 게이트 auto_merge → 스토리 done 전환(게이트 통과 시에만)."""
    from app.services.merge_verdict_gate import AUTO_MERGE, MergeGateDecision

    client, session, app = await _client()
    try:
        story = _mock_story(status="in-review")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        auto = MergeGateDecision(
            decision=AUTO_MERGE, reason="ok", gate_id=uuid.uuid4(),
            gate_status="auto_passed", disposition="allow_auto", trust=0.9, ci_result="pass",
        )
        with patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock) as mock_update, \
             patch("app.routers.workflow_report.evaluate_merge_gate", new=AsyncMock(return_value=auto)), \
             patch("app.routers.workflow_report._record_gate_evidence", new=AsyncMock()), \
             patch("app.routers.workflow_report.merge_gate_active", return_value=True):
            mock_update.return_value = story
            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json={
                    "story_id": str(STORY_ID),
                    "stage": "merge",
                    "agent_id": str(AGENT_ID),
                    "context": {"pr_number": 12, "repo": "o/r", "ci_result": "pass", "pr_result": "pass"},
                })

        assert resp.status_code == 200
        data = resp.json()
        assert data["completed_stage"] == "merge" and data["next_stage"] == "done"
        assert data["story_status"] == "done" and data["gate_decision"] == "auto_merge"
        mock_update.assert_called_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_context_field_accepted():
    """context 필드를 포함한 요청이 정상 처리된다."""
    client, session, app = await _client()
    try:
        story = _mock_story()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock, return_value=story):
            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json={
                    "story_id": str(STORY_ID),
                    "stage": "dev",
                    "agent_id": str(AGENT_ID),
                    "context": {"pr_url": "https://github.com/moonklabs/sprintable/pull/999"},
                })

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_all_valid_stages():
    """모든 유효 stage가 400 없이 처리된다(merge는 게이트 auto_merge로 200)."""
    from app.routers.workflow_report import _VALID_STAGES
    from app.services.merge_verdict_gate import AUTO_MERGE, MergeGateDecision

    auto = MergeGateDecision(
        decision=AUTO_MERGE, reason="ok", gate_id=None,
        gate_status="auto_passed", disposition="allow_auto", trust=0.9, ci_result="pass",
    )
    for stage in _VALID_STAGES:
        client, session, app = await _client()
        try:
            story = _mock_story()
            mock_result = MagicMock()
            mock_result.scalar_one_or_none.return_value = story
            session.execute = AsyncMock(return_value=mock_result)

            with patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock, return_value=story), \
                 patch("app.routers.workflow_report.evaluate_merge_gate", new=AsyncMock(return_value=auto)):
                async with client as c:
                    resp = await c.post("/api/v2/workflow/report-done", json={
                        "story_id": str(STORY_ID),
                        "stage": stage,
                        "agent_id": str(AGENT_ID),
                    })

            assert resp.status_code == 200, f"stage={stage} → {resp.status_code}"
        finally:
            app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_next_assignee_mapping():
    """S20: 하드코딩 _ROLE_TO_MEMBER 제거(role 해소=line role_assignments resolver·SSOT)·
    _TRANSITIONS 의 stage→next_role bootstrap 매핑만 잔존(AC①④)."""
    import app.routers.workflow_report as wr
    from app.routers.workflow_report import _TRANSITIONS

    assert not hasattr(wr, "_ROLE_TO_MEMBER")  # ⭐하드코딩 role→member UUID 제거됨
    assert _TRANSITIONS["kickoff"]["next_role"] == "dev"
    assert _TRANSITIONS["dev"]["next_role"] == "po"
    assert _TRANSITIONS["review"]["next_role"] == "qa"
    assert _TRANSITIONS["qa"]["next_role"] == "po"
    assert _TRANSITIONS["merge"]["next_role"] is None


@pytest.mark.anyio
async def test_story_cross_org_404():
    """S20 전수스캔 finding #12: story_id가 caller org 소속 아니면 404
    (이전엔 org_id 검증 자체가 없어 임의 org의 story를 조회/전이시킬 수 있었다)."""
    client, session, app = await _client()
    try:
        not_found = MagicMock()
        not_found.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=not_found)

        async with client as c:
            resp = await c.post("/api/v2/workflow/report-done", json={
                "story_id": str(STORY_ID),
                "stage": "kickoff",
                "agent_id": str(AGENT_ID),
            })
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_id_cross_org_400():
    """S20 전수스캔 finding #12(sibling): agent_id가 caller org 소속 member 아니면 400
    (이전엔 검증 없이 gate/line 평가의 actor로 그대로 스푸핑 가능했다)."""
    client, session, app = await _client()
    try:
        story = _mock_story(status="ready-for-dev")
        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = story
            elif call_count == 2:
                # E-SECURITY SEC-S8 Z2: has_project_access 호출(story project 접근권) — 이
                # 테스트는 그 뒤의 agent_id 검증(call 3)만 검증 대상이라 여기선 통과시킨다.
                result.scalar_one_or_none.return_value = 1
            else:
                result.scalar_one_or_none.return_value = None
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.post("/api/v2/workflow/report-done", json={
                "story_id": str(STORY_ID),
                "stage": "kickoff",
                "agent_id": str(uuid.uuid4()),
            })
        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_pipeline_sequence():
    """kickoff→dev→review→qa→merge→done 순서가 올바르다."""
    from app.routers.workflow_report import _TRANSITIONS

    stage = "kickoff"
    visited = [stage]
    while True:
        t = _TRANSITIONS.get(stage)
        if t is None:
            break
        stage = t["next_stage"]
        visited.append(stage)
        if stage == "done":
            break

    assert visited == ["kickoff", "dev", "review", "qa", "merge", "done"]
