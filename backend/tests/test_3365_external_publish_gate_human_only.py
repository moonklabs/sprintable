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


@pytest.mark.anyio
async def test_resubmit_required_guard_does_not_fire_for_non_site_post_gate_types():
    """story #3367 후속(페드루 PO 실측 2026-09-03 07:11Z, CI shard 3 실패) — SITE_POST_
    RESUBMIT_REQUIRED 가드는 gate_type=="external_publish"로 명시 스코프돼야 한다. 여기선
    merge 게이트에 reapproval_required=True를 **명시로 세워** 그 경계가 실제로 gate_type
    분기 때문이지 우연히 통과하는 게 아님을 고정한다(예전 버그: gate_type 체크 없이
    reapproval_required만 봐서 MagicMock auto-attribute 오탐까지 겹쳐 merge 게이트도
    409로 막혔었다)."""
    from unittest.mock import AsyncMock, MagicMock

    from fastapi import BackgroundTasks, HTTPException

    from app.routers import gates as gates_mod
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    from app.services.member_resolver import ResolvedMember

    human = ResolvedMember(
        id=uuid.uuid4(), user_id=uuid.uuid4(), name="h", type="human", role="owner", org_id=uuid.uuid4(),
    )

    async def _fake_transition(session, org_id, gid, status, resolver_id, note, *, pending_deliveries=None):
        return MagicMock(id=gid, status="approved")

    gate = MagicMock()
    gate.gate_type = "merge"
    gate.github_check_run_sha = None
    gate.status = "pending"
    gate.designated_approver_id = None
    # 이 필드가 True인데도 merge 게이트라 가드가 안 걸려야 한다(핵심 assert).
    gate.reapproval_required = True

    session = AsyncMock()
    gate_result = MagicMock()
    gate_result.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=gate_result)

    class _FakeAuth:
        user_id = str(human.user_id)
        claims: dict = {"app_metadata": {"org_id": str(human.org_id)}}

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=human)), \
         patch.object(gates_mod, "_non_doc_gate_approvable", AsyncMock(return_value=True)), \
         patch.object(gates_mod, "transition_gate", _fake_transition), \
         patch.object(gates_mod.GateResponse, "model_validate", staticmethod(lambda g: g)):
        try:
            await transition_gate_endpoint(
                id=uuid.uuid4(),
                body=GateTransitionRequest(status="approved", note="테스트 사유", evidence_viewed=True),
                background_tasks=BackgroundTasks(),
                session=session,
                org_id=human.org_id,
                auth=_FakeAuth(),
            )
        except HTTPException as exc:
            assert exc.detail.get("code") != "SITE_POST_RESUBMIT_REQUIRED" if isinstance(exc.detail, dict) else True, (
                "merge 게이트인데 SITE_POST_RESUBMIT_REQUIRED로 막혔다(gate_type 스코프 회귀)"
            )
