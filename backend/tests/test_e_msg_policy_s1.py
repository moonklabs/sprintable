"""E-MSG-POLICY S1: agent DM 인가 모드(creator_only/org_wide/list) enforcement.

⭐ 핵심 안전조건: agent↔agent는 어떤 모드에서도 게이팅 skip (팀 comms 불변).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.routers.conversations import _enforce_agent_creator_policy
from app.services.member_resolver import ResolvedMember

ORG_ID = uuid.uuid4()


def _make_auth() -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    return ctx


def _human_sender(member_id: uuid.UUID, user_id: uuid.UUID) -> ResolvedMember:
    return ResolvedMember(id=member_id, user_id=user_id, name="u", type="human",
                          role="member", org_id=ORG_ID)


def _agent(agent_id: uuid.UUID, mode: str, created_by: uuid.UUID | None) -> MagicMock:
    a = MagicMock()
    a.id = agent_id
    a.type = "agent"
    a.created_by = created_by
    a.message_policy_mode = mode
    return a


def _result(items):
    r = MagicMock()
    r.scalars.return_value.all.return_value = items
    return r


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ⭐ agent↔agent skip — 모드 무관 (팀 comms 불변) ────────────────────────────

@pytest.mark.anyio
async def test_agent_to_agent_skip_even_with_list_mode():
    """두 에이전트 대화 — 한쪽이 list 모드여도 게이팅 skip(403 없음)."""
    a1, a2 = uuid.uuid4(), uuid.uuid4()
    sender_agent = _agent(a1, "list", None)
    other_agent = _agent(a2, "list", None)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_result([sender_agent, other_agent]))
    await _enforce_agent_creator_policy(sender_agent, [a2], session, _make_auth(), ORG_ID)  # 예외 없음 = skip


# ── creator_only (default·기존 동작) ──────────────────────────────────────────

@pytest.mark.anyio
async def test_creator_only_creator_present_ok():
    creator_uid = uuid.uuid4()
    sender = _human_sender(uuid.uuid4(), creator_uid)  # sender가 creator
    agent_id = uuid.uuid4()
    agent = _agent(agent_id, "creator_only", creator_uid)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_result([agent]))
    with patch("app.routers.conversations._effective_org_role",
               new_callable=AsyncMock, return_value="member"):
        await _enforce_agent_creator_policy(sender, [agent_id], session, _make_auth(), ORG_ID)  # 통과


@pytest.mark.anyio
async def test_creator_only_creator_absent_403():
    sender = _human_sender(uuid.uuid4(), uuid.uuid4())  # creator 아님
    agent_id = uuid.uuid4()
    agent = _agent(agent_id, "creator_only", uuid.uuid4())  # 다른 creator
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_result([agent]))
    with patch("app.routers.conversations._effective_org_role",
               new_callable=AsyncMock, return_value="member"):
        with pytest.raises(HTTPException) as exc:
            await _enforce_agent_creator_policy(sender, [agent_id], session, _make_auth(), ORG_ID)
    assert exc.value.status_code == 403


# ── org_wide — org 내 휴먼 전부 허용 ──────────────────────────────────────────

@pytest.mark.anyio
async def test_org_wide_allows_non_creator():
    sender = _human_sender(uuid.uuid4(), uuid.uuid4())  # creator 아님
    agent_id = uuid.uuid4()
    agent = _agent(agent_id, "org_wide", uuid.uuid4())
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_result([agent]))
    with patch("app.routers.conversations._effective_org_role",
               new_callable=AsyncMock, return_value="member"):
        await _enforce_agent_creator_policy(sender, [agent_id], session, _make_auth(), ORG_ID)  # 통과 (creator 무관)


# ── list — allowlist(+creator) 외 403 ────────────────────────────────────────

@pytest.mark.anyio
async def test_list_mode_allowlisted_ok():
    sender_mid = uuid.uuid4()
    sender = _human_sender(sender_mid, uuid.uuid4())  # creator 아님이지만 allowlist에 있음
    agent_id = uuid.uuid4()
    agent = _agent(agent_id, "list", uuid.uuid4())
    session = AsyncMock()
    # 1) agents, 2) allowlist(allowed_id = sender_mid 포함)
    session.execute = AsyncMock(side_effect=[_result([agent]), _result([sender_mid])])
    with patch("app.routers.conversations._effective_org_role",
               new_callable=AsyncMock, return_value="member"):
        await _enforce_agent_creator_policy(sender, [agent_id], session, _make_auth(), ORG_ID)  # 통과


@pytest.mark.anyio
async def test_list_mode_not_allowlisted_403():
    sender = _human_sender(uuid.uuid4(), uuid.uuid4())  # allowlist 밖 + creator 아님
    agent_id = uuid.uuid4()
    agent = _agent(agent_id, "list", uuid.uuid4())
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_result([agent]), _result([])])  # allowlist 빈
    with patch("app.routers.conversations._effective_org_role",
               new_callable=AsyncMock, return_value="member"):
        with pytest.raises(HTTPException) as exc:
            await _enforce_agent_creator_policy(sender, [agent_id], session, _make_auth(), ORG_ID)
    assert exc.value.status_code == 403


@pytest.mark.anyio
async def test_list_mode_creator_always_allowed():
    """list 모드라도 creator는 allowlist 없이 항상 허용."""
    creator_uid = uuid.uuid4()
    sender = _human_sender(uuid.uuid4(), creator_uid)  # sender = creator
    agent_id = uuid.uuid4()
    agent = _agent(agent_id, "list", creator_uid)
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_result([agent]), _result([])])  # allowlist 빈
    with patch("app.routers.conversations._effective_org_role",
               new_callable=AsyncMock, return_value="member"):
        await _enforce_agent_creator_policy(sender, [agent_id], session, _make_auth(), ORG_ID)  # creator라 통과


@pytest.mark.anyio
async def test_no_participants_skip():
    sender = _human_sender(uuid.uuid4(), uuid.uuid4())
    session = AsyncMock()
    await _enforce_agent_creator_policy(sender, [], session, _make_auth(), ORG_ID)  # 빈 참가자 → skip (쿼리 없음)


# ── P0 fix(Ohol DM 403): created_by=None 에이전트 + org owner/admin 면제 ──────────

@pytest.mark.anyio
async def test_created_by_none_org_admin_allowed():
    """created_by=None 에이전트(레거시·seed) + org owner/admin sender → DM 허용(게이트 면제)."""
    sender = _human_sender(uuid.uuid4(), uuid.uuid4())  # creator 아님
    agent_id = uuid.uuid4()
    agent = _agent(agent_id, "creator_only", None)  # creator 부재
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_result([agent]))
    with patch("app.routers.conversations._effective_org_role",
               new_callable=AsyncMock, return_value="owner"):
        await _enforce_agent_creator_policy(sender, [agent_id], session, _make_auth(), ORG_ID)  # 예외 없음 = 허용


@pytest.mark.anyio
async def test_created_by_none_non_admin_403():
    """created_by=None 에이전트 + 비-admin sender → 403(차단·기존 동작 무회귀)."""
    sender = _human_sender(uuid.uuid4(), uuid.uuid4())  # creator 아님 + 비-admin
    agent_id = uuid.uuid4()
    agent = _agent(agent_id, "creator_only", None)  # creator 부재
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_result([agent]))
    with patch("app.routers.conversations._effective_org_role",
               new_callable=AsyncMock, return_value="member"):
        with pytest.raises(HTTPException) as exc:
            await _enforce_agent_creator_policy(sender, [agent_id], session, _make_auth(), ORG_ID)
    assert exc.value.status_code == 403
