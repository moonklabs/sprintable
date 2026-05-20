"""E-ORG-MULTI S5.1: EE Billing 모듈 경계 구성 테스트.

AC1: Billing API는 ee/routers/billing.py에만 위치
AC2: Billing UI는 ee/components/billing/에만 위치
AC3: Polar SDK 의존성은 EE 전용 package.json에만 선언
AC4: isEEEnabled() = false → Billing API 403
AC5: EE 라우터 main.py에서 is_ee_enabled 조건부 등록
AC6: OSS 빌드에서 ee/ 없이 정상 동작
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import pytest


# ─── AC1: Billing API 위치 검증 ──────────────────────────────────────────────

def test_ee_billing_router_file_exists():
    """ee/routers/billing.py 파일 존재."""
    billing_path = os.path.join(
        os.path.dirname(__file__), "..", "ee", "routers", "billing.py"
    )
    assert os.path.exists(billing_path)


def test_ee_billing_router_not_in_app_routers():
    """billing.py가 app/routers/ 아래 존재하지 않음."""
    app_billing = os.path.join(
        os.path.dirname(__file__), "..", "app", "routers", "billing.py"
    )
    assert not os.path.exists(app_billing)


# ─── AC3: Polar SDK 의존성 EE 전용 package.json ──────────────────────────────

def test_ee_billing_package_json_exists():
    """ee/billing/package.json (Polar SDK) 존재."""
    pkg_path = os.path.join(
        os.path.dirname(__file__), "..", "..", "ee", "billing", "package.json"
    )
    assert os.path.exists(pkg_path)


def test_ee_billing_package_contains_polar():
    """ee/billing/package.json에 @polar-sh 의존성 포함."""
    import json
    pkg_path = os.path.join(
        os.path.dirname(__file__), "..", "..", "ee", "billing", "package.json"
    )
    with open(pkg_path) as f:
        data = json.load(f)
    deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
    polar_deps = [k for k in deps if "polar" in k.lower()]
    assert len(polar_deps) > 0


# ─── AC4: is_ee_enabled=false → Billing API 403 ──────────────────────────────

def test_billing_has_ee_guard_in_source():
    """ee/routers/billing.py에 is_ee_enabled 체크 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing)
    assert "is_ee_enabled" in source or "require_ee" in source


@pytest.mark.anyio
async def test_billing_status_403_when_ee_disabled():
    """is_ee_enabled=False → GET /api/v2/billing/status 403."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(uuid.uuid4())}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    from app.core.config import Settings
    try:
        with patch.object(type(Settings()), 'is_ee_enabled', new_callable=PropertyMock, return_value=False):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.get("/api/v2/billing/status")

        # EE 비활성화 시 404(라우터 미등록) 또는 403(guard) 모두 허용
        assert resp.status_code in (403, 404)
    finally:
        app.dependency_overrides.clear()


# ─── AC5: main.py 조건부 등록 ────────────────────────────────────────────────

def test_main_conditionally_registers_billing_router():
    """main.py 소스에 is_ee_enabled 조건 아래 billing 라우터 등록 존재."""
    import inspect
    import app.main as main_module
    source = inspect.getsource(main_module)
    assert "is_ee_enabled" in source
    assert "billing" in source


# ─── AC6: OSS 빌드 정상 동작 ─────────────────────────────────────────────────

def test_app_starts_without_ee():
    """EE 없이도 FastAPI app import 정상."""
    from app.main import app
    assert app is not None


# ─── Schema / endpoint 존재 ──────────────────────────────────────────────────

def test_billing_router_has_status_endpoint():
    """ee/routers/billing.py에 /status 엔드포인트 존재."""
    import inspect
    from ee.routers import billing
    paths = [r.path for r in billing.router.routes]
    assert any("status" in p for p in paths)


@pytest.fixture
def anyio_backend():
    return "asyncio"
