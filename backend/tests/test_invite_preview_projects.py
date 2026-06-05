"""정책B surface②: InvitePreview가 invite.project_ids를 프로젝트 이름으로 해소.

invitee는 org 접근 전이라 FE가 프로젝트명을 못 받음 → 수락화면 표시용으로 preview에 포함.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _invite(project_ids):
    inv = MagicMock()
    inv.role = "member"
    inv.status = "pending"
    inv.email = "x@example.com"
    inv.expires_at = datetime.now(timezone.utc) + timedelta(days=5)
    inv.organization_id = ORG_ID
    inv.project_ids = project_ids
    return inv


@pytest.mark.anyio
async def test_get_preview_resolves_project_names():
    from app.repositories.org_invite import OrgInviteRepository

    P = uuid.uuid4()
    row_res = MagicMock(); row_res.first.return_value = (_invite([str(P)]), "Test Org")
    proj_res = MagicMock(); proj_res.all.return_value = [(P, "Project Alpha")]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[row_res, proj_res])

    preview = await OrgInviteRepository(session).get_preview("tok")

    assert preview.org_name == "Test Org"
    assert preview.projects == [{"id": str(P), "name": "Project Alpha"}]
    assert session.execute.await_count == 2  # invite 조회 + project 이름 조회


@pytest.mark.anyio
async def test_get_preview_empty_project_ids_no_extra_query():
    from app.repositories.org_invite import OrgInviteRepository

    row_res = MagicMock(); row_res.first.return_value = (_invite([]), "Test Org")
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[row_res])

    preview = await OrgInviteRepository(session).get_preview("tok")

    assert preview.projects == []
    assert session.execute.await_count == 1  # project_ids 비면 추가 조회 0


@pytest.mark.anyio
async def test_get_preview_not_found_returns_none():
    from app.repositories.org_invite import OrgInviteRepository

    row_res = MagicMock(); row_res.first.return_value = None
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[row_res])

    assert await OrgInviteRepository(session).get_preview("nope") is None
