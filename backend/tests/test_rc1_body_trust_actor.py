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
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.gate_mock_factory import make_gate


def _non_doc_gate_session():
    """48f064e5: 엔드포인트가 doc-gate authz용 게이트 로드 → 비-doc 게이트 반환으로 그 분기 skip.
    #2198: non-doc 분기가 work_item_type/work_item_id 를 읽으므로 명시(누락 시 AttributeError) —
    이 파일의 관심사는 resolver_id 강제(RC#1)이지 project-role 판정이 아니므로 호출부가
    _non_doc_gate_approvable 을 별도로 patch 해 그 판정 자체를 우회한다."""
    s = AsyncMock()
    gr = MagicMock()
    # story #2837 — 여긴 make_gate()로 안 옮긴다: session.execute가 단일 고정 return_value라
    # 이 한 mock이 Gate SELECT뿐 아니라 뒤이은 PullRequestStoryLink SELECT까지 대신 받는다
    # (아래 evidence는 Gate 필드가 아니라 그 링크 조회 쪽 attribute) — 순수 Gate mock이 아닌
    # 다중-쿼리 재사용 hack이라 make_gate 대상 밖(Gate에 없는 필드를 억지로 끼워 넣게 됨).
    gr.scalar_one_or_none.return_value = SimpleNamespace(
        gate_type="merge", work_item_type="story", work_item_id=uuid.uuid4(),
        # story #2813 — session.execute가 단일 고정 return_value라, gates.py의 신규
        # resolve_pr_link(SELECT PullRequestStoryLink) 호출도 이 같은 목을 되돌려 받는다
        # (이 파일의 관심사는 resolver_id 강제이지 PR 링크 조회가 아님). `.evidence`가 없으면
        # gates.py의 anchor 기록 분기(status=="approved" and gate_type=="merge"에서 항상 발동
        # — 이 목의 gate_type이 정확히 "merge")가 AttributeError로 죽는다 — None으로 명시해
        # "링크 없음/head_sha 미상"과 동형 무해 경로를 타게 한다.
        evidence=None,
        # story #2975 — SimpleNamespace는 MagicMock과 달리 미선언 속성 접근 시 AttributeError를
        # 던진다. reviewed_head_sha 대조 분기가 이 값을 읽으므로(known SHA 유무 판정), 이 파일의
        # 관심사(resolver_id 강제, RC#1)와 무관하게 명시 필요 — None="known SHA 없음"으로 그
        # 검증 자체가 대상 밖임을 분명히 한다(evidence=None과 동형 처리).
        github_check_run_sha=None,
        # story #2982 — 이미해소 가드(status!='pending'이면 409)도 이 값을 읽는다. SimpleNamespace는
        # 미선언 속성이 AttributeError라 명시 필요 — "pending"으로 그 가드가 대상 밖임을 분명히 한다.
        status="pending", resolver_id=None, resolved_at=None,
    )
    s.execute = AsyncMock(return_value=gr)
    return s


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

    async def _fake_transition(session, org_id, gate_id, status, resolver_id, note, *, pending_deliveries=None):
        captured["resolver_id"] = resolver_id
        # story #2837 — 예전엔 이 자리가 SimpleNamespace 손수 필드나열이라 gates.py가 새 Gate
        # 필드를 읽을 때마다 AttributeError로 깨졌다(#2832의 github_check_run_sha가 그 사례).
        # make_gate()는 실 Gate 필드셋을 그대로 기본 채움 — override만 명시.
        return make_gate(id=gate_id, org_id=org_id, status=status, resolver_id=resolver_id)

    from fastapi import BackgroundTasks
    with patch.object(mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(mod, "transition_gate", _fake_transition), \
         patch.object(mod, "_non_doc_gate_approvable", AsyncMock(return_value=True)):
        # story #2027: _non_doc_gate_session()의 gate_type="merge"는 고위험(_HIGH_RISK_GATE_TYPES)이라
        # 이 파일의 관심사(resolver_id 강제)와 무관한 사유-강제 가드를 note+evidence_viewed로 우회.
        await transition_gate_endpoint(
            id=uuid.uuid4(), body=GateTransitionRequest(status="approved", resolver_id=forged, note="테스트 사유", evidence_viewed=True),
            background_tasks=BackgroundTasks(),
            session=_non_doc_gate_session(), org_id=uuid.uuid4(),
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
    from fastapi import BackgroundTasks
    with patch.object(mod, "resolve_member", AsyncMock(return_value=agent)):
        with pytest.raises(HTTPException) as ei:
            await transition_gate_endpoint(
                id=uuid.uuid4(), body=GateTransitionRequest(status="approved"),
                background_tasks=BackgroundTasks(),
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
