"""E-ONBOARDING 정책B: 초대 시 프로젝트 선택 부여 + list has_project_access 필터.

- invite 생성이 project_ids를 저장
- accept의 _grant_invite_project_access가 (org 소속) 선택 프로젝트에 project_access INSERT
- list_projects가 accessible_project_ids_in_org로 필터
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.notification import Notification  # noqa: F401 (import sanity)
from app.models.org_invite import OrgInvite
from app.models.project_access import ProjectAccess


@pytest.fixture
def anyio_backend():
    return "asyncio"


ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
OM_ID = uuid.uuid4()
P1 = uuid.uuid4()
P2 = uuid.uuid4()


# ─── create: project_ids 저장 ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_invite_stores_project_ids():
    from app.repositories.org_invite import OrgInviteRepository

    session = AsyncMock()
    added = []
    session.add = MagicMock(side_effect=added.append)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()
    repo = OrgInviteRepository(session)
    repo.has_pending_invite = AsyncMock(return_value=False)

    inv = await repo.create(
        org_id=ORG_ID, email="x@example.com", role="member",
        created_by=USER_ID, project_ids=[P1, P2],
    )
    assert inv is not None
    assert [str(P1), str(P2)] == inv.project_ids  # JSONB str 배열로 저장


# ─── _grant_invite_project_access ────────────────────────────────────────────

def _invite(project_ids):
    inv = MagicMock(spec=OrgInvite)
    inv.organization_id = ORG_ID
    inv.role = "member"
    inv.project_ids = project_ids
    return inv


@pytest.mark.anyio
async def test_grant_invite_project_access_inserts_for_org_projects():
    from app.repositories.org_invite import OrgInviteRepository

    session = AsyncMock()
    om_res = MagicMock(); om_res.scalar_one_or_none.return_value = OM_ID
    valid_res = MagicMock(); valid_res.all.return_value = [(P1,)]  # P1만 org 소속(P2 제외)
    insert_res = MagicMock()
    session.execute = AsyncMock(side_effect=[om_res, valid_res, insert_res])
    session.flush = AsyncMock()

    repo = OrgInviteRepository(session)
    await repo._grant_invite_project_access(_invite([str(P1), str(P2)]), USER_ID)

    # 3 execute: om 해소 + valid 조회 + project_access insert(P1 1건)
    assert session.execute.await_count == 3
    last_stmt = session.execute.await_args_list[2].args[0]
    compiled = str(last_stmt)
    assert "project_access" in compiled.lower()


@pytest.mark.anyio
async def test_grant_invite_project_access_noop_when_empty():
    from app.repositories.org_invite import OrgInviteRepository

    session = AsyncMock()
    session.execute = AsyncMock()
    repo = OrgInviteRepository(session)
    await repo._grant_invite_project_access(_invite([]), USER_ID)
    session.execute.assert_not_called()  # project_ids 빈 배열 → 조회/INSERT 0


# ─── list_projects: has_project_access 필터 ──────────────────────────────────

@pytest.mark.anyio
async def test_list_projects_empty_when_no_access(monkeypatch):
    """접근 가능한 프로젝트 0개면 빈 목록(이전엔 org 전체 노출)."""
    import app.routers.projects as projects_mod

    monkeypatch.setattr(
        projects_mod, "accessible_project_ids_in_org",
        AsyncMock(return_value=[]),
    )
    auth = MagicMock(); auth.user_id = str(USER_ID)
    session = AsyncMock()
    out = await projects_mod.list_projects(auth=auth, org_id=ORG_ID, session=session)
    assert out == []
    session.execute.assert_not_called()  # ids 없으면 Project 조회 안 함


@pytest.mark.anyio
async def test_list_projects_returns_only_accessible(monkeypatch):
    """accessible_project_ids_in_org가 준 id의 프로젝트만 반환."""
    import app.routers.projects as projects_mod

    monkeypatch.setattr(
        projects_mod, "accessible_project_ids_in_org",
        AsyncMock(return_value=[P1]),
    )
    from datetime import datetime, timezone
    _now = datetime(2026, 6, 5, tzinfo=timezone.utc)
    proj = MagicMock()
    proj.id = P1; proj.org_id = ORG_ID; proj.name = "P1"
    proj.description = None; proj.created_at = _now; proj.updated_at = _now; proj.deleted_at = None
    proj.violation_level = "warn"
    scalars = MagicMock(); scalars.all.return_value = [proj]
    res = MagicMock(); res.scalars.return_value = scalars
    session = AsyncMock(); session.execute = AsyncMock(return_value=res)
    auth = MagicMock(); auth.user_id = str(USER_ID)

    out = await projects_mod.list_projects(auth=auth, org_id=ORG_ID, session=session)
    assert len(out) == 1
    session.execute.assert_awaited_once()
