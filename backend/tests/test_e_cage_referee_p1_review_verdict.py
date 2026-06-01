"""E-CAGE-REFEREE P1: QA·디자인 게이트 verdict 포착 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
ROLE_ID = uuid.uuid4()
PARTICIPATION_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_role(key="qa"):
    r = MagicMock()
    r.id = ROLE_ID
    r.org_id = ORG_ID
    r.key = key
    r.label = "QA" if key == "qa" else "디자인"
    r.is_default = False
    return r


def _mock_participation():
    p = MagicMock()
    p.id = PARTICIPATION_ID
    p.org_id = ORG_ID
    p.story_id = STORY_ID
    p.member_id = MEMBER_ID
    p.role_id = ROLE_ID
    return p


# ── ensure_review_participation 단위 테스트 ────────────────────────────────────

@pytest.mark.anyio
async def test_ensure_creates_participation_when_not_exists():
    """QA participation 없으면 신규 생성."""
    from app.services.verdict_capture import ensure_review_participation

    session = AsyncMock()
    role = _mock_role("qa")
    new_p = _mock_participation()

    async def mock_execute(stmt, *args, **kwargs):
        r = MagicMock()
        r.scalar_one_or_none.return_value = role
        return r

    session.execute = mock_execute

    with patch("app.repositories.participation.ParticipationRepository.exists", new_callable=AsyncMock) as mock_exists, \
         patch("app.repositories.participation.ParticipationRepository.create", new_callable=AsyncMock) as mock_create:
        mock_exists.return_value = False
        mock_create.return_value = new_p

        result = await ensure_review_participation(session, ORG_ID, STORY_ID, MEMBER_ID, "qa")

        mock_create.assert_called_once()
        assert result == new_p


@pytest.mark.anyio
async def test_ensure_returns_existing_when_found():
    """이미 QA participation 있으면 신규 생성 안 함."""
    from app.services.verdict_capture import ensure_review_participation

    session = AsyncMock()
    role = _mock_role("qa")
    existing_p = _mock_participation()

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        r = MagicMock()
        if call_count == 1:
            r.scalar_one_or_none.return_value = role
        else:
            r.scalar_one_or_none.return_value = existing_p
        return r

    session.execute = mock_execute

    with patch("app.repositories.participation.ParticipationRepository.exists", new_callable=AsyncMock) as mock_exists, \
         patch("app.repositories.participation.ParticipationRepository.create", new_callable=AsyncMock) as mock_create:
        mock_exists.return_value = True
        mock_create.return_value = None

        result = await ensure_review_participation(session, ORG_ID, STORY_ID, MEMBER_ID, "qa")

        mock_create.assert_not_called()
        assert result == existing_p


@pytest.mark.anyio
async def test_ensure_returns_none_when_role_not_found():
    """org에 qa/design role 없으면 None → skip."""
    from app.services.verdict_capture import ensure_review_participation

    session = AsyncMock()
    mock_r = MagicMock()
    mock_r.scalar_one_or_none.return_value = None  # role 없음
    session.execute = AsyncMock(return_value=mock_r)

    result = await ensure_review_participation(session, ORG_ID, STORY_ID, MEMBER_ID, "qa")
    assert result is None


# ── capture_review_verdict 서비스 테스트 ──────────────────────────────────────

@pytest.mark.anyio
async def test_capture_qa_verdict_pass():
    """QA 게이트 pass → source=qa result=pass verdict 기록."""
    from app.services.verdict_capture import capture_review_verdict

    session = AsyncMock()
    participation = _mock_participation()

    with patch("app.services.verdict_capture.ensure_review_participation", new_callable=AsyncMock) as mock_ensure, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock) as mock_record:
        mock_ensure.return_value = participation

        result = await capture_review_verdict(session, ORG_ID, STORY_ID, "qa", MEMBER_ID, "pass", rounds=1)

        assert result["recorded"] is True
        assert result["source"] == "qa"
        assert result["result"] == "pass"
        mock_record.assert_called_once()
        kw = mock_record.call_args[1]
        assert kw["source"] == "qa"
        assert kw["result"] == "pass"
        assert kw["rounds"] == 1


@pytest.mark.anyio
async def test_capture_design_verdict_fail():
    """디자인 게이트 fail → source=design result=fail verdict 기록."""
    from app.services.verdict_capture import capture_review_verdict

    session = AsyncMock()
    participation = _mock_participation()

    with patch("app.services.verdict_capture.ensure_review_participation", new_callable=AsyncMock) as mock_ensure, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock) as mock_record:
        mock_ensure.return_value = participation

        result = await capture_review_verdict(session, ORG_ID, STORY_ID, "design", MEMBER_ID, "fail")

        assert result["recorded"] is True
        assert result["source"] == "design"
        kw = mock_record.call_args[1]
        assert kw["source"] == "design"
        assert kw["result"] == "fail"


@pytest.mark.anyio
async def test_capture_review_skips_when_no_role():
    """role 없으면 skip (거짓기록 금지)."""
    from app.services.verdict_capture import capture_review_verdict

    session = AsyncMock()

    with patch("app.services.verdict_capture.ensure_review_participation", new_callable=AsyncMock) as mock_ensure, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock) as mock_record:
        mock_ensure.return_value = None  # role 없음

        result = await capture_review_verdict(session, ORG_ID, STORY_ID, "qa", MEMBER_ID, "pass")

        assert result["recorded"] is False
        assert "no_qa_role" in result["skipped_reason"]
        mock_record.assert_not_called()


@pytest.mark.anyio
async def test_capture_review_null_result():
    """result=None → null 유지 (미측정 거짓채점 금지)."""
    from app.services.verdict_capture import capture_review_verdict

    session = AsyncMock()
    participation = _mock_participation()

    with patch("app.services.verdict_capture.ensure_review_participation", new_callable=AsyncMock) as mock_ensure, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock) as mock_record:
        mock_ensure.return_value = participation

        await capture_review_verdict(session, ORG_ID, STORY_ID, "qa", MEMBER_ID, None)

        kw = mock_record.call_args[1]
        assert kw["result"] is None


# ── 내부 엔드포인트 테스트 ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_capture_review_endpoint_invalid_role_422():
    """잘못된 role → 422."""
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v2/internal/verdict/capture-review",
                json={"story_id": str(STORY_ID), "role": "implementation", "member_id": str(MEMBER_ID)},
                headers={"Authorization": "Bearer "},
            )
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_capture_review_endpoint_story_not_found():
    """story 없으면 skipped_reason=story_not_found."""
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v2/internal/verdict/capture-review",
                json={"story_id": str(STORY_ID), "role": "qa", "member_id": str(MEMBER_ID), "result": "pass"},
                headers={"Authorization": "Bearer "},
            )
        assert resp.status_code == 200
        assert resp.json()["data"]["skipped_reason"] == "story_not_found"
    finally:
        app.dependency_overrides.clear()


# ── 트리거 방식 근거 명시 ────────────────────────────────────────────────────────

def test_trigger_rationale_is_internal_endpoint():
    """트리거 근거 명시: send_chat_message 자동 훅 불가 이유.

    조사 결과:
    1. FastAPI SendMessageRequest 스키마에 review_type/metadata 미노출
       (app/routers/conversations.py L247)
    2. ConversationMessage 생성 시 review_type 저장 안 됨 (L658-664)
    3. Conversation 모델에 story_id FK 없음 — conv→story 링크 불가
    4. workflow process_event에 review_type 미전달

    → ⒝ MVP 내부 엔드포인트 /capture-review (CRON_SECRET) 택일.
    """
    # 조사 근거 문서화 테스트 (코드 실행 없음, 주석으로 검증)
    from app.routers.verdict_capture import _VALID_REVIEW_ROLES
    assert "qa" in _VALID_REVIEW_ROLES
    assert "design" in _VALID_REVIEW_ROLES
    assert "implementation" not in _VALID_REVIEW_ROLES
