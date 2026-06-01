"""E-CAGE-REFEREE P2: 신뢰 점수 집계 엔진 테스트."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.trust_score import _is_clean_pass, compute_member_trust_scores

ORG_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
P_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
ROLE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── _is_clean_pass 단위 ───────────────────────────────────────────────────────

def test_clean_pass_pass_no_rounds():
    assert _is_clean_pass("pass", None) is True
    assert _is_clean_pass("pass", 0) is True


def test_clean_pass_pass_with_rounds():
    assert _is_clean_pass("pass", 1) is False
    assert _is_clean_pass("pass", 3) is False


def test_clean_pass_fail():
    assert _is_clean_pass("fail", None) is False
    assert _is_clean_pass("fail", 0) is False


def test_clean_pass_null_result():
    assert _is_clean_pass(None, None) is False


# ── compute_member_trust_scores 단위 ──────────────────────────────────────────

def _mock_participation(p_id=None, role_key="implementation"):
    p = MagicMock()
    p.id = p_id or P_ID
    p.org_id = ORG_ID
    p.member_id = MEMBER_ID
    p.story_id = STORY_ID
    p.role_id = ROLE_ID
    return p


def _mock_story(sp=5, is_excluded=False):
    s = MagicMock()
    s.id = STORY_ID
    s.story_points = sp
    s.is_excluded = is_excluded
    s.deleted_at = None
    return s


def _mock_role(key="implementation", label="구현"):
    r = MagicMock()
    r.id = ROLE_ID
    r.key = key
    r.label = label
    return r


def _mock_verdict(p_id, result="pass", rounds=0):
    v = MagicMock()
    v.participation_id = p_id
    v.result = result
    v.rounds = rounds
    v.recorded_at = datetime.now(timezone.utc)
    return v


@pytest.mark.anyio
async def test_compute_no_participation_returns_empty():
    """participation 없으면 scores=[] graceful."""
    session = AsyncMock()
    mock_r = MagicMock()
    mock_r.all.return_value = []
    session.execute = AsyncMock(return_value=mock_r)

    result = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID)
    assert result["scores"] == []
    assert result["member_id"] == str(MEMBER_ID)


@pytest.mark.anyio
async def test_compute_clean_pass_all_verdicts():
    """모든 verdict가 clean pass → weighted_score=1.0."""
    session = AsyncMock()
    p = _mock_participation()
    s = _mock_story(sp=10)
    r = _mock_role()

    verdicts = [_mock_verdict(p.id, result="pass", rounds=0)]

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count == 1:
            result.all.return_value = [(p, s, r)]
        else:
            result.scalars.return_value.all.return_value = verdicts
        return result

    session.execute = mock_execute
    result = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID)

    assert len(result["scores"]) == 1
    score = result["scores"][0]
    assert score["clean_pass_verdicts"] == 1
    assert score["total_verdicts"] == 1
    assert score["weighted_score"] == 1.0
    assert score["clean_pass_rate"] == 1.0


@pytest.mark.anyio
async def test_compute_no_clean_pass():
    """verdict 있지만 모두 RC(rounds>0) → weighted_score=0.0."""
    session = AsyncMock()
    p = _mock_participation()
    s = _mock_story(sp=5)
    r = _mock_role()
    verdicts = [_mock_verdict(p.id, result="pass", rounds=2)]

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count == 1:
            result.all.return_value = [(p, s, r)]
        else:
            result.scalars.return_value.all.return_value = verdicts
        return result

    session.execute = mock_execute
    result = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID)

    score = result["scores"][0]
    assert score["clean_pass_verdicts"] == 0
    assert score["weighted_score"] == 0.0


@pytest.mark.anyio
async def test_compute_no_verdicts_returns_none_score():
    """participation 있지만 verdict 없음 → score=None (graceful 빈데이터)."""
    session = AsyncMock()
    p = _mock_participation()
    s = _mock_story(sp=5)
    r = _mock_role()

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count == 1:
            result.all.return_value = [(p, s, r)]
        else:
            result.scalars.return_value.all.return_value = []  # no verdicts
        return result

    session.execute = mock_execute
    result = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID)

    score = result["scores"][0]
    assert score["total_verdicts"] == 0
    assert score["clean_pass_rate"] is None
    assert score["weighted_score"] is None


@pytest.mark.anyio
async def test_compute_sp_weighting():
    """SP 가중 확인 — sp=10인 clean pass + sp=5인 dirty → weighted=10/15."""
    session = AsyncMock()
    p1 = _mock_participation(p_id=uuid.uuid4())
    p2 = _mock_participation(p_id=uuid.uuid4())
    s1 = _mock_story(sp=10)
    s2 = _mock_story(sp=5)
    r = _mock_role()

    p1.story_id = uuid.uuid4()
    p2.story_id = uuid.uuid4()

    v1 = _mock_verdict(p1.id, result="pass", rounds=0)
    v2 = _mock_verdict(p2.id, result="pass", rounds=1)  # dirty

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count == 1:
            result.all.return_value = [(p1, s1, r), (p2, s2, r)]
        else:
            result.scalars.return_value.all.return_value = [v1, v2]
        return result

    session.execute = mock_execute
    result = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID)

    score = result["scores"][0]
    assert score["total_sp"] == 15
    assert score["clean_sp"] == 10
    assert abs(score["weighted_score"] - 10/15) < 0.001


@pytest.mark.anyio
async def test_compute_null_sp_fallback_to_1():
    """story_points=None → 1 fallback."""
    session = AsyncMock()
    p = _mock_participation()
    s = _mock_story(sp=None)
    r = _mock_role()
    verdicts = [_mock_verdict(p.id, result="pass", rounds=0)]

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count == 1:
            result.all.return_value = [(p, s, r)]
        else:
            result.scalars.return_value.all.return_value = verdicts
        return result

    session.execute = mock_execute
    result = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID)

    score = result["scores"][0]
    assert score["total_sp"] == 1  # fallback
    assert score["weighted_score"] == 1.0


@pytest.mark.anyio
async def test_compute_outcome_not_in_score():
    """outcome(hit/miss)은 verdict result에 안 들어감 → clean pass 체크 안전."""
    # result='hit' / 'miss'는 outcome_status 필드, verdict.result에 없음
    # verdict.result = 'pass' | 'fail' | None 만 사용
    # 이 테스트는 outcome이 섞여도 clean_pass 집계가 오염 안 됨을 검증
    assert _is_clean_pass("hit", None) is False  # outcome은 clean pass 아님
    assert _is_clean_pass("miss", None) is False


@pytest.mark.anyio
async def test_compute_role_filter():
    """role_key 필터 → 해당 역할만 집계."""
    session = AsyncMock()
    # implementation role만 포함
    p = _mock_participation(role_key="implementation")
    s = _mock_story(sp=5)
    r = _mock_role(key="implementation")

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count == 1:
            result.all.return_value = [(p, s, r)]
        else:
            result.scalars.return_value.all.return_value = []
        return result

    session.execute = mock_execute
    result = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID, role_key="implementation")

    assert result["scores"][0]["role_key"] == "implementation"


# ── GET 엔드포인트 통합 테스트 ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_trust_scores_endpoint_200():
    """GET /api/v2/trust-scores?member_id=... → 200."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()
    mock_r = MagicMock()
    mock_r.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_r)

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(f"/api/v2/trust-scores?member_id={MEMBER_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["member_id"] == str(MEMBER_ID)
        assert body["scores"] == []
        assert "window_days" in body
    finally:
        app.dependency_overrides.clear()
