"""E-MEMBER-POLICY S1: project_access.role enum 토대 — clamp + write 경로 + 마이그 구조."""
from __future__ import annotations

import importlib.util
import pathlib
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── clamp_project_role ───────────────────────────────────────────────────────


def test_clamp_passthrough_enum():
    from app.services.project_auth import clamp_project_role

    assert clamp_project_role("owner") == "owner"
    assert clamp_project_role("admin") == "admin"
    assert clamp_project_role("member") == "member"


def test_clamp_non_enum_to_member():
    from app.services.project_auth import clamp_project_role

    assert clamp_project_role("manager") == "member"  # 레거시 org 랭크 → project 엔 없음
    assert clamp_project_role("") == "member"
    assert clamp_project_role(None) == "member"
    assert clamp_project_role("OWNER") == "member"  # 대소문자 엄격


# ─── write_agent_project_placement: role clamp ────────────────────────────────


@pytest.mark.anyio
async def test_placement_clamps_role(monkeypatch):
    from app.services import agent_anchor_sync as a

    spy = MagicMock(return_value="member")
    monkeypatch.setattr("app.services.project_auth.clamp_project_role", spy)

    session = MagicMock()
    session.execute = AsyncMock(return_value=MagicMock())

    await a.write_agent_project_placement(
        session, member_id=uuid.uuid4(), project_id=uuid.uuid4(), role="manager"
    )
    spy.assert_called_once_with("manager")  # grant role 이 clamp 통과


# ─── apply_anchor_update(PATCH): role clamp ───────────────────────────────────


@pytest.mark.anyio
async def test_patch_anchor_update_clamps_role(monkeypatch):
    from app.repositories.team_member import TeamMemberRepository

    spy = MagicMock(return_value="member")
    monkeypatch.setattr("app.services.project_auth.clamp_project_role", spy)

    session = MagicMock()
    session.execute = AsyncMock(return_value=MagicMock())
    session.flush = AsyncMock()
    repo = TeamMemberRepository(session, uuid.uuid4())

    member = MagicMock()
    member.id = uuid.uuid4()
    member.project_id = uuid.uuid4()

    await repo.apply_anchor_update(member, {"role": "manager", "color": "#fff"})
    spy.assert_called_once_with("manager")  # PATCH role 이 clamp 통과


@pytest.mark.anyio
async def test_patch_anchor_update_no_role_skips_clamp(monkeypatch):
    from app.repositories.team_member import TeamMemberRepository

    spy = MagicMock(return_value="member")
    monkeypatch.setattr("app.services.project_auth.clamp_project_role", spy)

    session = MagicMock()
    session.execute = AsyncMock(return_value=MagicMock())
    session.flush = AsyncMock()
    repo = TeamMemberRepository(session, uuid.uuid4())
    member = MagicMock()
    member.id = uuid.uuid4()
    member.project_id = uuid.uuid4()

    await repo.apply_anchor_update(member, {"color": "#fff"})
    spy.assert_not_called()  # role 미포함 → clamp 미호출


# ─── 마이그 0122 구조 ─────────────────────────────────────────────────────────


def test_migration_0122_chain_and_callables():
    p = (
        pathlib.Path(__file__).parent.parent
        / "alembic/versions/0122_project_access_role_enum.py"
    )
    spec = importlib.util.spec_from_file_location("m0122", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.revision == "0122"
    assert mod.down_revision == "0121"
    assert callable(mod.upgrade)
    assert callable(mod.downgrade)
