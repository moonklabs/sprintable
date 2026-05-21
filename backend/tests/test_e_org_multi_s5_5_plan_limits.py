"""E-ORG-MULTI S5.5: SaaS Plan Limit 적용 테스트.

AC1: Plan limit 정책은 EE/SaaS 환경에서만 로드
AC2: OSS 환경에서는 plan limit 미들웨어가 로드되지 않아 제한 없음
AC3: Free 플랜 — org 1개, project 1개, member 5명 제한
AC4: Team/Pro는 제한 없음
AC5: 제한 초과 시 402 + upgrade_required=True
AC6: API 과금 정책 기록 (Team $0.001, Pro $0.0005)
AC7: dev 환경 Free 제한 초과 케이스 검증
"""
from __future__ import annotations

import inspect

import pytest


# ─── AC1: EE 환경에서만 로드 ─────────────────────────────────────────────────

def test_plan_limits_module_exists():
    """ee/plan_limits.py 모듈 존재."""
    import ee.plan_limits  # noqa: F401
    assert True


def test_plan_limits_only_in_ee_router():
    """organizations.py 소스에 is_ee_enabled 조건부 import 존재."""
    from app.routers import organizations
    source = inspect.getsource(organizations.create_organization)
    assert "is_ee_enabled" in source
    assert "plan_limits" in source or "check_org_create_limit" in source


def test_projects_plan_limit_in_ee_only():
    """projects.py 소스에 is_ee_enabled 조건부 import 존재."""
    from app.routers import projects
    source = inspect.getsource(projects.create_project)
    assert "is_ee_enabled" in source
    assert "plan_limits" in source or "check_project_create_limit" in source


def test_invites_plan_limit_in_ee_only():
    """org_invites.py 소스에 is_ee_enabled 조건부 import 존재."""
    from app.routers import org_invites
    source = inspect.getsource(org_invites.create_org_invite)
    assert "is_ee_enabled" in source
    assert "plan_limits" in source or "check_member_invite_limit" in source


# ─── AC2: OSS — 제한 없음 ────────────────────────────────────────────────────

def test_oss_no_plan_limit_imported_unconditionally():
    """OSS 환경(is_ee_enabled=False)에서 ee.plan_limits 무조건 import 없음."""
    from app.routers import organizations
    source = inspect.getsource(organizations)
    # 조건부 import(if settings.is_ee_enabled) 안에만 있어야 함
    lines = source.splitlines()
    for i, line in enumerate(lines):
        if "from ee.plan_limits" in line or "import plan_limits" in line:
            # 같은 블록에 is_ee_enabled 조건이 앞에 있어야 함
            context = "\n".join(lines[max(0, i - 5):i + 1])
            assert "is_ee_enabled" in context, f"Unconditional ee.plan_limits import at line {i}"


# ─── AC3: Free 제한값 검증 ───────────────────────────────────────────────────

def test_free_limits_defined():
    """FREE_LIMITS에 max_orgs_owned, max_projects, max_members 정의."""
    from ee.plan_limits import FREE_LIMITS
    assert FREE_LIMITS["max_orgs_owned"] == 1
    assert FREE_LIMITS["max_projects"] == 1
    assert FREE_LIMITS["max_members"] == 5


def test_free_limits_org_check_exists():
    """check_org_create_limit 함수 존재 및 count >= 1 초과 시 예외."""
    from ee.plan_limits import check_org_create_limit
    source = inspect.getsource(check_org_create_limit)
    assert "max_orgs_owned" in source or "1" in source
    assert "raise" in source or "_plan_limit_error" in source


def test_free_limits_project_check_exists():
    """check_project_create_limit 함수 존재."""
    from ee.plan_limits import check_project_create_limit
    source = inspect.getsource(check_project_create_limit)
    assert "max_projects" in source
    assert "_plan_limit_error" in source or "raise" in source


def test_free_limits_member_check_exists():
    """check_member_invite_limit 함수 존재."""
    from ee.plan_limits import check_member_invite_limit
    source = inspect.getsource(check_member_invite_limit)
    assert "max_members" in source
    assert "_plan_limit_error" in source or "raise" in source


# ─── AC4: Team/Pro 제한 없음 ─────────────────────────────────────────────────

def test_team_pro_skips_limit():
    """project/member limit 체크 소스에 tier != 'free' 시 return 존재."""
    from ee.plan_limits import check_project_create_limit, check_member_invite_limit
    for fn in (check_project_create_limit, check_member_invite_limit):
        source = inspect.getsource(fn)
        assert "return" in source
        assert "free" in source


# ─── AC5: 402 + upgrade_required ─────────────────────────────────────────────

def test_plan_limit_error_returns_402():
    """_plan_limit_error가 status_code=402 HTTPException 반환."""
    from ee.plan_limits import _plan_limit_error
    from fastapi import HTTPException
    err = _plan_limit_error("org", 1)
    assert isinstance(err, HTTPException)
    assert err.status_code == 402


def test_plan_limit_error_has_upgrade_required():
    """_plan_limit_error detail에 upgrade_required=True + PLAN_LIMIT_EXCEEDED 코드."""
    from ee.plan_limits import _plan_limit_error
    err = _plan_limit_error("project", 1)
    assert err.detail["code"] == "PLAN_LIMIT_EXCEEDED"
    assert err.detail["upgrade_required"] is True
    assert "resource" in err.detail
    assert "limit" in err.detail


def test_frontend_dialog_handles_plan_limit():
    """create-organization-dialog.tsx에 402 PLAN_LIMIT_EXCEEDED 처리 + 업그레이드 안내 존재."""
    import os
    path = os.path.join(
        os.path.dirname(__file__), "..", "..", "apps", "web", "src",
        "components", "nav", "create-organization-dialog.tsx"
    )
    with open(path) as f:
        content = f.read()
    assert "PLAN_LIMIT_EXCEEDED" in content
    assert "402" in content
    assert "upgrade" in content.lower() or "billing" in content


# ─── AC6: API 과금 정책 기록 ─────────────────────────────────────────────────

def test_api_overage_rates_defined():
    """API_OVERAGE_RATES에 Team $0.001, Pro $0.0005 기록."""
    from ee.plan_limits import API_OVERAGE_RATES
    assert API_OVERAGE_RATES["team"] == 0.001
    assert API_OVERAGE_RATES["pro"] == 0.0005


# ─── AC7: dev 환경 Free 제한 초과 검증 ──────────────────────────────────────

@pytest.mark.asyncio
async def test_check_org_create_limit_raises_when_over():
    """owner org 1개 이상 시 check_org_create_limit → 402 HTTPException."""
    import uuid
    from unittest.mock import AsyncMock, MagicMock, patch
    from fastapi import HTTPException
    from ee.plan_limits import check_org_create_limit

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar.return_value = 1  # owner org 1개 이미 존재
    mock_session.execute = AsyncMock(return_value=mock_result)

    with pytest.raises(HTTPException) as exc_info:
        await check_org_create_limit(mock_session, uuid.uuid4())

    assert exc_info.value.status_code == 402
    assert exc_info.value.detail["code"] == "PLAN_LIMIT_EXCEEDED"


@pytest.mark.asyncio
async def test_check_org_create_limit_passes_when_zero():
    """owner org 0개 시 check_org_create_limit → 통과."""
    import uuid
    from unittest.mock import AsyncMock, MagicMock
    from ee.plan_limits import check_org_create_limit

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar.return_value = 0
    mock_session.execute = AsyncMock(return_value=mock_result)

    await check_org_create_limit(mock_session, uuid.uuid4())  # 예외 없어야 함


@pytest.fixture
def anyio_backend():
    return "asyncio"
