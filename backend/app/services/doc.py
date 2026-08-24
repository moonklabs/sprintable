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
    session: AsyncSession, org_id: uuid.UUID, doc: Doc, gate_id: uuid.UUID, *, requester_id: uuid.UUID,
    designated_approver_id: uuid.UUID | None = None,
) -> None:
    """doc-gate v2 갭2: doc 상신 → org owner/admin 휴먼 결재자에게 in-app 알림(상신자 본인 제외).
    best-effort·비중단(알림 실패가 상신을 막지 않음). transition_gate 해소 알림과 대칭.

    story #2604 P2(delivery-contract-blueprint-v0-1): 벨 알림과 별개로, 같은 approver_ids에
    대해 챗 승인요청 카드(승인자별 DM + message_kind="request")도 배달한다 — 둘은 독립 채널
    (하나 실패해도 다른 하나는 그대로) [[project_...]] 카드 렌더 자체는 FE(미르코 #2614) 몫,
    여기서는 이벤트 스키마·Gate 연결까지."""
    approver_ids: list[uuid.UUID] = []
    try:
        from app.models.project import OrgMember
        approver_ids = list((await session.execute(
            select(OrgMember.id).where(
                OrgMember.org_id == org_id,
                OrgMember.role.in_(("owner", "admin")),
                OrgMember.deleted_at.is_(None),  # 산티아고 RC: 삭제/탈퇴 owner/admin 제외(정보노출·실결재권자만)
                OrgMember.id != requester_id,
            )
        )).scalars().all())
    except Exception:  # noqa: BLE001 — 조회 실패는 상신 비중단.
        logger.warning("doc 상신 결재자 조회 실패 doc=%s", doc.id, exc_info=True)
        return

    if not approver_ids:
        return

    try:
        from app.services.notification_dispatch import dispatch_notification
        await dispatch_notification(
            session, org_id=org_id, event_type="doc_approval_requested",
            target_member_ids=approver_ids,
            title="문서 결재 요청",
            body=f"'{doc.title}' 문서가 결재 대기 중입니다.",
            reference_type="gate", reference_id=gate_id,
            source_project_id=doc.project_id,
            # story #2687: 동기 개인 webhook 재시도(최대 3회·1s/2s backoff)가 이 함수를 호출한
            # transition_doc()의 열린 트랜잭션 커넥션을 그대로 붙잡아(pool_size=3+overflow=1인
            # 소형 풀) 상신 요청 자체를 8~9초 지연시키고, 그 창 동안 다른 동시 요청들의 커넥션
            # 획득도 지연시켰다(실측: PATCH /docs/{id}/transition 8.7-9.3s). story #2460 §6
            # 봉합②의 outbox 경로로 옮겨 트랜잭션 밖에서 배달한다.
            via_outbox=True,
        )
    except Exception:  # noqa: BLE001 — 벨 알림 실패는 상신 비중단.
        logger.warning("doc 상신 결재자 벨 알림 실패 doc=%s", doc.id, exc_info=True)

    try:
        from app.services.approval_delivery import dispatch_approval_request_cards
        await dispatch_approval_request_cards(
            session, org_id=org_id, work_item_type=DOC_GATE_WORK_ITEM_TYPE, work_item_id=doc.id,
            project_id=doc.project_id, title=doc.title, gate_id=gate_id,
            requester_id=requester_id, approver_ids=approver_ids,
            designated_approver_id=designated_approver_id,
        )
    except Exception:  # noqa: BLE001 — 카드 배달 실패는 상신 비중단(Gate inbox 폴백 항상 존재).
        logger.warning("doc 상신 결재자 카드(챗) 배달 실패 doc=%s", doc.id, exc_info=True)


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
    designated_approver_id: uuid.UUID | None = None,
) -> Doc:
    """doc status 전이. draft→confirmed 는 human-only(+enforcing 시 line overlay). via_gate=True 면
    overlay 재진입(re-gate 루프) 없이 native 직행(caller=gate approver·human).

    designated_approver_id: story #2985(PO 설계 확定 2026-08-24)에서 신설, story #3004(선생님
    정책 확定 2026-08-24)부터 draft→pending 상신 시 **필수**(None이면 400) — "이 결재는
    특정하게 이 사람에게"가 상신의 전제 조건. self-designation·owner/admin 아닌 대상은
    거부(자격 검증)."""
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
        # story #3004(선생님 정책 확定 2026-08-24, #2985/#3001 갈림④ 격상) — 「받는 사람이
        # 없는 결재가 존재할 수 있는지」에 대한 답: 없다. designated_approver_id 미지정 상신은
        # 서버가 생성 자체를 거부한다(#2985 시절의 "None=전원 브로드캐스트" 폴백은 이 경로에서
        # 폐기 — MCP/FE도 이 스토리에서 필수 입력으로 동시 착지). 자격 검증은 기존
        # _notify_doc_approval_requested()의 approver_ids 조회(owner/admin·not-deleted)와
        # 동일 축 재사용 — 새 판단을 짓지 않는다.
        if designated_approver_id is None:
            raise DocTransitionError("APPROVER_REQUIRED", "상신하려면 결재자를 지정해야 합니다.")
        if designated_approver_id == caller.id:
            raise DocTransitionError("APPROVER_SELF_NOT_ALLOWED", "본인을 결재자로 지정할 수 없습니다.")
        from app.models.project import OrgMember
        _eligible = (await session.execute(
            select(OrgMember.id).where(
                OrgMember.org_id == org_id,
                OrgMember.id == designated_approver_id,
                OrgMember.role.in_(("owner", "admin")),
                OrgMember.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        if _eligible is None:
            raise DocTransitionError("APPROVER_INELIGIBLE", "지정한 결재자는 결재 자격(owner/admin)이 없습니다.")

        from app.services.gate_service import create_gate
        from app.services.workflow_line_config import _default_role_id
        role_id = await _default_role_id(session, org_id) or doc.id  # 기본 결재 role(부재 시 placeholder)
        gate = await create_gate(
            session, org_id, doc.id, DOC_GATE_WORK_ITEM_TYPE, DOC_GATE_TYPE,
            caller.id, role_id,
            neutral_facts={"requested_by_member_id": str(caller.id), "doc_title": doc.title},
            project_id=doc.project_id,
            # story #373cfaa1: 이 함수가 아래서 _notify_doc_approval_requested()로 doc 전용
            # 리치 알림(벨+카드)을 별도로 쏘므로, create_gate() generic "gate.pending_approval"
            # 벨은 끈다(중복 제거 — 신규생성·rejected재오픈 두 경로 모두 해당).
            notify=False,
            designated_approver_id=designated_approver_id,
        )
        # ⚠️재상신 RC(산티아고): uq(work_item_id,gate_type)=1 gate·terminal(approved/rejected)=immutable →
        # create_gate 멱등이 기존 **terminal gate 를 반환**해(상태필터 없음) 재상신 시 새 pending gate 0 →
        # Gate inbox 미노출+결재 불능. 재상신=새 결재 사이클이므로 terminal gate 를 pending 으로 **re-open**
        # (직접 reset — FSM 전이 아님·해소 메타 clear). pending/held(admin hold)면 그대로 둔다.
        # ⚠️BLOCKER(codex gpt-5.5 cross-model): 일반 gate 엔드포인트(POST /gates)로 누구나 forged
        # requested_by_member_id 로 doc_approval gate pre-create 가능 → create_gate 멱등이 그 forged
        # gate(pending 포함)를 unchanged 반환 → transition self-approval 가드가 **위조 requester** 를
        # 신뢰해 author 자기승인 우회. → 상신서 requested_by_member_id 를 **항상 caller.id 로 server-stamp**
        # (신규·기존 pending·terminal 모두·forged 덮어쓰기·client neutral_facts 절대 불신·[[feedback_sod_resolver_id_server_forced]]).
        _facts = dict(gate.neutral_facts or {})
        _facts["requested_by_member_id"] = str(caller.id)
        _facts.setdefault("doc_title", doc.title)
        # 재상신(terminal gate) re-open: 이전 결재 이력 append + 해소필드 clear(새 사이클·산티아고 audit).
        # pending/held(admin hold)면 status 유지·requester 만 재stamp(위 forged 덮어쓰기 포함).
        if gate.status in ("approved", "rejected", "auto_passed", "voided"):
            _prior = {
                "status": gate.status,
                "resolver_id": str(gate.resolver_id) if gate.resolver_id else None,
                "resolved_at": gate.resolved_at.isoformat() if gate.resolved_at else None,
                "resolution_note": gate.resolution_note,
            }
            _facts["decision_history"] = [*_facts.get("decision_history", []), _prior]
            from datetime import datetime, timezone

            from app.models.gate import set_gate_status

            set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
            gate.resolver_id = None
            gate.resolved_at = None
            gate.resolution_note = None
        gate.neutral_facts = _facts  # 항상 재할당(JSONB in-place 미감지) — server-stamp + (재오픈 시) 이력.
        doc.status = "pending"
        await session.flush()
        # doc-gate v2 갭2(선생님 실 Web): 상신 시 **결재자(org owner/admin 휴먼)에게 알림** — create_gate/
        # doc transition 은 event/notification 0이라 상신해도 결재자가 모름(transition_gate 해소엔
        # dispatch_notification 있는데 상신엔 없던 비대칭). best-effort(알림 실패는 상신 비중단·SoD상
        # 상신자 본인 제외).
        await _notify_doc_approval_requested(
            session, org_id, doc, gate.id, requester_id=caller.id,
            designated_approver_id=designated_approver_id,
        )
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

    # b13352c2: 상신취소(pending→draft) 시 연결 pending doc_approval 게이트 cascade void(orphan Gate inbox
    # 방지·PO 실측 cancel-orphan). doc 가 pending 을 떠나면 그 결재 사이클 종료 → gate void. 재상신(draft→pending)
    # 시 create_gate 멱등이 voided(=terminal) 게이트를 re-open(L102)하므로 멱등 reuse 의도와 충돌 0. 삭제
    # cascade(docs.py delete_doc)와 동일 void_pending_doc_gate·system cascade(취소자 트리거·human-gate authz 우회 정당).
    if doc.status == "pending" and to_status == "draft":
        from app.services.gate_service import void_pending_doc_gate
        await void_pending_doc_gate(session, org_id, doc.id, caller.id)

    doc.status = to_status
    await session.flush()
    return doc
