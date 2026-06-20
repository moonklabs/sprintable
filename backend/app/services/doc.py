"""E-DG S22: doc decision lifecycle 전이 서비스.

doc 의 native status(0128·doc-specific 값)를 hypothesis 와 동형 패턴으로 전이한다. ⭐draft→confirmed
만 line overlay-gated(enforcing→human-gate·default-off→inline human confirm). 나머지 전이는 native
직행. ``via_gate=True`` = Decision Gate 승인이 적용하는 경로(overlay 재진입 차단).
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.doc import Doc, DOC_STATUSES, is_valid_doc_transition
from app.services.member_resolver import ResolvedMember


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

    doc.status = to_status
    await session.flush()
    return doc
