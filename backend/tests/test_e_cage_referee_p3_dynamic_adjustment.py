"""E-CAGE-REFEREE P3 ④: 신뢰 기반 동적 조절 추천 엔진 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.disposition_advisor import (
    DEFAULT_MIN_VERDICTS,
    HIGH_THRESHOLD,
    LOW_THRESHOLD,
    get_disposition_recommendation,
)

ORG_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
ROLE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _trust_result(clean_pass_rate, total_verdicts, role_key="implementation"):
    return {
        "member_id": str(MEMBER_ID),
        "scores": [
            {
                "role_key": role_key,
                "role_label": "구현",
                "clean_pass_verdicts": int(clean_pass_rate * total_verdicts),
                "total_verdicts": total_verdicts,
                "clean_pass_rate": clean_pass_rate,
                "total_sp": total_verdicts * 5,
                "clean_sp": int(clean_pass_rate * total_verdicts * 5),
                "weighted_score": clean_pass_rate,
            }
        ],
        "window_days": 90,
    }


# ── 완화 추천 ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_recommend_relax_ask_to_allow_auto():
    """현 disposition=ask + pass_rate>=0.9 + 충분한 표본 → allow_auto 완화 추천."""
    session = AsyncMock()

    with patch("app.services.disposition_advisor.resolve_disposition", new_callable=AsyncMock) as mock_disp, \
         patch("app.services.disposition_advisor.compute_member_trust_scores", new_callable=AsyncMock) as mock_trust:
        mock_disp.return_value = "ask"
        mock_trust.return_value = _trust_result(0.95, 20)

        result = await get_disposition_recommendation(
            session, ORG_ID, MEMBER_ID, ROLE_ID, "implementation", "pr_review"
        )

    assert result["has_recommendation"] is True
    assert result["recommended_disposition"] == "allow_auto"
    assert result["current_disposition"] == "ask"
    assert result["clean_pass_rate"] == 0.95


@pytest.mark.anyio
async def test_no_recommend_when_already_allow_auto_high_rate():
    """이미 allow_auto인데 pass_rate 높음 → 추천 없음."""
    session = AsyncMock()

    with patch("app.services.disposition_advisor.resolve_disposition", new_callable=AsyncMock) as mock_disp, \
         patch("app.services.disposition_advisor.compute_member_trust_scores", new_callable=AsyncMock) as mock_trust:
        mock_disp.return_value = "allow_auto"
        mock_trust.return_value = _trust_result(0.98, 20)

        result = await get_disposition_recommendation(
            session, ORG_ID, MEMBER_ID, ROLE_ID, "implementation", "pr_review"
        )

    assert result["has_recommendation"] is False
    assert result["skipped_reason"] == "no_adjustment_needed"


# ── 강화 추천 ─────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_recommend_tighten_allow_auto_to_ask():
    """현 disposition=allow_auto + pass_rate<0.7 → ask 강화 추천."""
    session = AsyncMock()

    with patch("app.services.disposition_advisor.resolve_disposition", new_callable=AsyncMock) as mock_disp, \
         patch("app.services.disposition_advisor.compute_member_trust_scores", new_callable=AsyncMock) as mock_trust:
        mock_disp.return_value = "allow_auto"
        mock_trust.return_value = _trust_result(0.60, 15)

        result = await get_disposition_recommendation(
            session, ORG_ID, MEMBER_ID, ROLE_ID, "implementation", "pr_review"
        )

    assert result["has_recommendation"] is True
    assert result["recommended_disposition"] == "ask"
    assert result["current_disposition"] == "allow_auto"


@pytest.mark.anyio
async def test_no_recommend_tighten_when_ask():
    """현 disposition=ask인데 pass_rate 낮음 → 이미 ask, 추천 없음."""
    session = AsyncMock()

    with patch("app.services.disposition_advisor.resolve_disposition", new_callable=AsyncMock) as mock_disp, \
         patch("app.services.disposition_advisor.compute_member_trust_scores", new_callable=AsyncMock) as mock_trust:
        mock_disp.return_value = "ask"
        mock_trust.return_value = _trust_result(0.50, 15)

        result = await get_disposition_recommendation(
            session, ORG_ID, MEMBER_ID, ROLE_ID, "implementation", "pr_review"
        )

    assert result["has_recommendation"] is False
    assert result["skipped_reason"] == "no_adjustment_needed"


# ── 저표본 가드 ───────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_low_sample_guard_no_recommendation():
    """verdicts < min_verdicts → 추천 없음 (저표본 가드)."""
    session = AsyncMock()

    with patch("app.services.disposition_advisor.resolve_disposition", new_callable=AsyncMock) as mock_disp, \
         patch("app.services.disposition_advisor.compute_member_trust_scores", new_callable=AsyncMock) as mock_trust:
        mock_disp.return_value = "ask"
        mock_trust.return_value = _trust_result(0.99, 3)  # 3건 < DEFAULT 10건

        result = await get_disposition_recommendation(
            session, ORG_ID, MEMBER_ID, ROLE_ID, "implementation", "pr_review"
        )

    assert result["has_recommendation"] is False
    assert result["skipped_reason"] == "low_sample"
    assert result["total_verdicts"] == 3


@pytest.mark.anyio
async def test_custom_min_verdicts():
    """min_verdicts 커스텀 — 3건으로 낮추면 추천 가능."""
    session = AsyncMock()

    with patch("app.services.disposition_advisor.resolve_disposition", new_callable=AsyncMock) as mock_disp, \
         patch("app.services.disposition_advisor.compute_member_trust_scores", new_callable=AsyncMock) as mock_trust:
        mock_disp.return_value = "ask"
        mock_trust.return_value = _trust_result(0.95, 3)

        result = await get_disposition_recommendation(
            session, ORG_ID, MEMBER_ID, ROLE_ID, "implementation", "pr_review",
            min_verdicts=3,
        )

    assert result["has_recommendation"] is True
    assert result["recommended_disposition"] == "allow_auto"


@pytest.mark.anyio
async def test_no_verdicts_low_sample():
    """verdict 0건 → 저표본 가드."""
    session = AsyncMock()

    with patch("app.services.disposition_advisor.resolve_disposition", new_callable=AsyncMock) as mock_disp, \
         patch("app.services.disposition_advisor.compute_member_trust_scores", new_callable=AsyncMock) as mock_trust:
        mock_disp.return_value = "ask"
        mock_trust.return_value = {"member_id": str(MEMBER_ID), "scores": [], "window_days": 90}

        result = await get_disposition_recommendation(
            session, ORG_ID, MEMBER_ID, ROLE_ID, "implementation", "pr_review"
        )

    assert result["has_recommendation"] is False
    assert result["skipped_reason"] == "low_sample"
    assert result["total_verdicts"] == 0


# ── 자동 적용 없음 단언 ────────────────────────────────────────────────────────

def test_advisor_returns_only_recommendation_not_apply():
    """advisor 서비스는 추천만 반환 — override 적용 코드 없음."""
    import inspect
    import app.services.disposition_advisor as m
    src = inspect.getsource(m)
    # 서비스 코드에 upsert/add/create override 로직 없음
    assert "session.add" not in src
    assert "MemberGateOverride" not in src
    assert "OrgGateOverride" not in src


# ── apply 엔드포인트 — 인간 승인 후만 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_apply_endpoint_member_override():
    """POST /gate-config/recommendations/apply → member_gate_override upsert."""
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
    mock_r.scalar_one_or_none.return_value = None  # 없음 → 신규 생성
    mock_session.execute = AsyncMock(return_value=mock_r)
    mock_session.add = MagicMock()
    mock_session.flush = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/gate-config/recommendations/apply", json={
                "member_id": str(MEMBER_ID),
                "gate_type": "pr_review",
                "disposition": "allow_auto",
                "apply_as": "member",
            })
        assert resp.status_code == 200
        body = resp.json()
        assert body["applied"] is True
        assert body["disposition"] == "allow_auto"
        mock_session.add.assert_called_once()
    finally:
        app.dependency_overrides.clear()


# ── #1116 WARN 흡수 확인 ─────────────────────────────────────────────────────

def test_gate_no_foreignkey_import():
    """gate.py에 ForeignKey dead import 없음."""
    import app.models.gate as m
    import inspect
    src = inspect.getsource(m)
    assert "ForeignKey" not in src


def test_gate_create_request_validates_gate_type():
    """GateCreateRequest gate_type field_validator → 422."""
    from app.routers.gates import GateCreateRequest
    from pydantic import ValidationError
    import pytest
    with pytest.raises(ValidationError):
        GateCreateRequest(
            work_item_id=uuid.uuid4(),
            work_item_type="story",
            gate_type="invalid_type",
            member_id=uuid.uuid4(),
            role_id=uuid.uuid4(),
        )
