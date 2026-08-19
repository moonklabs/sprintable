"""story #2467 respec — 「10초 내 살아있음 신호」: polling(setInterval) 철거 + SSE push 배선 가드.

무거운 경로(SSE 제너레이터 lifecycle·ack 핫패스)는 test_ob4b_funnel_seams.py 관례를 따라
source-inspection으로 배선을 고정한다. push_verification_signal 자체는 순수 단위 검증.
"""
from __future__ import annotations

import inspect
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── BE: /stream 연결 시 자동 verify 기동(재연결 스팸 방지 게이트 포함) ──────────

def test_stream_connect_auto_starts_verify_when_not_yet_verified():
    from app.routers import agent_gateway
    src = inspect.getsource(agent_gateway)
    assert "get_verification_state(_pdb, agent_id" in src
    assert "_newly_started = not _prior_verify[\"verified\"]" in src
    assert "if _newly_started:" in src
    assert "start_verification(" in src
    # 재연결 스팸 방지 — verified 인 상태에서 재접속 시 start_verification 재호출 금지(게이트 존재).
    assert "await start_verification(" in src


def test_stream_connect_pushes_mcp_reachable_only_when_newly_started():
    from app.routers import agent_gateway
    src = inspect.getsource(agent_gateway)
    assert 'state="mcp_reachable"' in src
    # commit 성공 후에만 push(헛신호 방지) — _pdb.commit() 다음 줄들에 위치.
    idx_commit = src.index("await _pdb.commit()")
    idx_push = src.index('state="mcp_reachable"')
    assert idx_push > idx_commit


# ─── BE: ack 완료 시 verified push(commit 후에만, 무조건 아님) ──────────────────

def test_ack_pushes_verified_only_inside_seam_guard():
    from app.routers import agent_gateway
    src = inspect.getsource(agent_gateway.ack_event)
    assert "_newly_verified_org_id: uuid.UUID | None = None" in src
    assert "if _verify_done:" in src
    assert "_newly_verified_org_id = _verify_done.org_id" in src
    # push는 db.commit() 이후에만(트랜잭션 실패 시 헛신호 방지).
    idx_commit = src.index("await db.commit()")
    idx_push = src.index('state="verified"')
    assert idx_push > idx_commit
    idx_guard = src.index("if _newly_verified_org_id is not None:")
    assert idx_guard < idx_push


# ─── BE: push_verification_signal 순수 단위 검증 ───────────────────────────────

@pytest.mark.anyio
async def test_push_verification_signal_calls_push_to_org_members():
    from app.services.agent_verify import push_verification_signal

    org_id = uuid.uuid4()
    agent_id = uuid.uuid4()
    with patch("app.routers.events.push_to_org_members", new=AsyncMock()) as mock_push:
        await push_verification_signal(org_id=org_id, agent_id=agent_id, state="verified", transport="stdio")
        mock_push.assert_awaited_once()
        args, kwargs = mock_push.await_args
        assert args[0] == str(org_id)
        assert args[1] == "onboarding.rail_signal"
        assert args[2] == {"agent_id": str(agent_id), "state": "verified", "transport": "stdio"}


# ─── FE: verify-rail.tsx polling(setInterval) 완전 철거 검산 ───────────────────

def test_verify_rail_has_zero_setinterval():
    """AC1 — 「옛 값의 부재」로 검산: 2.5s setInterval 폴링 코드 0."""
    repo_root = Path(__file__).resolve().parents[2]
    rail_path = repo_root / "apps/web/src/app/onboarding/verify-rail.tsx"
    src = rail_path.read_text(encoding="utf-8")
    assert "setInterval(" not in src  # 실호출만(설명 주석의 "setInterval" 단어 자체는 허용)
    assert "pollIntervalMs" not in src
    assert "useSseNotifications" in src
    assert "onboarding.rail_signal" in src
