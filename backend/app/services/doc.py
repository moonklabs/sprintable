"""E-DG S22: doc decision lifecycle 전이 서비스.

doc 의 native status(0128·doc-specific 값)를 hypothesis 와 동형 패턴으로 전이한다. ⭐draft→confirmed
만 line overlay-gated(enforcing→human-gate·default-off→inline human confirm). 나머지 전이는 native
직행. ``via_gate=True`` = Decision Gate 승인이 적용하는 경로(overlay 재진입 차단).
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.doc import Doc, DOC_STATUSES, DocRevision, is_valid_doc_transition
from app.services.member_resolver import ResolvedMember

logger = logging.getLogger(__name__)

# E-DG doc-gate(48f064e5): doc 결재 인앱 게이트. work_item_type='doc'·gate_type='doc_approval'.
DOC_GATE_WORK_ITEM_TYPE = "doc"
DOC_GATE_TYPE = "doc_approval"


async def _notify_doc_approval_requested(
    session: AsyncSession, org_id: uuid.UUID, doc: Doc, gate_id: uuid.UUID, *, requester_id: uuid.UUID
) -> None:
    """doc-gate v2 갭2: doc 상신 → org owner/admin 휴먼 결재자에게 in-app 알림(상신자 본인 제외).
    best-effort·비중단(알림 실패가 상신을 막지 않음). transition_gate 해소 알림과 대칭."""
    try:
        from app.models.project import OrgMember
        from app.services.notification_dispatch import dispatch_notification
        approver_ids = (await session.execute(
            select(OrgMember.id).where(
                OrgMember.org_id == org_id,
                OrgMember.role.in_(("owner", "admin")),
                OrgMember.deleted_at.is_(None),  # 산티아고 RC: 삭제/탈퇴 owner/admin 제외(정보노출·실결재권자만)
                OrgMember.id != requester_id,
            )
        )).scalars().all()
        if approver_ids:
            await dispatch_notification(
                session, org_id=org_id, event_type="doc_approval_requested",
                target_member_ids=list(approver_ids),
                title="문서 결재 요청",
                body=f"'{doc.title}' 문서가 결재 대기 중입니다.",
                reference_type="gate", reference_id=gate_id,
                source_project_id=doc.project_id,
            )
    except Exception:  # noqa: BLE001 — 알림 실패는 상신 비중단.
        logger.warning("doc 상신 결재자 알림 실패 doc=%s", doc.id, exc_info=True)


class DocTransitionError(Exception):
    """도메인 오류 — 라우터가 code/message 를 HTTPException 으로 매핑."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def transition_doc(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    doc_id: uuid.UUID,
    to_status: str,
    via_gate: bool = False,
) -> Doc:
    """doc status 전이. draft→confirmed 는 human-only(+enforcing 시 line overlay). via_gate=True 면
    overlay 재진입(re-gate 루프) 없이 native 직행(caller=gate approver·human)."""
    doc = (await session.execute(
        select(Doc).where(Doc.id == doc_id, Doc.org_id == org_id, Doc.deleted_at.is_(None))
    )).scalar_one_or_none()
    if doc is None:
        raise DocTransitionError("DOC_NOT_FOUND", "문서를 찾을 수 없습니다.")

    if to_status not in DOC_STATUSES:
        raise DocTransitionError("INVALID_STATUS", f"알 수 없는 doc status: {to_status}")
    if not is_valid_doc_transition(doc.status, to_status):
        raise DocTransitionError(
            "INVALID_DOC_TRANSITION", f"불법 전이: {doc.status} → {to_status}"
        )

    # E-DG doc-gate(48f064e5): 상신 draft→pending → 인앱 doc-gate 생성(work_item_type='doc'·pending)
    # → Gate inbox(/api/gates?status=pending) 노출. doc.status='pending'(결재 대기). create_gate 멱등
    # (재상신=기존 gate 반환·중복 0). 결재(승인/반려)는 gate 해소가 _resolve_doc_gate 로 수행.
    if to_status == "pending" and doc.status == "draft":
        from app.services.gate_service import create_gate
        from app.services.workflow_line_config import _default_role_id
        role_id = await _default_role_id(session, org_id) or doc.id  # 기본 결재 role(부재 시 placeholder)
        gate = await create_gate(
            session, org_id, doc.id, DOC_GATE_WORK_ITEM_TYPE, DOC_GATE_TYPE,
            caller.id, role_id,
            neutral_facts={"requested_by_member_id": str(caller.id), "doc_title": doc.title},
        )
        # ⚠️재상신 RC(산티아고): uq(work_item_id,gate_type)=1 gate·terminal(approved/rejected)=immutable →
        # create_gate 멱등이 기존 **terminal gate 를 반환**해(상태필터 없음) 재상신 시 새 pending gate 0 →
        # Gate inbox 미노출+결재 불능. 재상신=새 결재 사이클이므로 terminal gate 를 pending 으로 **re-open**
        # (직접 reset — FSM 전이 아님·해소 메타 clear). pending/held(admin hold)면 그대로 둔다.
        if gate.status in ("approved", "rejected", "auto_passed", "voided"):
            # 감사추적 보존(산티아고 audit): clear 전에 이전 결재(누가/언제/왜)를 neutral_facts.
            # decision_history 에 append(append-only·재상신 사이클별 1건) → 반려 이력 손실 0. 그 후 current
            # 해소필드 clear(새 결재 사이클). JSONB 는 in-place mutation 미감지라 새 dict 재할당.
            _prior = {
                "status": gate.status,
                "resolver_id": str(gate.resolver_id) if gate.resolver_id else None,
                "resolved_at": gate.resolved_at.isoformat() if gate.resolved_at else None,
                "resolution_note": gate.resolution_note,
            }
            _facts = dict(gate.neutral_facts or {})
            _facts["decision_history"] = [*_facts.get("decision_history", []), _prior]
            gate.neutral_facts = _facts
            gate.status = "pending"
            gate.resolver_id = None
            gate.resolved_at = None
            gate.resolution_note = None
        doc.status = "pending"
        await session.flush()
        # doc-gate v2 갭2(선생님 실 Web): 상신 시 **결재자(org owner/admin 휴먼)에게 알림** — create_gate/
        # doc transition 은 event/notification 0이라 상신해도 결재자가 모름(transition_gate 해소엔
        # dispatch_notification 있는데 상신엔 없던 비대칭). best-effort(알림 실패는 상신 비중단·SoD상
        # 상신자 본인 제외).
        await _notify_doc_approval_requested(session, org_id, doc, gate.id, requester_id=caller.id)
        return doc

    # 결재 대기(pending) 문서의 승인/반려는 **gate 해소(via_gate)로만** — 직접 API self-confirm 차단.
    if doc.status == "pending" and to_status in ("confirmed", "denied") and not via_gate:
        raise DocTransitionError("GATE_REQUIRED", "결재 대기 문서는 Gate 승인/반려로만 전이됩니다.")

    # ⭐E-DG S22: draft→confirmed line overlay. enforcing 라인이면 human-gate 생성·draft 유지(가시
    # confirm 대기). default-off/plain/엔진실패 → 아래 inline human-only 폴백(byte-동일·agent 차단 유지·
    # ⚠️fail-open=confirmed 통과 아님). via_gate(gate 승인 적용)면 overlay skip.
    if to_status == "confirmed" and doc.status == "draft" and not via_gate:
        _decision = None
        try:
            from app.services.workflow_line_engine import evaluate_line_for_transition
            _decision = await evaluate_line_for_transition(
                session, org_id=org_id, project_id=doc.project_id,
                entity_type="doc", entity_id=doc.id,
                from_status="draft", to_status="confirmed",
                actor_id=caller.id, actor_type=caller.type,
            )
        except Exception:  # noqa: BLE001 — fail-open: 엔진 실패는 inline human-only 폴백(agent 차단 유지).
            _decision = None
        if _decision is not None and not _decision.proceeds:
            # enforcing: human-gate pending. doc draft 유지·gate 가 confirm 대기 가시화(에러 아님).
            await session.commit()  # gate/step_run 보존(stories.py:736 패턴).
            return doc

    # confirm 확정은 휴먼만(콘텐츠 승인=human-validated). agent 직접 confirm 차단.
    if to_status == "confirmed" and caller.type != "human":
        raise DocTransitionError("HUMAN_CONFIRM_REQUIRED", "confirmed 전이는 휴먼만 가능합니다.")

    # ⭐E-DG S28: denied→draft(재상신 위한 revise) 시 직전(denied) 버전 content 를 DocRevision 에 스냅샷.
    # 안A — doc.id/slug stable 유지하고 버전 이력은 DocRevision 타임라인(mockup v1→v2 데이터소스)으로.
    # 저자가 이후 content 를 덮어쓰기 전에 반려본을 보존한다(재상신 사이클마다 1 revision).
    if to_status == "draft" and doc.status == "denied":
        session.add(DocRevision(
            doc_id=doc.id, project_id=doc.project_id, org_id=org_id,
            content=doc.content, created_by=caller.id,
        ))

    doc.status = to_status
    await session.flush()
    return doc
