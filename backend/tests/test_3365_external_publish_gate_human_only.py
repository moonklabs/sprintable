"""story #3365(Phase0 S1) AC4(승인 절반) — 페드루 PO 확定(2026-09-03): «승인 API» 403은
신규 엔드포인트·신규 코드가 아니라 기존 gates.py `transition_gate_endpoint`
(`_authorize_gate_approve_equivalent`, `resolved.type != "human"` → 403)가 이미 전 gate_type에
걸쳐 강제한다. 이 테스트는 그 기존 가드를 `external_publish` gate_type에 회귀로 고정한다
(신규 동작 없음 — 기존 가드 재확인).

real Postgres 불요 — test_rc1_body_trust_actor.py와 동형 mock 단위 테스트."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_agent_cannot_approve_external_publish_gate_existing_guard_pinned():
    from fastapi import BackgroundTasks, HTTPException

    from app.routers import gates as gates_mod
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    from app.services.member_resolver import ResolvedMember

    agent = ResolvedMember(
        id=uuid.uuid4(), user_id=None, name="담롱", type="agent", role="member", org_id=uuid.uuid4(),
    )

    class _FakeAuth:
        user_id = str(uuid.uuid4())
        claims: dict = {}

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=agent)):
        with pytest.raises(HTTPException) as exc_info:
            await transition_gate_endpoint(
                id=uuid.uuid4(),
                body=GateTransitionRequest(status="approved"),
                background_tasks=BackgroundTasks(),
                session=AsyncMock(),
                org_id=agent.org_id,
                auth=_FakeAuth(),
            )
    assert exc_info.value.status_code == 403
    assert "에이전트 승인 불가" in str(exc_info.value.detail)
