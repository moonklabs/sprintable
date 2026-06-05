"""0d68ad20: grant-only/admin 휴먼(team_member 행 없음) project-scoped 인가 불일치 fix.

근본: project-scoped 엔드포인트가 team_member 행만 요구(403) — `/api/projects`(has_project_access
SSOT 3-branch)엔 보이는 프로젝트가 알림/코멘트에선 403. fix: team_member 없어도 grant/admin이면 403 금지.
- event_notifications._resolve_member_id: has_project_access면 None(빈 결과)·없으면 403.
- stories._resolve_team_member_id / docs._resolve_doc_member_id: resolve_member SSOT 폴백(org_member.id).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

ORG = uuid.uuid4()
USER = uuid.uuid4()
PROJ = uuid.uuid4()
OM_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    a = MagicMock()
    a.user_id = str(USER)
    a.claims = {"app_metadata": {}}
    return a


def _no_team_member_db():
    db = AsyncMock()
    res = MagicMock(); res.scalar_one_or_none.return_value = None  # team_member 없음
    db.execute = AsyncMock(return_value=res)
    return db


# ─── event_notifications._resolve_member_id ──────────────────────────────────

@pytest.mark.anyio
async def test_event_notif_grant_only_uses_ssot_resolver():
    """team_member 없으면 resolve_member(SSOT)로 canonical org_member.id 해소(403 금지)."""
    from app.routers import event_notifications as en

    db = _no_team_member_db()
    rm = MagicMock(); rm.id = OM_ID
    with patch("app.services.member_resolver.resolve_member", new=AsyncMock(return_value=rm)):
        mid = await en._resolve_member_id(_auth(), ORG, db, project_id=PROJ)
    assert mid == OM_ID  # canonical id (None 아님 — team_member 곱연산 의존 제거)


@pytest.mark.anyio
async def test_event_notif_no_access_still_403():
    """team_member 없고 접근권도 없으면 resolve_member가 403(미인가 보호 유지)."""
    from app.routers import event_notifications as en

    db = _no_team_member_db()
    raiser = AsyncMock(side_effect=HTTPException(status_code=403, detail="No access to this project"))
    with patch("app.services.member_resolver.resolve_member", new=raiser):
        with pytest.raises(HTTPException) as ei:
            await en._resolve_member_id(_auth(), ORG, db, project_id=PROJ)
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_event_notif_team_member_path_unchanged():
    """team_member 있으면 그 id 반환(기존 동작)."""
    from app.routers import event_notifications as en

    db = AsyncMock()
    res = MagicMock(); res.scalar_one_or_none.return_value = OM_ID
    db.execute = AsyncMock(return_value=res)
    mid = await en._resolve_member_id(_auth(), ORG, db, project_id=PROJ)
    assert mid == OM_ID


# ─── stories / docs: resolve_member 폴백 ─────────────────────────────────────

@pytest.mark.anyio
async def test_stories_resolve_falls_back_to_org_member():
    """team_member 없으면 resolve_member(SSOT)로 org_member.id 폴백(403 금지)."""
    from app.routers import stories

    db = _no_team_member_db()
    rm = MagicMock(); rm.id = OM_ID
    with patch("app.services.member_resolver.resolve_member", new=AsyncMock(return_value=rm)):
        mid = await stories._resolve_team_member_id(_auth(), ORG, db)
    assert mid == OM_ID


@pytest.mark.anyio
async def test_docs_resolve_falls_back_to_org_member():
    from app.routers import docs

    db = _no_team_member_db()
    rm = MagicMock(); rm.id = OM_ID
    with patch("app.services.member_resolver.resolve_member", new=AsyncMock(return_value=rm)):
        mid = await docs._resolve_doc_member_id(_auth(), ORG, db)
    assert mid == OM_ID
