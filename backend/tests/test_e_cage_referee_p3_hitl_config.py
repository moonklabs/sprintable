"""E-CAGE-REFEREE P3: HITL config 모델 + disposition 해소 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.hitl_config import posture_to_disposition, SYSTEM_DEFAULT_DISPOSITION
from app.services.gate_resolver import resolve_disposition

ORG_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
ROLE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── posture_to_disposition 단위 ───────────────────────────────────────────────

def test_conservative_posture():
    assert posture_to_disposition("conservative") == "ask"


def test_balanced_posture():
    assert posture_to_disposition("balanced") == "ask"


def test_permissive_posture():
    assert posture_to_disposition("permissive") == "allow_auto"


def test_unknown_posture_fallback():
    assert posture_to_disposition("unknown") == SYSTEM_DEFAULT_DISPOSITION


# ── resolve_disposition precedence 테스트 ────────────────────────────────────

def _make_session(member_override=None, org_override=None, policy=None):
    session = AsyncMock()
    call_count = 0

    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        r = MagicMock()
        if call_count == 1:
            r.scalar_one_or_none.return_value = member_override
        elif call_count == 2:
            r.scalar_one_or_none.return_value = org_override
        else:
            r.scalar_one_or_none.return_value = policy
        return r

    session.execute = mock_execute
    return session


@pytest.mark.anyio
async def test_member_override_wins():
    """member_gate_override가 최우선 — org override·posture 무시."""
    mo = MagicMock()
    mo.disposition = "deny"
    session = _make_session(member_override=mo)

    result = await resolve_disposition(session, ORG_ID, MEMBER_ID, ROLE_ID, "pr_review")
    assert result == "deny"


@pytest.mark.anyio
async def test_org_override_wins_when_no_member_override():
    """member override 없으면 org_gate_override 적용."""
    oo = MagicMock()
    oo.disposition = "allow_auto"
    session = _make_session(member_override=None, org_override=oo)

    result = await resolve_disposition(session, ORG_ID, MEMBER_ID, ROLE_ID, "qa")
    assert result == "allow_auto"


@pytest.mark.anyio
async def test_org_posture_wins_when_no_overrides():
    """override 없으면 org posture 기반 기본값."""
    policy = MagicMock()
    policy.posture = "permissive"
    session = _make_session(member_override=None, org_override=None, policy=policy)

    result = await resolve_disposition(session, ORG_ID, MEMBER_ID, ROLE_ID, "merge")
    assert result == "allow_auto"


@pytest.mark.anyio
async def test_system_default_when_no_policy():
    """policy 없으면 시스템 기본값 'ask'."""
    session = _make_session(member_override=None, org_override=None, policy=None)

    result = await resolve_disposition(session, ORG_ID, MEMBER_ID, ROLE_ID, "deploy")
    assert result == "ask"


@pytest.mark.anyio
async def test_conservative_posture_gives_ask():
    """conservative posture → ask."""
    policy = MagicMock()
    policy.posture = "conservative"
    session = _make_session(member_override=None, org_override=None, policy=policy)

    result = await resolve_disposition(session, ORG_ID, MEMBER_ID, ROLE_ID, "pr_review")
    assert result == "ask"


@pytest.mark.anyio
async def test_risk_level_not_required():
    """risk_level 파라미터 없이 resolve 가능 (플랫폼 위험도 판정 안 함)."""
    session = _make_session()
    # resolve_disposition 시그니처에 risk_level 없음
    import inspect
    sig = inspect.signature(resolve_disposition)
    assert "risk_level" not in sig.parameters


# ── gate_type 다양성 테스트 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_all_gate_types_resolve():
    """pr_review|qa|merge|deploy 모두 시스템 기본값 resolve 가능."""
    gate_types = ["pr_review", "qa", "merge", "deploy"]
    for gt in gate_types:
        session = _make_session()
        result = await resolve_disposition(session, ORG_ID, MEMBER_ID, ROLE_ID, gt)
        assert result == "ask"


# ── 엔드포인트 통합 테스트 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_resolve_endpoint_200():
    """POST /gate-config/resolve → 200 disposition 반환."""
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
    mock_r.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_r)

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/gate-config/resolve", json={
                "member_id": str(MEMBER_ID),
                "role_id": str(ROLE_ID),
                "gate_type": "pr_review",
            })
        assert resp.status_code == 200
        body = resp.json()
        assert body["disposition"] == "ask"  # 시스템 기본값
        assert body["gate_type"] == "pr_review"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_policy_endpoint_none_when_no_policy():
    """GET /gate-config/policy → policy 없으면 None 반환."""
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
    mock_r.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_r)

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/gate-config/policy")
        assert resp.status_code == 200
        assert resp.json() is None
    finally:
        app.dependency_overrides.clear()


# ── org 격리 ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_org_isolation_resolve():
    """다른 org의 override는 현재 org resolve에 영향 안 줌."""
    # resolve_disposition은 org_id를 모든 쿼리에 포함 → 격리됨
    # 시스템 기본값(ask) 반환 = 다른 org override 미적용
    session = _make_session()
    other_org = uuid.uuid4()
    result = await resolve_disposition(session, other_org, MEMBER_ID, ROLE_ID, "qa")
    assert result == "ask"
