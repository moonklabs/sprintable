"""E-MEMBER-POLICY S1 fix: 초대 수락 project_access INSERT 가 role 을 enum 으로 clamp 하는지.

re-QA 적출(3번째 미clamp write 경로): org_invite._grant_invite_project_access 가 invite.role
(라우터 미validation·org 'manager' 가능)을 그대로 INSERT → 0122 CHECK 위반(수락 500). clamp 로 차단.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_grant_invite_project_access_clamps_role(monkeypatch):
    from app.repositories.org_invite import OrgInviteRepository

    spy = MagicMock(return_value="member")
    monkeypatch.setattr("app.services.project_auth.clamp_project_role", spy)

    pid = uuid.uuid4()
    user_id = uuid.uuid4()
    invite = MagicMock()
    invite.organization_id = uuid.uuid4()
    invite.project_ids = [str(pid)]
    invite.role = "manager"  # org enum — project 엔 없음 → clamp 대상

    om_res = MagicMock()
    om_res.scalar_one_or_none.return_value = uuid.uuid4()  # om_id 해소됨
    valid_res = MagicMock()
    valid_res.all.return_value = [(pid,)]  # invite org 소속 프로젝트 1개

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[om_res, valid_res, MagicMock()])
    session.flush = AsyncMock()

    repo = OrgInviteRepository(session)
    await repo._grant_invite_project_access(invite, user_id)

    spy.assert_called_once_with("manager")  # INSERT role 이 clamp 통과


@pytest.mark.anyio
async def test_grant_invite_no_projects_skips(monkeypatch):
    from app.repositories.org_invite import OrgInviteRepository

    spy = MagicMock(return_value="member")
    monkeypatch.setattr("app.services.project_auth.clamp_project_role", spy)

    invite = MagicMock()
    invite.project_ids = []  # 선택 프로젝트 없음 → early return

    session = MagicMock()
    session.execute = AsyncMock()
    repo = OrgInviteRepository(session)
    await repo._grant_invite_project_access(invite, uuid.uuid4())

    spy.assert_not_called()
