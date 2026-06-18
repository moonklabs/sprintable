"""E-HITL-GATING S-GATE-4 BE 지원: resolve_with_source(override/org_default)·delete_override·DELETE 권한."""
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


def _auth():
    a = MagicMock()
    a.user_id = str(uuid.uuid4())
    return a


def _org_row(exists=True):
    r = MagicMock()
    r.first.return_value = (uuid.uuid4(),) if exists else None
    return r


# ── resolve_gate_level_with_source ────────────────────────────────────────────


@pytest.mark.anyio
async def test_source_override_when_project_row():
    from app.services.gate_config import resolve_gate_level_with_source

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[_scalar("auto")])  # project 행 존재
    lvl, src = await resolve_gate_level_with_source(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(), work_type="done", actor_type="agent"
    )
    assert (lvl, src) == ("auto", "override")


@pytest.mark.anyio
async def test_source_org_default_when_org_row():
    from app.services.gate_config import resolve_gate_level_with_source

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[_scalar(None), _scalar("block")])  # project 없음·org 있음
    lvl, src = await resolve_gate_level_with_source(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(), work_type="merge", actor_type="human"
    )
    assert (lvl, src) == ("block", "org_default")


@pytest.mark.anyio
async def test_source_org_default_when_system_default():
    from app.services.gate_config import resolve_gate_level_with_source

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[_scalar(None), _scalar(None)])  # 둘 다 없음 → 시스템 기본 ask
    lvl, src = await resolve_gate_level_with_source(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(), work_type="done", actor_type="agent"
    )
    assert (lvl, src) == ("ask", "org_default")  # 상속(미재정의)


# ── delete_gate_override ──────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_delete_override_true_when_row_removed():
    from app.services.gate_config import delete_gate_override

    session = MagicMock()
    res = MagicMock()
    res.rowcount = 1
    session.execute = AsyncMock(return_value=res)
    session.flush = AsyncMock()
    out = await delete_gate_override(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(), work_type="done", actor_type="agent"
    )
    assert out is True


@pytest.mark.anyio
async def test_delete_override_false_when_none():
    from app.services.gate_config import delete_gate_override

    session = MagicMock()
    res = MagicMock()
    res.rowcount = 0
    session.execute = AsyncMock(return_value=res)
    session.flush = AsyncMock()
    out = await delete_gate_override(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(), work_type="done", actor_type="agent"
    )
    assert out is False  # 멱등 — 없는 override 삭제는 False


@pytest.mark.anyio
@pytest.mark.parametrize("wt,at", [("bogus", "agent"), ("done", "robot")])
async def test_delete_override_invalid_enum(wt, at):
    from app.services.gate_config import delete_gate_override

    with pytest.raises(ValueError):
        await delete_gate_override(
            MagicMock(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), work_type=wt, actor_type=at
        )


# ── DELETE 엔드포인트 권한 ─────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_delete_endpoint_non_owner_403():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    session = MagicMock()
    session.execute = AsyncMock(return_value=_org_row())  # _project_org_id
    with patch("app.routers.gate_config.get_project_role", new=AsyncMock(return_value="member")), patch(
        "app.routers.gate_config.is_org_owner_or_admin", new=AsyncMock(return_value=False)
    ):
        with pytest.raises(HTTPException) as ei:
            await gc.delete_gate_config_override(
                uuid.uuid4(), work_type="done", actor_type="agent", auth=_auth(), session=session
            )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_delete_endpoint_invalid_enum_400():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    with pytest.raises(HTTPException) as ei:
        await gc.delete_gate_config_override(
            uuid.uuid4(), work_type="bogus", actor_type="agent", auth=_auth(), session=MagicMock()
        )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_delete_endpoint_owner_reverts_to_inherited():
    from app.routers import gate_config as gc

    session = MagicMock()
    session.execute = AsyncMock(return_value=_org_row())
    session.commit = AsyncMock()
    with patch("app.routers.gate_config.get_project_role", new=AsyncMock(return_value="owner")), patch(
        "app.routers.gate_config.delete_gate_override", new=AsyncMock(return_value=True)
    ), patch(
        "app.routers.gate_config.resolve_gate_level_with_source",
        new=AsyncMock(return_value=("ask", "org_default")),
    ):
        out = await gc.delete_gate_config_override(
            uuid.uuid4(), work_type="done", actor_type="agent", auth=_auth(), session=session
        )
    assert out.level == "ask"
    assert out.source == "org_default"  # 삭제 후 상속값 반환
    session.commit.assert_awaited_once()


