"""E-CAGE-REFEREE P1: PR·CI verdict 자동 포착 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.verdict_capture import parse_story_id

ORG_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
PARTICIPATION_ID = uuid.uuid4()
ROLE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── SID 태그 파싱 단위 테스트 ─────────────────────────────────────────────────

def test_parse_story_id_valid():
    sid = uuid.uuid4()
    title = f"[SID:{sid}] feat: some feature"
    result = parse_story_id(title)
    assert result == sid


def test_parse_story_id_no_tag_returns_none():
    assert parse_story_id("feat: no sid here") is None
    assert parse_story_id("") is None


def test_parse_story_id_invalid_uuid_returns_none():
    assert parse_story_id("[SID:not-a-uuid] title") is None


def test_parse_story_id_case_insensitive():
    sid = uuid.uuid4()
    assert parse_story_id(f"[sid:{sid}] title") == sid


def test_parse_story_id_in_middle():
    sid = uuid.uuid4()
    assert parse_story_id(f"prefix [SID:{sid}] suffix") == sid


# ── resolve_implementation_participation 단위 테스트 ─────────────────────────

@pytest.mark.anyio
async def test_resolve_returns_participation_when_found():
    from app.services.verdict_capture import resolve_implementation_participation

    session = AsyncMock()
    role = MagicMock()
    role.id = ROLE_ID

    participation = MagicMock()
    participation.id = PARTICIPATION_ID

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        r = MagicMock()
        if call_count == 1:
            r.scalar_one_or_none.return_value = role
        else:
            r.scalar_one_or_none.return_value = participation
        return r

    session.execute = mock_execute
    result = await resolve_implementation_participation(session, ORG_ID, STORY_ID)
    assert result == participation


@pytest.mark.anyio
async def test_resolve_returns_none_when_no_default_role():
    from app.services.verdict_capture import resolve_implementation_participation

    session = AsyncMock()
    mock_r = MagicMock()
    mock_r.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=mock_r)

    result = await resolve_implementation_participation(session, ORG_ID, STORY_ID)
    assert result is None


# ── capture_pr_ci_verdict 서비스 테스트 ───────────────────────────────────────

@pytest.mark.anyio
async def test_capture_merged_pr_records_pr_verdict():
    """머지된 PR → source=pr result=pass verdict 기록."""
    from app.services.verdict_capture import capture_pr_ci_verdict

    session = AsyncMock()
    participation = MagicMock()
    participation.id = PARTICIPATION_ID

    with patch("app.services.verdict_capture.resolve_implementation_participation", new_callable=AsyncMock) as mock_resolve, \
         patch("app.services.verdict_capture.fetch_pr_review_rounds", new_callable=AsyncMock) as mock_rounds, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock) as mock_record:
        mock_resolve.return_value = participation
        mock_rounds.return_value = 2  # 2회 RC

        result = await capture_pr_ci_verdict(
            session, ORG_ID, STORY_ID, pr_number=1108,
            repo="moonklabs/sprintable", merged=True, ci_result=None
        )

        assert "pr" in result["recorded"]
        assert result["skipped_reason"] is None
        # record_verdict(_, 'pr', 'pass', rounds=2)
        mock_record.assert_called_once()
        call_kwargs = mock_record.call_args[1]
        assert call_kwargs["source"] == "pr"
        assert call_kwargs["result"] == "pass"
        assert call_kwargs["rounds"] == 2


@pytest.mark.anyio
async def test_capture_ci_fail_records_ci_verdict():
    """CI fail → source=ci result=fail verdict 기록."""
    from app.services.verdict_capture import capture_pr_ci_verdict

    session = AsyncMock()
    participation = MagicMock()
    participation.id = PARTICIPATION_ID

    with patch("app.services.verdict_capture.resolve_implementation_participation", new_callable=AsyncMock) as mock_resolve, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock) as mock_record:
        mock_resolve.return_value = participation

        result = await capture_pr_ci_verdict(
            session, ORG_ID, STORY_ID, pr_number=1108,
            repo="moonklabs/sprintable", merged=False, ci_result="failure"
        )

        assert "ci" in result["recorded"]
        call_kwargs_list = [c[1] for c in mock_record.call_args_list]
        ci_call = next(k for k in call_kwargs_list if k["source"] == "ci")
        assert ci_call["result"] == "fail"


@pytest.mark.anyio
async def test_capture_no_participation_skips():
    """participation 없으면 skip (거짓기록 금지)."""
    from app.services.verdict_capture import capture_pr_ci_verdict

    session = AsyncMock()

    with patch("app.services.verdict_capture.resolve_implementation_participation", new_callable=AsyncMock) as mock_resolve, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock) as mock_record:
        mock_resolve.return_value = None

        result = await capture_pr_ci_verdict(
            session, ORG_ID, STORY_ID, pr_number=999,
            repo="moonklabs/sprintable", merged=True, ci_result="success"
        )

        assert result["skipped_reason"] == "no_implementation_participation"
        mock_record.assert_not_called()


@pytest.mark.anyio
async def test_capture_idempotent_via_record_verdict():
    """record_verdict(uq upsert)로 멱등 보장 — 동일 호출 2회 = upsert."""
    from app.services.verdict_capture import capture_pr_ci_verdict

    session = AsyncMock()
    participation = MagicMock()
    participation.id = PARTICIPATION_ID

    with patch("app.services.verdict_capture.resolve_implementation_participation", new_callable=AsyncMock) as mock_resolve, \
         patch("app.services.verdict_capture.fetch_pr_review_rounds", new_callable=AsyncMock) as mock_rounds, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock) as mock_record:
        mock_resolve.return_value = participation
        mock_rounds.return_value = 0

        await capture_pr_ci_verdict(session, ORG_ID, STORY_ID, 1108, "org/repo", True, "success")
        await capture_pr_ci_verdict(session, ORG_ID, STORY_ID, 1108, "org/repo", True, "success")

        # record_verdict 2회 호출 (upsert이므로 내부에서 update 처리)
        assert mock_record.call_count == 4  # pr+ci 각 2번


# ── 내부 캡처 엔드포인트 통합 테스트 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_capture_pr_endpoint_no_sid_skips():
    """SID 없는 PR → skipped_reason=no_sid_tag."""
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    mock_session = AsyncMock()
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v2/internal/verdict/capture-pr",
                json={"pr_title": "feat: no sid tag", "pr_number": 999, "merged": True},
                headers={"Authorization": "Bearer "},
            )
        assert resp.status_code == 200
        assert resp.json()["data"]["skipped_reason"] == "no_sid_tag"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_capture_pr_endpoint_story_not_found_skips():
    """SID 있지만 story 없음 → skipped_reason=story_not_found."""
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None  # story 없음
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v2/internal/verdict/capture-pr",
                json={"pr_title": f"[SID:{STORY_ID}] title", "pr_number": 999, "merged": True},
                headers={"Authorization": "Bearer "},
            )
        assert resp.status_code == 200
        assert resp.json()["data"]["skipped_reason"] == "story_not_found"
    finally:
        app.dependency_overrides.clear()
