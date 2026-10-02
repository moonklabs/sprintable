"""OB-2: verify-connection + verification-status 가드 (블루프린트 §4).

6단계 레일(config_copied→waiting→mcp_reachable→event_delivered→ack→verified) 도출 + 엔드포인트.
ack/verified 는 acked_seq>=seq 권위 신호만(낙관 0).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.routers.agents as ag
from app.services.agent_verify import (
    RAIL_STATES,
    build_verification_rail,
    get_verification_state,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _states(rail):
    return {r["state"]: r["status"] for r in rail}


# ─── rail builder (pure) ──────────────────────────────────────────────────────

def test_rail_order_is_canonical_6():
    rail = build_verification_rail(verify_seq=1, acked_seq=0, has_fresh_session=False)
    assert [r["state"] for r in rail] == list(RAIL_STATES)
    assert len(rail) == 6


def test_rail_not_started_all_pending():
    rail = build_verification_rail(verify_seq=None, acked_seq=None, has_fresh_session=False)
    assert all(r["status"] == "pending" for r in rail)


def test_rail_waiting_not_reachable():
    s = _states(build_verification_rail(verify_seq=5, acked_seq=None, has_fresh_session=False))
    assert s["config_copied"] == "done"
    assert s["waiting"] == "active"
    assert s["mcp_reachable"] == "pending" and s["verified"] == "pending"


def test_rail_reachable_inflight_delivered_active():
    s = _states(build_verification_rail(verify_seq=5, acked_seq=3, has_fresh_session=True))
    assert s["waiting"] == "done" and s["mcp_reachable"] == "done"
    assert s["event_delivered"] == "active"
    assert s["ack"] == "pending" and s["verified"] == "pending"


def test_rail_acked_all_done():
    s = _states(build_verification_rail(verify_seq=5, acked_seq=5, has_fresh_session=True))
    assert all(s[k] == "done" for k in RAIL_STATES)


def test_rail_ack_is_authoritative_no_optimism():
    """acked_seq>=seq면 session freshness 무관 verified(권위 신호만·낙관 0)."""
    s = _states(build_verification_rail(verify_seq=5, acked_seq=9, has_fresh_session=False))
    assert s["ack"] == "done" and s["verified"] == "done"


# ─── get_verification_state (mock db) ─────────────────────────────────────────

def _scalar(v):
    r = MagicMock()
    r.scalar_one_or_none.return_value = v
    return r


def _first(v):
    r = MagicMock()
    r.first.return_value = v
    return r


@pytest.mark.anyio
async def test_get_state_acked_verified():
    db = AsyncMock()
    # execute 순서: verify_seq, acked_seq, session-fresh
    db.execute = AsyncMock(side_effect=[_scalar(5), _scalar(7), _first(("sess",))])
    out = await get_verification_state(db, uuid.uuid4(), org_id=uuid.uuid4())
    assert out["verified"] is True
    assert _states(out["rail"])["verified"] == "done"


@pytest.mark.anyio
async def test_get_state_no_verify_all_pending():
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_scalar(None), _scalar(None)])  # verify_seq None → session 미조회
    out = await get_verification_state(db, uuid.uuid4(), org_id=uuid.uuid4())
    assert out["verified"] is False
    assert all(r["status"] == "pending" for r in out["rail"])


# ─── endpoints (handler-direct) ───────────────────────────────────────────────

def _auth_ctx():
    return SimpleNamespace(user_id=str(uuid.uuid4()))


@pytest.mark.anyio
async def test_verify_connection_404():
    from fastapi import HTTPException
    db = AsyncMock()
    with patch.object(ag, "assert_agent_owner",
                      new=AsyncMock(side_effect=HTTPException(status_code=404, detail="Agent not found"))):
        with pytest.raises(HTTPException) as ei:
            await ag.verify_agent_connection(
                uuid.uuid4(), session=db, auth=_auth_ctx(), org_id=uuid.uuid4()
            )
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_verify_connection_403_when_caller_not_owner_or_admin():
    """S19(#9 MUST): agent의 생성자도 org-admin도 아닌 caller는 연결검증 트리거 불가."""
    from fastapi import HTTPException
    db = AsyncMock()
    with patch.object(ag, "assert_agent_owner",
                      new=AsyncMock(side_effect=HTTPException(status_code=403, detail="Not the owner of this agent"))):
        with pytest.raises(HTTPException) as ei:
            await ag.verify_agent_connection(
                uuid.uuid4(), session=db, auth=_auth_ctx(), org_id=uuid.uuid4()
            )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_verify_connection_starts_single_target_and_returns_rail():
    member = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    db = AsyncMock()
    db.commit = AsyncMock()
    rail = [{"state": s, "status": "pending"} for s in RAIL_STATES]
    with patch.object(ag, "assert_agent_owner", new=AsyncMock(return_value=member)), \
         patch.object(ag, "start_verification", new=AsyncMock(return_value=42)) as start, \
         patch.object(ag, "get_verification_state",
                      new=AsyncMock(return_value={"verified": False, "rail": rail, "verify_seq": 42})), \
         patch("app.routers.agent_gateway.wake_agent", new=MagicMock()) as wake:
        out = await ag.verify_agent_connection(
            member.id, session=db, auth=_auth_ctx(), org_id=uuid.uuid4()
        )
    assert out["verification_seq"] == 42 and out["rail"] == rail
    start.assert_awaited_once()  # single-target verify 시작
    wake.assert_called_once()    # SSE nudge(단일 타겟·fire_webhooks 미사용)
    db.commit.assert_awaited()


@pytest.mark.anyio
async def test_verification_status_returns_rail():
    member = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_scalar(member))
    rail = [{"state": s, "status": "done"} for s in RAIL_STATES]
    with patch.object(ag, "get_verification_state",
                      new=AsyncMock(return_value={"verified": True, "rail": rail, "verify_seq": 9})):
        out = await ag.agent_verification_status(
            member.id, session=db, auth=MagicMock(), org_id=uuid.uuid4()
        )
    assert out["verified"] is True and out["rail"] == rail
