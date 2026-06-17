"""S4: org-level 에이전트 grant 시 per-project profile 생성 + 회수 시 profile 제거(grant↔뷰 lockstep)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── ensure_agent_project_profile: 멱등 profile 생성 + 포트 자동 할당 ──────────


@pytest.mark.anyio
async def test_ensure_profile_inserts_and_auto_allocates_port(monkeypatch):
    from app.services import agent_anchor_sync as a

    session = MagicMock()
    session.execute = AsyncMock(return_value=MagicMock())
    monkeypatch.setattr(a, "allocate_fakechat_port", AsyncMock(return_value=8800))

    await a.ensure_agent_project_profile(
        session, member_id=uuid.uuid4(), project_id=uuid.uuid4()
    )
    a.allocate_fakechat_port.assert_awaited_once()  # 포트 미지정 → 자동 할당
    assert session.execute.await_count == 1  # profile pg_insert 1회


@pytest.mark.anyio
async def test_ensure_profile_respects_given_port(monkeypatch):
    from app.services import agent_anchor_sync as a

    session = MagicMock()
    session.execute = AsyncMock(return_value=MagicMock())
    monkeypatch.setattr(a, "allocate_fakechat_port", AsyncMock(return_value=9999))

    await a.ensure_agent_project_profile(
        session, member_id=uuid.uuid4(), project_id=uuid.uuid4(), fakechat_port=8801
    )
    a.allocate_fakechat_port.assert_not_awaited()  # 주어진 포트 사용 → 미할당


# ─── delete_project_access: 에이전트 grant 회수 시 profile 제거 ───────────────


@pytest.mark.anyio
async def test_revoke_agent_grant_removes_profile(monkeypatch):
    from app.routers import project_access as pa

    monkeypatch.setattr(pa, "_require_owner_or_admin", AsyncMock())

    project_id = uuid.uuid4()
    record = MagicMock()
    record.org_member_id = None  # 에이전트 grant
    record.member_id = uuid.uuid4()
    sel_res = MagicMock()
    sel_res.scalar_one_or_none.return_value = record

    session = MagicMock()
    session.execute = AsyncMock(return_value=sel_res)
    session.delete = AsyncMock()
    session.commit = AsyncMock()

    out = await pa.delete_project_access(
        project_id, uuid.uuid4(), auth=MagicMock(), session=session
    )
    assert out == {"ok": True}
    # execute 2회: record select + agent_project_profiles delete
    assert session.execute.await_count == 2
    session.delete.assert_awaited_once_with(record)


@pytest.mark.anyio
async def test_revoke_human_grant_skips_profile_delete(monkeypatch):
    from app.routers import project_access as pa

    monkeypatch.setattr(pa, "_require_owner_or_admin", AsyncMock())

    project_id = uuid.uuid4()
    record = MagicMock()
    record.org_member_id = uuid.uuid4()  # 휴먼 grant
    record.member_id = uuid.uuid4()
    sel_res = MagicMock()
    sel_res.scalar_one_or_none.return_value = record

    session = MagicMock()
    session.execute = AsyncMock(return_value=sel_res)
    session.delete = AsyncMock()
    session.commit = AsyncMock()

    out = await pa.delete_project_access(
        project_id, uuid.uuid4(), auth=MagicMock(), session=session
    )
    assert out == {"ok": True}
    # execute 1회: record select 만 (profile delete 없음)
    assert session.execute.await_count == 1
    session.delete.assert_awaited_once_with(record)