# ── org-layer GET (org 기본값 단독) ────────────────────────────────────────────


@pytest.mark.anyio
async def test_org_gate_config_admin_returns_org_defaults():
    from app.routers import gate_config as gc

    oid = uuid.uuid4()
    with patch(
        "app.routers.gate_config.is_org_owner_or_admin", new=AsyncMock(return_value=True)
    ), patch(
        "app.routers.gate_config.resolve_gate_level_with_source",
        new=AsyncMock(return_value=("ask", "org_default")),
    ):
        out = await gc.get_org_gate_config(
            oid, session=MagicMock(), verified_org_id=oid, auth=_auth()
        )
    assert len(out) == 4  # WORK_TYPES(2) × ACTOR_TYPES(2)
    assert all(e.source == "org_default" for e in out)


@pytest.mark.anyio
async def test_org_gate_config_org_mismatch_403():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    with pytest.raises(HTTPException) as ei:
        await gc.get_org_gate_config(
            uuid.uuid4(), session=MagicMock(), verified_org_id=uuid.uuid4(), auth=_auth()
        )
    assert ei.value.status_code == 403  # 타 org 조회 차단


@pytest.mark.anyio
async def test_org_gate_config_non_admin_403():
    """QA RC: org-GET=org 전체 기본값 관리 surface라 org owner/admin only(project GET 멤버-read와 분리)."""
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    oid = uuid.uuid4()
    with patch("app.routers.gate_config.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as ei:
            await gc.get_org_gate_config(
                oid, session=MagicMock(), verified_org_id=oid, auth=_auth()
            )
    assert ei.value.status_code == 403  # 비-admin 차단


# ── org-PUT (org 기본값 설정·org-scoped) ───────────────────────────────────────


def _org_body():
    from app.routers import gate_config as gc

    return gc.OrgGateLevelRequest(work_type="done", actor_type="agent", level="ask")


@pytest.mark.anyio
async def test_org_put_admin_sets_default():
    from app.routers import gate_config as gc

    oid = uuid.uuid4()
    session = MagicMock()
    session.commit = AsyncMock()
    row = MagicMock(work_type="done", actor_type="agent", level="ask")
    with patch("app.routers.gate_config.is_org_owner_or_admin", new=AsyncMock(return_value=True)), patch(
        "app.routers.gate_config.set_gate_level", new=AsyncMock(return_value=row)
    ):
        out = await gc.put_org_gate_config(
            oid, _org_body(), session=session, verified_org_id=oid, auth=_auth()
        )
    assert out.level == "ask"
    assert out.source == "org_default"
    session.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_org_put_non_admin_403():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    oid = uuid.uuid4()
    with patch("app.routers.gate_config.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as ei:
            await gc.put_org_gate_config(
                oid, _org_body(), session=MagicMock(), verified_org_id=oid, auth=_auth()
            )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_org_put_mismatch_403():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    with pytest.raises(HTTPException) as ei:
        await gc.put_org_gate_config(
            uuid.uuid4(), _org_body(), session=MagicMock(), verified_org_id=uuid.uuid4(), auth=_auth()
        )
    assert ei.value.status_code == 403  # 타 org 차단


@pytest.mark.anyio
async def test_org_put_invalid_level_400():
    from fastapi import HTTPException

    from app.routers import gate_config as gc

    oid = uuid.uuid4()
    body = gc.OrgGateLevelRequest(work_type="done", actor_type="agent", level="MAYBE")
    with pytest.raises(HTTPException) as ei:
        await gc.put_org_gate_config(
            oid, body, session=MagicMock(), verified_org_id=oid, auth=_auth()
        )
    assert ei.value.status_code == 400