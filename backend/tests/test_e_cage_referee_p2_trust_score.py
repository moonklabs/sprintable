"""E-CAGE-REFEREE P2: 신뢰 점수 집계 엔진 테스트."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

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


def _mock_verdict(p_id, result="pass", rounds=0, source="hypothesis_outcome_execution"):
    # HO-S5: 기본 신뢰 집계 source는 가설 outcome(hypothesis_outcome_*). clean_pass×SP 수학은
    # source 무관이므로 기본을 outcome source로 둬 새 기본 경로에서 동일 검증.
    v = MagicMock()
    v.participation_id = p_id
    v.result = result
    v.rounds = rounds
    v.source = source
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
        with patch("app.routers.trust_scores.is_caller_member", new_callable=AsyncMock, return_value=True):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.get(f"/api/v2/trust-scores?member_id={MEMBER_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["member_id"] == str(MEMBER_ID)
        assert body["scores"] == []
        assert "window_days" in body
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_trust_scores_403_when_not_self_or_admin():
    """S20 전수스캔 finding #11: member_id가 caller 본인도 org-admin도 아니면 403
    (이전엔 org_id만 검증되고 member_id ownership 확인이 아예 없어 임의 member의
    신뢰점수를 열람할 수 있었다)."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        with patch("app.routers.trust_scores.is_caller_member", new_callable=AsyncMock, return_value=False), \
             patch("app.routers.trust_scores._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.get(f"/api/v2/trust-scores?member_id={MEMBER_ID}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ── HO-S5: trust source 전환(가설 outcome primary) ─────────────────────────────

def _session_with(rows, verdicts):
    """1차 호출=participation 조인 rows, 2차=verdict scalars."""
    session = AsyncMock()
    state = {"n": 0}

    async def mock_execute(stmt, *args, **kwargs):
        state["n"] += 1
        result = MagicMock()
        if state["n"] == 1:
            result.all.return_value = rows
        else:
            result.scalars.return_value.all.return_value = verdicts
        return result

    session.execute = mock_execute
    return session


@pytest.mark.anyio
async def test_ho_s5_ci_only_yields_no_trust():
    """AC①④: source=ci만(outcome 0) → trust None=cold-start. breakdown엔 ci 관측."""
    p, s, r = _mock_participation(), _mock_story(sp=5), _mock_role()
    verdicts = [_mock_verdict(p.id, result="pass", rounds=0, source="ci") for _ in range(10)]
    session = _session_with([(p, s, r)], verdicts)

    res = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID)

    score = res["scores"][0]
    assert score["total_verdicts"] == 0          # ci는 신뢰 미환산.
    assert score["clean_pass_rate"] is None       # cold-start(표본부족).
    assert score["hit_rate"] is None and score["resolved"] == 0
    assert res["hypothesis_hit_rate"] is None and res["resolved"] == 0
    assert res["primary_source"] == "hypothesis_outcome"
    assert res["source_breakdown"] == {"ci": 10}   # 제외돼도 관측(AC④ 진단).


@pytest.mark.anyio
async def test_ho_s5_outcome_pass_fail_hit_rate():
    """AC②: outcome pass/fail만 hit_rate(2 hit / 3 resolved)."""
    p, s, r = _mock_participation(), _mock_story(sp=4), _mock_role(key="hypothesis_owner", label="가설책임")
    r.key = "hypothesis_owner"
    verdicts = [
        _mock_verdict(p.id, result="pass", source="hypothesis_outcome_bet"),
        _mock_verdict(p.id, result="pass", source="hypothesis_outcome_bet"),
        _mock_verdict(p.id, result="fail", source="hypothesis_outcome_bet"),
        _mock_verdict(p.id, result=None, source="hypothesis_outcome_bet"),  # pending(보류).
    ]
    session = _session_with([(p, s, r)], verdicts)

    res = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID)

    assert res["hit"] == 2 and res["resolved"] == 3 and res["pending"] == 1
    assert res["hypothesis_hit_rate"] == round(2 / 3, 4)
    score = res["scores"][0]
    assert score["hit_rate"] == round(2 / 3, 4) and score["pending"] == 1


@pytest.mark.anyio
async def test_ho_s5_include_legacy_restores_ci():
    """legacy opt-in: include_legacy=True면 ci도 신뢰 합산(구 동작 보존)."""
    p, s, r = _mock_participation(), _mock_story(sp=5), _mock_role()
    verdicts = [_mock_verdict(p.id, result="pass", rounds=0, source="ci") for _ in range(4)]
    session = _session_with([(p, s, r)], verdicts)

    res = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID, include_legacy=True)

    score = res["scores"][0]
    assert score["total_verdicts"] == 4 and score["clean_pass_rate"] == 1.0
    assert res["primary_source"] == "legacy_all"


@pytest.mark.anyio
async def test_ho_s5_mixed_only_outcome_counts():
    """혼합(ci+outcome): 신뢰는 outcome만·breakdown은 둘 다."""
    p, s, r = _mock_participation(), _mock_story(sp=3), _mock_role()
    verdicts = [
        _mock_verdict(p.id, result="pass", source="hypothesis_outcome_execution"),
        _mock_verdict(p.id, result="fail", source="ci"),
        _mock_verdict(p.id, result="pass", source="qa"),
    ]
    session = _session_with([(p, s, r)], verdicts)

    res = await compute_member_trust_scores(session, ORG_ID, MEMBER_ID)

    assert res["scores"][0]["total_verdicts"] == 1   # outcome 1건만.
    assert res["hit"] == 1 and res["resolved"] == 1
    assert res["source_breakdown"] == {"hypothesis_outcome_execution": 1, "ci": 1, "qa": 1}
