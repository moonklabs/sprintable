"""E-CAGE-REFEREE P1: PR·CI verdict 자동 포착 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.verdict_capture import parse_story_id, parse_story_number

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


# ── story_number 태그 파싱 단위 테스트 (story #2327 후속, 2026-07-30) ─────────
# 양성 3건은 오늘 실제로 머지된 PR 제목 원문(PO 지시 — "오늘 실제 PR 제목 3건이 이미 표본").

def test_parse_story_number_bracket_form_real_pr_title_1():
    title = "[SID:2288] 세 목록 상호참조 코멘트에 만료 조건 추가"
    assert parse_story_number(title) == 2288


def test_parse_story_number_fix_hash_form_real_pr_title_2():
    title = "fix(#2328): 후보 머리글에 유나 규격의 em-dash 리터럴이 빠져 있었다"
    assert parse_story_number(title) == 2328


def test_parse_story_number_bracket_form_real_pr_title_3():
    title = "[SID:2267] AC4/AC7 — 컨테이너와 출처를 화면에서 가른다"
    assert parse_story_number(title) == 2267


def test_parse_story_number_negative_number_without_marker():
    """음성 대조 — 숫자처럼 생겼지만 SID 마커(`[SID:`·`fix(#`)가 없으면 None.

    "2288"이 본문에 있다고 다 잡으면 오매치(예: PR 번호·버전·ms 단위)가 SID로 오인된다."""
    assert parse_story_number("fix: bump timeout to 2288ms") is None
    assert parse_story_number("chore: release 2328") is None
    assert parse_story_number("") is None


def test_parse_story_number_does_not_match_uuid_form():
    """UUID form([SID:<uuid>])은 이 파서가 안 잡는다 — parse_story_id 전용 축."""
    sid = uuid.uuid4()
    assert parse_story_number(f"[SID:{sid}] feat") is None


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
async def test_capture_ci_cancelled_skips_verdict_no_false_fail():
    """⭐story #3115(2026-08-26, 승격 리드타임 — «재오픈 연쇄의 취소 오염») — cancelled(재오픈/
    재push로 새 workflow_run이 concurrency 그룹의 옛 run을 취소한 정상 흐름)를 fail로
    채점하면 CI 게이트가 거짓 rejected되고 story trust 이력도 오염된다. cancelled는 완전히
    skip(verdict 기록도 gate 해소도 안 함) — recorded에도 안 들어가야 한다."""
    from app.services.verdict_capture import capture_pr_ci_verdict

    session = AsyncMock()
    participation = MagicMock()
    participation.id = PARTICIPATION_ID

    with patch("app.services.verdict_capture.resolve_implementation_participation", new_callable=AsyncMock) as mock_resolve, \
         patch("app.services.verdict_capture.record_verdict", new_callable=AsyncMock) as mock_record:
        mock_resolve.return_value = participation

        result = await capture_pr_ci_verdict(
            session, ORG_ID, STORY_ID, pr_number=1108,
            repo="moonklabs/sprintable", merged=False, ci_result="cancelled"
        )

        assert "ci" not in result["recorded"]
        mock_record.assert_not_called()


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
