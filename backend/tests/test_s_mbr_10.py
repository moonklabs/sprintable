"""S-MBR-10: BE permission 모델 전환 — default allow → default no access (grant 모델).

AC1: 프로젝트 접근은 명시적 grant 레코드가 있어야 가능 (default=no access)
AC2: Org Owner/Admin은 grant 없이도 전 프로젝트 접근 (S-MBR-03 역할 상속 유지)
AC3: Org Member는 명시적 grant 필요
AC4: 데이터 마이그레이션 — denied 레코드 삭제, allowed→granted
AC5: 조직에서 삭제 시 해당 사용자의 project grant 자동 삭제
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── AC1: grant 모델 구조 검증 ──────────────────────────────────────────────

def test_project_access_model_grant_default():
    """ProjectAccess 모델 default permission='granted'."""
    from app.models.project_access import ProjectAccess
    col = ProjectAccess.__table__.c["permission"]
    assert col.server_default.arg == "granted"


def test_members_sql_uses_exists_granted():
    """list_members SQL에 EXISTS(granted) 조건 포함 — grant 모델 AC1."""
    from app.routers import members
    source = inspect.getsource(members.list_members)
    assert "granted" in source
    assert "EXISTS" in source.upper()


def test_project_access_create_defaults_granted():
    """ProjectAccessCreate 기본 permission='granted'."""
    from app.routers.project_access import ProjectAccessCreate
    obj = ProjectAccessCreate(org_member_id="00000000-0000-0000-0000-000000000001")
    assert obj.permission == "granted"


@pytest.mark.anyio
async def test_project_access_create_rejects_denied():
    """ProjectAccessCreate permission='denied' 는 validation에서 거부됨."""
    from app.routers.project_access import create_project_access, ProjectAccessCreate
    from fastapi import HTTPException

    body = ProjectAccessCreate(org_member_id=uuid.uuid4(), permission="denied")

    with patch("app.routers.project_access._require_owner_or_admin", new=AsyncMock(return_value=None)):
        session = AsyncMock()
        auth = MagicMock()
        try:
            await create_project_access(uuid.uuid4(), body, auth, session)
            assert False, "HTTPException expected"
        except HTTPException as e:
            assert e.status_code == 400
            assert "granted" in e.detail


# ─── AC2: Org Owner/Admin은 grant 없이 항상 포함 ─────────────────────────────

def test_members_sql_owner_admin_bypass_grant_model():
    """list_members SQL에 owner/admin OR EXISTS(granted) 패턴 존재 (AC2+AC1)."""
    from app.routers import members
    source = inspect.getsource(members.list_members)
    assert "owner" in source
    assert "admin" in source
    assert "OR" in source.upper()
    assert "granted" in source


@pytest.mark.anyio
async def test_list_members_org_member_requires_grant():
    """AC1/AC3: org member는 grant 레코드 없으면 목록에서 제외."""
    from app.routers.members import list_members

    project_id = uuid.uuid4()
    org_id = uuid.uuid4()
    mock_session = AsyncMock()

    owner_id = uuid.uuid4()
    member_id = uuid.uuid4()

    # E-SECURITY SEC-S6: list_members가 먼저 project의 실 org_id를 조회해 caller org와 대조한다.
    org_lookup_mock = MagicMock()
    org_lookup_mock.scalar_one_or_none.return_value = org_id

    # owner 포함, member 미포함 (grant 없음)
    human_mock = MagicMock()
    human_mock.__iter__ = MagicMock(return_value=iter([
        (owner_id, "owner@example.com", "owner"),
        # member는 grant 없으므로 SQL에서 이미 제외됨
    ]))

    agent_mock = MagicMock()
    agent_mock.scalars.return_value.all.return_value = []

    mock_session.execute = AsyncMock(side_effect=[org_lookup_mock, human_mock, agent_mock])
    mock_auth = MagicMock()

    result = await list_members(project_id=project_id, session=mock_session, _auth=mock_auth, org_id=org_id)
    assert len(result) == 1
    assert result[0].role == "owner"


@pytest.mark.anyio
async def test_list_members_member_with_grant_included():
    """AC1: org member도 grant 레코드 있으면 목록에 포함."""
    from app.routers.members import list_members

    project_id = uuid.uuid4()
    org_id = uuid.uuid4()
    mock_session = AsyncMock()

    owner_id = uuid.uuid4()
    member_id = uuid.uuid4()

    # E-SECURITY SEC-S6: list_members가 먼저 project의 실 org_id를 조회해 caller org와 대조한다.
    org_lookup_mock = MagicMock()
    org_lookup_mock.scalar_one_or_none.return_value = org_id

    # owner + member(grant 있음) 둘 다 포함
    human_mock = MagicMock()
    human_mock.__iter__ = MagicMock(return_value=iter([
        (owner_id, "owner@example.com", "owner"),
        (member_id, "member@example.com", "member"),
    ]))

    agent_mock = MagicMock()
    agent_mock.scalars.return_value.all.return_value = []

    mock_session.execute = AsyncMock(side_effect=[org_lookup_mock, human_mock, agent_mock])
    mock_auth = MagicMock()

    result = await list_members(project_id=project_id, session=mock_session, _auth=mock_auth, org_id=org_id)
    assert len(result) == 2
    roles = {r.role for r in result}
    assert "owner" in roles
    assert "member" in roles


# ─── AC4: migration 검증 ─────────────────────────────────────────────────────

def test_migration_0055_exists():
    """Alembic migration 0055 파일 존재 (AC4 데이터 마이그레이션)."""
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")
    files = os.listdir(base)
    assert any("0055" in f for f in files), "migration 0055 not found"


def test_migration_0055_deletes_denied():
    """0055 upgrade에 denied 레코드 삭제 로직 포함."""
    import importlib.util, os
    base = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")
    path = next(
        os.path.join(base, f) for f in os.listdir(base) if "0055" in f
    )
    spec = importlib.util.spec_from_file_location("migration_0055", path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    source = open(path).read()
    assert "denied" in source
    assert "DELETE" in source.upper() or "delete" in source


def test_migration_0055_converts_allowed_to_granted():
    """0055 upgrade에 allowed→granted 변환 로직 포함."""
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")
    path = next(
        os.path.join(base, f) for f in os.listdir(base) if "0055" in f
    )
    source = open(path).read()
    assert "allowed" in source
    assert "granted" in source


# ─── AC5: 조직 삭제 시 project_access cascade ────────────────────────────────

def test_delete_org_member_deletes_project_access():
    """delete_org_member 소스에 project_access 삭제 로직 포함 (AC5)."""
    from app.routers import org_members as om_module
    source = inspect.getsource(om_module.delete_org_member)
    assert "project_access" in source
    assert "DELETE" in source.upper() or "delete" in source
