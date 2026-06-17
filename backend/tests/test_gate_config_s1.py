"""E-HITL-GATING S-GATE-1: gate_config resolve(계층)·set(validate)·엔드포인트(권한)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar(val):
    r = MagicMock()
    r.scalar_one_or_none.return_value = val
    return r


# ── resolve_gate_level: project 오버라이드 → org 기본값 → 'ask' ──────────────


@pytest.mark.anyio
async def test_resolve_project_override_wins():
    from app.services.gate_config import resolve_gate_level

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[_scalar("auto")])  # project 행 존재
    out = await resolve_gate_level(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(), work_type="done", actor_type="agent"
    )
    assert out == "auto"


@pytest.mark.anyio
async def test_resolve_falls_to_org_default():
    from app.services.gate_config import resolve_gate_level

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[_scalar(None), _scalar("block")])  # project 없음·org 있음
    out = await resolve_gate_level(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(), work_type="merge", actor_type="human"
    )
    assert out == "block"


@pytest.mark.anyio
async def test_resolve_default_ask_when_none():
    from app.services.gate_config import resolve_gate_level

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[_scalar(None), _scalar(None)])
    out = await resolve_gate_level(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(), work_type="done", actor_type="agent"
    )
    assert out == "ask"  # §3e 보수적 기본


@pytest.mark.anyio
async def test_resolve_no_project_uses_org_only():
    from app.services.gate_config import resolve_gate_level

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[_scalar("ask")])  # org 쿼리 1번만(project None)
    out = await resolve_gate_level(
        session, org_id=uuid.uuid4(), project_id=None, work_type="done", actor_type="agent"
    )
    assert out == "ask"
    assert session.execute.await_count == 1  # project 쿼리 skip


# ── set_gate_level: enum validate ────────────────────────────────────────────


@pytest.mark.anyio
@pytest.mark.parametrize("wt,at,lvl", [
    ("bogus", "agent", "ask"),
    ("done", "robot", "ask"),
    ("done", "agent", "MAYBE"),
])
async def test_set_invalid_enum_raises(wt, at, lvl):
    from app.services.gate_config import set_gate_level

    with pytest.raises(ValueError):
        await set_gate_level(
            MagicMock(), org_id=uuid.uuid4(), project_id=None,
            work_type=wt, actor_type=at, level=lvl, created_by=None,
        )


# ── 엔드포인트 권한 ───────────────────────────────────────────────────────────


def _auth():
    a = MagicMock()
    a.user_id = str(uuid.uuid4())
    return a


def _org_row(exists=True):
    r = MagicMock()
    r.first.return_value = (uuid.uuid4(),) if exists else None
    return r


@pytest.mark.anyio
async def test_get_member_returns_effective_config():
    """GET = 프로젝트 멤버 read(설계 의도·PO 콜). 멤버면 200 + 전 work_type×actor effective 레벨."""
    from app.routers import gate_config as gc

    session = MagicMock()
    session.execute = AsyncMock(return_value=_org_row())  # _project_org_id
    with patch("app.routers.gate_config.has_project_access", new=AsyncMock(return_value=True)), patch(
        "app.routers.gate_config.resolve_gate_level", new=AsyncMock(return_value="ask")
    ):
        out = await gc.get_gate_config(uuid.uuid4(), auth=_auth(), session=session)
    # WORK_TYPES(2) × ACTOR_TYPES(2) = 4 entries
    assert len(out) == 4
    assert all(e.level == "ask" for e in out)


@pytest.mark.anyio
async def test_get_non_member_403():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    session = MagicMock()
    session.execute = AsyncMock(return_value=_org_row())
    with patch("app.routers.gate_config.has_project_access", new=AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as ei:
            await gc.get_gate_config(uuid.uuid4(), auth=_auth(), session=session)
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_get_missing_project_404():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    session = MagicMock()
    session.execute = AsyncMock(return_value=_org_row(exists=False))
    with pytest.raises(HTTPException) as ei:
        await gc.get_gate_config(uuid.uuid4(), auth=_auth(), session=session)
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_put_missing_project_404():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    session = MagicMock()
    session.execute = AsyncMock(return_value=_org_row(exists=False))
    body = gc.SetGateLevelRequest(scope="org", work_type="done", actor_type="agent", level="ask")
    with pytest.raises(HTTPException) as ei:
        await gc.put_gate_config(uuid.uuid4(), body, auth=_auth(), session=session)
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_put_invalid_level_400():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    session = MagicMock()
    body = gc.SetGateLevelRequest(scope="org", work_type="done", actor_type="agent", level="MAYBE")
    with pytest.raises(HTTPException) as ei:
        await gc.put_gate_config(uuid.uuid4(), body, auth=_auth(), session=session)
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_put_org_scope_non_admin_403():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    session = MagicMock()
    session.execute = AsyncMock(return_value=_org_row())
    body = gc.SetGateLevelRequest(scope="org", work_type="done", actor_type="agent", level="auto")
    with patch("app.routers.gate_config.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as ei:
            await gc.put_gate_config(uuid.uuid4(), body, auth=_auth(), session=session)
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_put_project_scope_non_owner_403():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    session = MagicMock()
    session.execute = AsyncMock(return_value=_org_row())
    body = gc.SetGateLevelRequest(scope="project", work_type="merge", actor_type="human", level="block")
    with patch("app.routers.gate_config.get_project_role", new=AsyncMock(return_value="admin")), patch(
        "app.routers.gate_config.is_org_owner_or_admin", new=AsyncMock(return_value=False)
    ):
        with pytest.raises(HTTPException) as ei:
            await gc.put_gate_config(uuid.uuid4(), body, auth=_auth(), session=session)
    assert ei.value.status_code == 403  # project admin(≠owner)·org admin 아님 → 거부


@pytest.mark.anyio
async def test_put_project_owner_sets_override():
    from app.routers import gate_config as gc

    session = MagicMock()
    session.execute = AsyncMock(return_value=_org_row())
    session.commit = AsyncMock()
    row = MagicMock()
    row.work_type = "merge"
    row.actor_type = "human"
    row.level = "block"
    body = gc.SetGateLevelRequest(scope="project", work_type="merge", actor_type="human", level="block")
    with patch("app.routers.gate_config.get_project_role", new=AsyncMock(return_value="owner")), patch(
        "app.routers.gate_config.set_gate_level", new=AsyncMock(return_value=row)
    ):
        out = await gc.put_gate_config(uuid.uuid4(), body, auth=_auth(), session=session)
    assert out.level == "block"
    session.commit.assert_awaited_once()
