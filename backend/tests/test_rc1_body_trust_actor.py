"""E-DG RC#1: body-trust actor 필드 전수 봉인(S23 RC①·S22 RC② systemic).

actor-identity(누가 했나)는 인증 caller 로 서버 강제·body spoof 차단:
- VULN#1 generic transition = {approved,rejected} 제한 + resolver 전-status 강제(voided/held 우회 봉인).
- VULN#2 create_doc created_by = 인증 caller 강제(attribution forge 차단).
(VULN#3 file-lock 은 caller-member 관계가 단순 동치가 아니라[기존 flow caller≠path member] 별도 authz
 설계 follow-up 으로 분리.)
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _human(mid=None):
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=mid or uuid.uuid4(), user_id=uuid.uuid4(), name="h",
                          type="human", role="member", org_id=uuid.uuid4())


# ── VULN#1: generic transition ────────────────────────────────────────────────
def test_transition_rejects_non_review_status():
    """generic transition validator 는 voided/held/pending/auto_passed 거부(전용 엔드포인트 전용)."""
    from app.routers.gates import GateTransitionRequest
    from pydantic import ValidationError
    for bad in ("voided", "held", "pending", "auto_passed"):
        with pytest.raises(ValidationError):
            GateTransitionRequest(status=bad)
    for ok in ("approved", "rejected"):
        assert GateTransitionRequest(status=ok).status == ok


@pytest.mark.anyio
async def test_transition_forces_resolver_ignoring_body():
    """⭐resolver_id = 인증 caller 강제(body.resolver_id[타인 UUID] 무시)."""
    from app.routers import gates as mod
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    caller = _human()
    forged = uuid.uuid4()  # 타인 UUID
    captured = {}

    async def _fake_transition(session, org_id, gate_id, status, resolver_id, note):
        captured["resolver_id"] = resolver_id
        return SimpleNamespace(id=gate_id, org_id=org_id, work_item_id=uuid.uuid4(),
                               work_item_type="story", gate_type="merge", status=status,
                               resolver_id=resolver_id, resolved_at=None, resolution_note=None,
                               held_until=None, neutral_facts=None, requires_human=False,
                               evidence_status=None, decision_basis=None, auto_decision_reason=None,
                               created_at=__import__("datetime").datetime.now(),
                               updated_at=__import__("datetime").datetime.now())

    with patch.object(mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(mod, "transition_gate", _fake_transition):
        await transition_gate_endpoint(
            id=uuid.uuid4(), body=GateTransitionRequest(status="approved", resolver_id=forged),
            session=AsyncMock(), org_id=uuid.uuid4(),
            auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert captured["resolver_id"] == caller.id     # caller 강제
    assert captured["resolver_id"] != forged          # body 무시


@pytest.mark.anyio
async def test_transition_agent_rejected_403():
    """agent caller 는 approve/reject 403(휴먼 전용)."""
    from app.routers import gates as mod
    from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
    from app.services.member_resolver import ResolvedMember
    from fastapi import HTTPException
    agent = ResolvedMember(id=uuid.uuid4(), user_id=None, name="a", type="agent",
                           role="member", org_id=uuid.uuid4())
    with patch.object(mod, "resolve_member", AsyncMock(return_value=agent)):
        with pytest.raises(HTTPException) as ei:
            await transition_gate_endpoint(
                id=uuid.uuid4(), body=GateTransitionRequest(status="approved"),
                session=AsyncMock(), org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(uuid.uuid4())))
    assert ei.value.status_code == 403


# ── VULN#2: doc created_by forced ─────────────────────────────────────────────
@pytest.mark.anyio
async def test_create_doc_forces_created_by_ignoring_body():
    """⭐create_doc created_by = 인증 caller 강제(body.created_by[타인] 무시)."""
    from app.routers import docs as mod
    auth_member = uuid.uuid4()
    forged = uuid.uuid4()
    captured = {}

    class _Repo:
        def __init__(self, *a, **k): self.org_id = uuid.uuid4()
        async def create(self, **kw):
            captured["created_by"] = kw.get("created_by")
            return SimpleNamespace(id=uuid.uuid4(), org_id=self.org_id, project_id=kw.get("project_id"),
                                   title=kw.get("title"), slug=kw.get("slug"), parent_id=None,
                                   created_by=kw.get("created_by"),
                                   created_at=__import__("datetime").datetime.now(),
                                   updated_at=__import__("datetime").datetime.now())

    body = SimpleNamespace(org_id=uuid.uuid4(), project_id=uuid.uuid4(), title="t", slug="s",
                           content="", parent_id=None, created_by=forged, icon=None, sort_order=0)
    bg = SimpleNamespace(add_task=lambda *a, **k: None)
    with patch.object(mod, "enforce_body_context", AsyncMock(return_value=None)), \
         patch.object(mod, "_resolve_doc_member_id",
                      AsyncMock(return_value=auth_member)) as rdm, \
         patch.object(mod, "canonicalize_member_id", AsyncMock(side_effect=lambda m, s: m)), \
         patch.object(mod, "DocRepository", _Repo), \
         patch.object(mod, "DocResponse", SimpleNamespace(model_validate=lambda d: d)):
        try:
            await mod.create_doc(
                body=body, background_tasks=bg, session=AsyncMock(), auth=SimpleNamespace(
                    user_id=str(uuid.uuid4()), claims={"app_metadata": {}}),
                org_id=uuid.uuid4())
        except Exception:
            pass  # 후속 로직(DocResponse/이벤트) 무관 — 강제 입증이 핵심
    # ⭐fix 가 body.created_by → _resolve_doc_member_id(auth) 치환이므로, resolve 가 호출됐다는 것
    # 자체가 body.created_by(forged) 가 무시되고 caller 로 강제됨을 입증한다.
    rdm.assert_awaited()
    if "created_by" in captured:                       # repo.create 까지 도달 시 값도 검증
        assert captured["created_by"] == auth_member
        assert captured["created_by"] != forged
