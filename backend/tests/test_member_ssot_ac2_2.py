"""E-MEMBER-SSOT AC2-2: 인가전환·B하드닝 회귀 테스트.

get_project_scoped_org_id / dispatch_entity / notification_preferences 가
TeamMember-존재 대신 has_project_access / resolve_member_identity 기반으로
전환돼 grant-only 휴먼(org_member)을 수용하는지 검증.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from app.services.member_resolver import ResolvedMember


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── B2: notification_preferences.member_id team_members FK 제거 ───────────────

def test_notification_preferences_member_id_has_no_team_members_fk():
    """B2 회귀: member_id의 team_members FK가 제거돼 grant-only 휴먼(org_member.id)
    upsert 시 FK violation 500이 나지 않음 (migration 0073)."""
    from app.models.notification_preference import NotificationPreference

    member_col = NotificationPreference.__table__.c.member_id
    referred_tables = {fk.column.table.name for fk in member_col.foreign_keys}
    assert "team_members" not in referred_tables


# ── get_project_scoped_org_id: has_project_access 위임 (740e3b7e) ─────────────

@pytest.mark.anyio
async def test_get_project_scoped_grant_only_allows():
    """grant-only 휴먼(team_member 없음, has_project_access=True)도 project org 접근 허용."""
    from app.dependencies.auth import get_project_scoped_org_id

    project_id = uuid.uuid4()
    project_org = uuid.uuid4()
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(project_org)}}

    db = AsyncMock()
    proj_result = MagicMock()
    proj_result.scalar_one_or_none.return_value = project_org
    db.execute = AsyncMock(return_value=proj_result)

    with patch("app.dependencies.auth.get_verified_org_id", new=AsyncMock(return_value=project_org)), \
         patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=True)):
        result = await get_project_scoped_org_id(
            project_id=project_id, auth=ctx, x_org_id=None, db=db, request=None
        )
    assert result == project_org


@pytest.mark.anyio
async def test_get_project_scoped_no_access_403():
    """team_member·grant·owner/admin 어디에도 없으면 403."""
    from app.dependencies.auth import get_project_scoped_org_id

    project_id = uuid.uuid4()
    project_org = uuid.uuid4()
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(project_org)}}

    db = AsyncMock()
    proj_result = MagicMock()
    proj_result.scalar_one_or_none.return_value = project_org
    db.execute = AsyncMock(return_value=proj_result)

    with patch("app.dependencies.auth.get_verified_org_id", new=AsyncMock(return_value=project_org)), \
         patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as exc:
            await get_project_scoped_org_id(
                project_id=project_id, auth=ctx, x_org_id=None, db=db, request=None
            )
    assert exc.value.status_code == 403


# ── c6b82459: cross-org re-entry 차단 (0-project switch 직후 stale project_id) ──

@pytest.mark.anyio
async def test_get_project_scoped_cross_org_without_header_rejected():
    """JWT org 스코프와 다른 org 의 project_id 가 X-Org-Id 헤더 없이 들어오면 403.

    0-project org 로 switch 직후 옛 프로젝트 query(stale)가 옛 org 로 재진입(leak)하던
    경로 차단. has_project_access=True 여도 cross-org 가드가 먼저 거부함을 증명.
    """
    from app.dependencies.auth import get_project_scoped_org_id

    project_id = uuid.uuid4()
    project_org = uuid.uuid4()      # project 가 속한 (옛) org
    scoped_org = uuid.uuid4()       # 현재 JWT 스코프 org (switch 대상, project_org 와 다름)
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(scoped_org)}}

    db = AsyncMock()
    proj_result = MagicMock()
    proj_result.scalar_one_or_none.return_value = project_org
    db.execute = AsyncMock(return_value=proj_result)

    has_access = AsyncMock(return_value=True)
    with patch("app.dependencies.auth.get_verified_org_id", new=AsyncMock(return_value=scoped_org)), \
         patch("app.services.project_auth.has_project_access", new=has_access):
        with pytest.raises(HTTPException) as exc:
            await get_project_scoped_org_id(
                project_id=project_id, auth=ctx, x_org_id=None, db=db, request=None
            )
    assert exc.value.status_code == 403
    has_access.assert_not_awaited()  # cross-org 가드가 access 체크보다 먼저 차단


@pytest.mark.anyio
async def test_get_project_scoped_cross_org_with_matching_header_allowed():
    """X-Org-Id 헤더로 cross-org 가 명시 요청되면(=get_verified_org_id 가 그 org 로 해소)
    project_org 와 일치하므로 허용 — unified-switcher cross-org 프리뷰 보존."""
    from app.dependencies.auth import get_project_scoped_org_id

    project_id = uuid.uuid4()
    project_org = uuid.uuid4()
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(uuid.uuid4())}}  # JWT 는 다른 org

    db = AsyncMock()
    proj_result = MagicMock()
    proj_result.scalar_one_or_none.return_value = project_org
    db.execute = AsyncMock(return_value=proj_result)

    # X-Org-Id=project_org 명시 → get_verified_org_id 가 membership 검증 후 project_org 반환
    with patch("app.dependencies.auth.get_verified_org_id", new=AsyncMock(return_value=project_org)), \
         patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=True)):
        result = await get_project_scoped_org_id(
            project_id=project_id, auth=ctx, x_org_id=str(project_org), db=db, request=None
        )
    assert result == project_org


# ── dispatch_entity: assignee resolve_member_identity (7f8066a3) ──────────────

async def _dispatch_client(mock_session, org_id):
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(org_id)}}

    async def _db():
        yield mock_session

    async def _auth():
        return ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


@pytest.mark.anyio
async def test_dispatch_grant_only_human_assignee_dispatched():
    """grant-only 휴먼 assignee(team_member 없음)도 dispatched=True (7f8066a3 오탐 해소)."""
    org_id = uuid.uuid4()
    assignee_id = uuid.uuid4()
    project_id = uuid.uuid4()

    session = AsyncMock()
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    # sender 조회 2건(TeamMember, OrgMember) 모두 None
    sender_result = MagicMock()
    sender_result.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=sender_result)

    async def _refresh(obj):
        pass
    session.refresh.side_effect = _refresh

    client, app = await _dispatch_client(session, org_id)
    try:
        assignee_member = ResolvedMember(
            id=assignee_id, user_id=uuid.uuid4(), name="grant휴먼",
            type="human", role="member", org_id=org_id,
        )
        with patch("app.services.agent_dispatch._fetch_entity",
                   new=AsyncMock(return_value=(assignee_id, "에픽 제목", "설명", project_id))), \
             patch("app.services.agent_dispatch.resolve_member_identity",
                   new=AsyncMock(return_value=assignee_member)), \
             patch("app.services.agent_dispatch.dispatch_notification", new=AsyncMock()):
            async with client as c:
                resp = await c.post("/api/v2/dispatch", json={
                    "entity_type": "epic",
                    "entity_id": str(uuid.uuid4()),
                    "project_id": str(project_id),
                })
        assert resp.status_code == 200
        data = resp.json()
        assert data["dispatched"] is True
        assert data["assignee_type"] == "human"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dispatch_assignee_not_in_org_not_dispatched():
    """assignee가 org 어디에도 없으면(resolve None) dispatched=False."""
    org_id = uuid.uuid4()
    assignee_id = uuid.uuid4()
    project_id = uuid.uuid4()

    session = AsyncMock()
    session.add = MagicMock()
    session.execute = AsyncMock()

    client, app = await _dispatch_client(session, org_id)
    try:
        with patch("app.services.agent_dispatch._fetch_entity",
                   new=AsyncMock(return_value=(assignee_id, "제목", "설명", project_id))), \
             patch("app.services.agent_dispatch.resolve_member_identity",
                   new=AsyncMock(return_value=None)):
            async with client as c:
                resp = await c.post("/api/v2/dispatch", json={
                    "entity_type": "epic",
                    "entity_id": str(uuid.uuid4()),
                    "project_id": str(project_id),
                })
        assert resp.status_code == 200
        assert resp.json()["dispatched"] is False
    finally:
        app.dependency_overrides.clear()
