"""story #2604 P2(delivery-contract-blueprint-v0-1): approval-request 챗 카드 배달 — BE 절반
(이벤트 템플릿·Gate 연결까지). 카드 *렌더*는 미르코 FE(#2614) 몫. 카드 액션(승인/반려)은 새 API
없이 기존 POST /api/v2/gates/{id}/transition 을 그대로 쓴다(AC③) — 여기는 그 gate로 이어지는
길(승인자별 DM + message_kind="request" + approval_target 페이로드)만 만든다.

⚠️AC3 정책(코드가 아니라 문서로 명문화 — PR 본문 + #2604 스토리 설명): 챗에서 "승인"이라고
텍스트로만 답하는 건 게이트를 해소하지 않는다 — 오직 카드 액션(버튼, gates.py 기존 human-only
SoD 인가 경유)만 유효하다. 이 모듈은 그 규칙을 코드로 강제하지 않는다(강제할 지점이 없다 —
게이트 해소 자체가 이미 독립적으로 인가돼 있다). 여기서 하는 일은 그 카드가 승인자 눈앞에
"보이게" 배달하는 것까지.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.doc import Doc
from app.models.event import Event

logger = logging.getLogger(__name__)


async def _get_or_create_approval_dm(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    requester_id: uuid.UUID,
    approver_id: uuid.UUID,
) -> Conversation:
    """requester↔approver 기존 dm 재사용(참가자 집합 기준, 가장 최근 활성 1개), 없으면 생성.

    일반 create_conversation 엔드포인트의 "매 호출 신규" 정책(EF-S2, db75ecd0)과 의도적으로
    다르다 — 승인자당 안정적 단일 스레드(카드 상태 갱신 대상)가 필요한 시스템 배달 경로라서,
    여기 한정으로 get-or-create를 쓴다(엔드포인트 자체는 무변경).

    ⛔story #2628(2026-08-13, 선생님 실사용 지적): dm_pair_key **단독** 매치는 안 쓴다 — 그
    컬럼이 없는(백필 갭·프로덕트 초기 생성 등) 기존 방을 "기존 페어 DM 없음"으로 오판해 새
    DM을 만들어 대화가 쪼개지는 사고가 났다(선생님↔PO 실 사례: 방 97ee5509는 type=dm이나
    dm_pair_key가 비어 카드가 새 방 59cda904로 흘러감). 표식(키)과 실물(참가자 집합)이
    갈리면 실물이 정본이라, 조회를 "이 conversation의 참가자가 정확히 {requester_id,
    approver_id} 2인"(ConversationParticipant 실물 조회 — 인원수 정확히 2·둘 다 매치)으로
    바꾼다. dm_pair_key는 이제 조회에 전혀 안 쓴다(신설 시 태깅만 유지 — `_create_conversation_
    record`가 이미 하는 일, 향후 최적화 여지로 남겨둠). 최근 활성 우선은 `updated_at DESC`
    (메시지가 올 때마다 갱신되는 값 — `created_at`보다 "활성" 의미에 더 맞는다).

    _enforce_agent_creator_policy 미적용: 사용자가 여는 방이 아니라, 게이트가 이미 독립적으로
    인가한(요청자=문서 상신자, 대상=org owner/admin) 시스템 발신 알림 배달이다.
    """
    target_ids = (requester_id, approver_id)
    matched_conv_ids = (
        select(ConversationParticipant.conversation_id)
        .where(ConversationParticipant.member_id.in_(target_ids))
        .group_by(ConversationParticipant.conversation_id)
        .having(func.count(ConversationParticipant.member_id.distinct()) == 2)
    ).scalar_subquery()
    exactly_two_participants = (
        select(ConversationParticipant.conversation_id)
        .where(ConversationParticipant.conversation_id.in_(matched_conv_ids))
        .group_by(ConversationParticipant.conversation_id)
        .having(func.count() == 2)
    ).scalar_subquery()

    existing = (
        await db.execute(
            select(Conversation)
            .where(
                Conversation.org_id == org_id,
                Conversation.type == "dm",
                Conversation.id.in_(exactly_two_participants),
            )
            .order_by(Conversation.updated_at.desc())
            .limit(1)
        )
    ).scalars().first()
    if existing is not None:
        return existing

    from app.routers.conversations import _create_conversation_record

    return await _create_conversation_record(
        db,
        org_id=org_id,
        project_id=project_id,
        member_ids={requester_id, approver_id},
        conv_type="dm",
        title=None,
        created_by=requester_id,
    )


async def dispatch_approval_request_cards(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_type: str,
    work_item_id: uuid.UUID,
    project_id: uuid.UUID | None,
    title: str,
    gate_id: uuid.UUID,
    requester_id: uuid.UUID,
    approver_ids: list[uuid.UUID],
    designated_approver_id: uuid.UUID | None = None,
) -> None:
    """승인자별 DM에 message_kind="request" 카드 메시지 게시 + SSE 이벤트(AC1/AC2).

    designated_approver_id: story #2985(PO 설계 확定 2026-08-24) — 지정하면 그 1인만
    kind="request"(액션)로 받고, approver_ids의 나머지(비지정 owner/admin)는 kind=
    "request_info"(정보성 — 해소 권한 자체는 유지·approval_target.actions는 그대로 두되
    kind으로 FE가 기본 접힘/«대신 처리» 폴드를 판단, 유나 FE 축). None(미지정, 기본값)이면
    approver_ids 전원이 종전처럼 "request"(회귀 0).

    story #2118(E-DG-REAL ②, 2026-08-16) 이전엔 ``doc: Doc``을 직접 받는 doc 전용 함수였다 —
    호출부(merge_verdict_gate.py 등 다른 gate_type)가 doc 객체를 갖고 있지 않아 그대로 확장할
    수 없었다. work_item_type/work_item_id/project_id/title로 일반화(함수 로직 자체는 무변경 —
    doc 전용 필드 참조 4곳을 파라미터로 치환한 것뿐). FE(approval-request-card.tsx, #3149)는
    이미 work_item_type 제네릭으로 렌더하고, 카드 title 자체는 GET /api/gates/{id}의
    work_item_summary(gates.py _resolve_work_item_summary — doc/story/task 지원)에서 오므로
    이 함수의 ``title``은 메시지 본문(chat bubble text)에만 쓰인다(카드 렌더 값 아님).

    승인자별 SAVEPOINT 격리 — 한 승인자 배달 실패(예: DM insert 레이스)가 나머지 승인자
    배달이나, 이 함수를 부르는 caller의 게이트 생성 트랜잭션 자체를 poison 하지 않는다
    ([[feedback_savepoint_failopen_session_poison]] — bare flush 실패 후 세션 오염이 후속
    write를 통째로 삼키는 클래스).

    project_id 없는 work_item(비정상 상태 또는 project-무관 work_item_type)은 배달 스킵
    (무대상, 조용히 반환) — project 없이는 `_get_or_create_approval_dm`의 DM project_id를
    채울 수 없다.
    """
    if not project_id or not approver_ids:
        return

    # story #2985 — designated_approver_id는 반드시 approver_ids(해소 권한 실보유자) 안에
    # 있어야 유효하다. 벗어난 값(오탈자·이미 org를 떠난 member 등)을 그대로 믿으면 지정자가
    # 카드 자체를 못 받거나(루프가 approver_ids만 돎), 권한 없는 사람에게 액션 카드를 주는
    # 두 실패 중 하나가 조용히 난다 — fail-safe로 미지정(현행 전원-액션) 취급.
    if designated_approver_id is not None and designated_approver_id not in approver_ids:
        logger.warning(
            "approval-request designated_approver_id가 approver_ids 밖 — 미지정 취급 %s=%s designated=%s",
            work_item_type, work_item_id, designated_approver_id,
        )
        designated_approver_id = None

    from app.routers.conversations import _dispatch_conversation_event
    from app.services.member_resolver import lookup_members_by_ids

    requester = (await lookup_members_by_ids({requester_id}, db)).get(requester_id)
    if requester is None:
        logger.warning(
            "approval-request 카드 배달 스킵 — requester 미확인 %s=%s", work_item_type, work_item_id,
        )
        return

    for approver_id in approver_ids:
        is_designated = designated_approver_id is None or approver_id == designated_approver_id
        card_kind = "request" if is_designated else "request_info"
        try:
            async with db.begin_nested():
                conv = await _get_or_create_approval_dm(
                    db,
                    org_id=org_id,
                    project_id=project_id,
                    requester_id=requester_id,
                    approver_id=approver_id,
                )
                msg = ConversationMessage(
                    conversation_id=conv.id,
                    sender_id=requester_id,
                    content=f"'{title}' 결재 요청",
                    mentioned_ids=[approver_id],
                    msg_metadata={
                        "activation": {
                            "audience": [str(approver_id)],
                            "kind": card_kind,
                            "expects_response": is_designated,
                        },
                        "approval_target": {
                            "work_item_type": work_item_type,
                            "work_item_id": str(work_item_id),
                            "gate_id": str(gate_id),
                            "actions": ["approve", "reject"],
                            "designated": is_designated,
                        },
                    },
                )
                db.add(msg)
                await db.flush()
                await _dispatch_conversation_event(db, conv, msg, org_id, requester)
        except Exception:  # noqa: BLE001 — best-effort, 개별 승인자 실패가 상신을 막지 않음.
            logger.warning(
                "approval-request 카드 배달 실패 %s=%s approver=%s",
                work_item_type, work_item_id, approver_id, exc_info=True,
            )


async def dispatch_approval_result_reply(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_type: str,
    work_item_id: uuid.UUID,
    project_id: uuid.UUID,
    title: str,
    gate_id: uuid.UUID,
    requester_id: uuid.UUID,
    resolver_id: uuid.UUID,
    decision: str,
    resolution_note: str | None,
    event_type: str = "doc_approval_resolved",
) -> None:
    """story #2624: 게이트 해소(승인/반려) 결과를 상신자에게 회신 — dispatch_approval_
    request_cards의 반대 방향(승인자→상신자). P2(#3007)는 상신→승인자 카드 전방 경로만
    만들었고 해소→상신자 회신 후방 경로가 없어, 상신자가 게이트를 폴링해야만 결과를 알 수
    있었다(선생님 직접 지적, 실사례 2026-08-13 07:20 반려·상신자 무통지).

    story #2709(2026-08-17) — doc 전용(`doc: Doc` 객체)이던 시그니처를 일반화했다(새 함수
    발명 0, 파라미터화). `agent_decision_request`처럼 work_item이 Doc이 아니거나(또는
    work_item이 gate 자기참조뿐인 standalone) 호출부는 자기가 가진 값을 그대로 넘긴다.

    상신자↔해소자 기존 DM(같은 dm_pair_key — get_or_create가 인자 순서 무관하게 같은 방을
    찾는다)에 message_kind="result" 카드 게시 + 기존 _dispatch_conversation_event 재사용
    으로 메인 dispatch — 상신자가 agent면 **이 경로로** 도달한다(오늘 PO가 못 받았던 그
    자리, AC1). human 상신자는 추가로 벨 알림까지(dispatch_notification, agent는 기존
    관례대로 대상에서 제외 — approval_delivery.py의 dispatch_approval_request_cards와
    동일 비대칭).

    해소자 본인이 상신자인 경우(SoD가 정상적으로 막지만 방어심층) 자기-알림 스킵(AC3).
    """
    if not project_id or resolver_id == requester_id:
        return

    from app.routers.conversations import _dispatch_conversation_event
    from app.services.member_resolver import lookup_members_by_ids

    resolver = (await lookup_members_by_ids({resolver_id}, db)).get(resolver_id)
    if resolver is None:
        logger.warning("approval-result 회신 스킵 — resolver 미확인 work_item=%s", work_item_id)
        return

    decision_label = "승인" if decision == "approved" else "반려"
    content = f"'{title}' 결재 결과: {decision_label}"
    if resolution_note:
        content += f"\n사유: {resolution_note}"

    try:
        async with db.begin_nested():
            conv = await _get_or_create_approval_dm(
                db, org_id=org_id, project_id=project_id,
                requester_id=requester_id, approver_id=resolver_id,
            )
            msg = ConversationMessage(
                conversation_id=conv.id,
                sender_id=resolver_id,
                content=content,
                mentioned_ids=[requester_id],
                msg_metadata={
                    "activation": {
                        "audience": [str(requester_id)],
                        "kind": "result",
                        "expects_response": False,
                    },
                    "approval_target": {
                        "work_item_type": work_item_type,
                        "work_item_id": str(work_item_id),
                        "gate_id": str(gate_id),
                        "decision": decision,
                        "resolution_note": resolution_note,
                    },
                },
            )
            db.add(msg)
            await db.flush()
            await _dispatch_conversation_event(db, conv, msg, org_id, resolver)
    except Exception:  # noqa: BLE001 — best-effort, 회신 실패가 해소를 막지 않음.
        logger.warning(
            "approval-result 회신 배달 실패 work_item=%s requester=%s",
            work_item_id, requester_id, exc_info=True,
        )
        # ⛔카디르 QA(#3015): 여기 `return`이 있으면 DM 실패가 아래 벨 알림까지 같이
        # 죽인다 — "별개 SAVEPOINT·독립"이라는 이 함수의 약속과 정반대(단방향 의존).
        # 이 PR이 막으려던 "폴링 없인 결과 모름"이 정확히 이 실패모드에서 재발한다 —
        # DM 실패해도 벨은 별도로 시도해야 하므로 return하지 않고 다음 블록으로 진행.

    # human 상신자에겐 벨 알림도(AC1). 위 DM dispatch와 완전히 독립된 형제 try/except —
    # 하나 실패해도 다른 하나는 그대로 시도된다(doc.py의 벨-알림/카드-배달 독립 채널 관례와
    # 진짜 동형 — DM 블록의 실패가 여기로 전파되지 않는다).
    try:
        requester = (await lookup_members_by_ids({requester_id}, db)).get(requester_id)
        if requester is not None and requester.type == "human":
            async with db.begin_nested():
                from app.services.notification_dispatch import dispatch_notification
                await dispatch_notification(
                    db, org_id=org_id, event_type=event_type,
                    target_member_ids=[requester_id],
                    title=f"결재 결과: {decision_label}",
                    body=resolution_note or f"'{title}'가 {decision_label}됐습니다.",
                    reference_type="gate", reference_id=gate_id,
                    source_project_id=project_id,
                    # story #2696: outbox 이관(동일 결함 클래스 예방).
                    via_outbox=True,
                )
    except Exception:  # noqa: BLE001 — 벨 알림 실패는 카드 배달과 독립.
        logger.warning(
            "approval-result 벨 알림 실패 work_item=%s requester=%s",
            work_item_id, requester_id, exc_info=True,
        )


async def dispatch_approval_discussion_reply(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    doc: Doc,
    gate_id: uuid.UUID,
    requester_id: uuid.UUID,
    resolver_id: uuid.UUID,
    reason: str,
) -> None:
    """story #2631 — `dispatch_approval_result_reply`의 자매 함수. 승인/반려 둘 중 하나로
    강제되지 않고 "보류(논의 필요)"를 표현하고 싶다는 게 원 실사용 요구(선생님 08-13
    19:49) — 이 함수가 그 세 번째 회신 형태. 게이트는 pending 그대로라 gate.status를
    참조하지 않는다(호출부 request_gate_discussion이 이미 pending 확인 완료).

    구조는 dispatch_approval_result_reply와 동형(같은 DM·독립 SAVEPOINT 둘·human만 벨) —
    `decision`/`message_kind`/알림 문구만 논의-요청 전용으로 갈린다."""
    if not doc.project_id or resolver_id == requester_id:
        return

    from app.routers.conversations import _dispatch_conversation_event
    from app.services.member_resolver import lookup_members_by_ids

    resolver = (await lookup_members_by_ids({resolver_id}, db)).get(resolver_id)
    if resolver is None:
        logger.warning("approval-discussion 회신 스킵 — resolver 미확인 doc=%s", doc.id)
        return

    content = f"'{doc.title}' 문서 결재 — 논의 요청\n사유: {reason}"

    try:
        async with db.begin_nested():
            conv = await _get_or_create_approval_dm(
                db, org_id=org_id, project_id=doc.project_id,
                requester_id=requester_id, approver_id=resolver_id,
            )
            msg = ConversationMessage(
                conversation_id=conv.id,
                sender_id=resolver_id,
                content=content,
                mentioned_ids=[requester_id],
                msg_metadata={
                    "activation": {
                        "audience": [str(requester_id)],
                        "kind": "discuss",
                        "expects_response": True,
                    },
                    "approval_target": {
                        "work_item_type": "doc",
                        "work_item_id": str(doc.id),
                        "gate_id": str(gate_id),
                        "decision": "discuss",
                        "resolution_note": reason,
                    },
                },
            )
            db.add(msg)
            await db.flush()
            await _dispatch_conversation_event(db, conv, msg, org_id, resolver)
    except Exception:  # noqa: BLE001 — best-effort, 회신 실패가 논의 요청 자체를 막지 않음.
        logger.warning(
            "approval-discussion 회신 배달 실패 doc=%s requester=%s",
            doc.id, requester_id, exc_info=True,
        )
        # dispatch_approval_result_reply와 동일 원칙 — DM 실패가 벨 알림까지 죽이지 않게
        # return하지 않고 다음 블록으로 진행.

    try:
        requester = (await lookup_members_by_ids({requester_id}, db)).get(requester_id)
        if requester is not None and requester.type == "human":
            async with db.begin_nested():
                from app.services.notification_dispatch import dispatch_notification
                await dispatch_notification(
                    db, org_id=org_id, event_type="doc_approval_discussion_requested",
                    target_member_ids=[requester_id],
                    title="문서 결재 — 논의 요청",
                    body=reason or f"'{doc.title}' 문서 결재에 대해 논의를 요청받았습니다.",
                    reference_type="gate", reference_id=gate_id,
                    source_project_id=doc.project_id,
                    # story #2696: outbox 이관(동일 결함 클래스 예방).
                    via_outbox=True,
                )
    except Exception:  # noqa: BLE001 — 벨 알림 실패는 카드 배달과 독립.
        logger.warning(
            "approval-discussion 벨 알림 실패 doc=%s requester=%s",
            doc.id, requester_id, exc_info=True,
        )


async def notify_gate_card_recipients_resolved(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    status: str,
    resolver_id: uuid.UUID | None,
    resolved_at,
) -> list[tuple[str, dict]]:
    """story #2985 AC2(PO 계약 확定 2026-08-24) — 해소 시 원 카드(액션 kind="request"·정보성
    kind="request_info" 무관)를 받았던 모든 승인자의 열린 화면이 새로고침 없이 "처리됨"으로
    갱신되도록, `conversation.gate_resolved` 이벤트를 심는다.

    새 ConversationMessage는 만들지 않는다(정보성 카드까지 해소마다 챗버블 스팸이 되는 것을
    피한다 — 순수 SSE 신호, 챗 히스토리에 안 남음).

    "실제 카드가 심어진 곳" 역조회 — approver_ids를 다시 계산하지 않고,
    dispatch_approval_request_cards가 그때 실제로 ConversationMessage.mentioned_ids에 태운
    값을 msg_metadata.approval_target.gate_id로 찾는다(conversations.py::
    _batch_resolve_linked_proof와 동일 축의 조회, 이 스토리에서 새로 발명한 메커니즘 아님) —
    그 사이 조직 멤버십이 바뀌어도(탈퇴 등) "그때 실제로 카드를 봤던 사람" 기준이라 안전.
    Event.project_id도 이 조회로 찾은 conversation의 실 project_id를 그대로 쓴다(호출자가
    gate_type별 project_id 해소 로직을 또 만들 필요 없음 — 카드가 이미 project-scope된 DM에
    심어져 있으므로).

    `_dispatch_conversation_event`(conversations.py)와 동일 계약 — Event를 DB에 남기고
    [(pid_str, payload)]를 반환할 뿐, 실 SSE push(`_push_to_agent`)는 호출자가 commit 後에
    한다(레이스 방지 원칙 동일 — Event가 커밋된 상태에서 push해야 클라가 재조회해도 일관된
    값을 본다)."""
    rows = (await db.execute(
        select(ConversationMessage.conversation_id, ConversationMessage.mentioned_ids).where(
            ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(gate_id),
        )
    )).all()
    if not rows:
        return []

    conv_ids = {row.conversation_id for row in rows}
    conv_project_ids = dict((await db.execute(
        select(Conversation.id, Conversation.project_id).where(Conversation.id.in_(conv_ids))
    )).all())

    recipient_project_ids: dict[uuid.UUID, uuid.UUID] = {}
    for row in rows:
        proj_id = conv_project_ids.get(row.conversation_id)
        if proj_id is None:
            continue  # project 없는 conversation은 스킵(Event.project_id NOT NULL) — 조용히 건너뜀.
        for mid in (row.mentioned_ids or []):
            try:
                recipient_project_ids[uuid.UUID(str(mid))] = proj_id
            except (ValueError, TypeError, AttributeError):
                continue  # 손상된/구형 payload — 지어내지 않고 건너뜀(_batch_resolve_linked_proof 동일 관례).
    if not recipient_project_ids:
        return []

    from app.services.member_resolver import lookup_members_by_ids
    members = await lookup_members_by_ids(set(recipient_project_ids), db)

    payload_base = {
        "gate_id": str(gate_id), "status": status,
        "resolver_id": str(resolver_id) if resolver_id else None,
        "resolved_at": resolved_at.isoformat() if resolved_at else None,
    }

    events: list[Event] = []
    for member_id, proj_id in recipient_project_ids.items():
        member = members.get(member_id)
        m_type = member.type if member is not None else "human"
        event = Event(
            project_id=proj_id, org_id=org_id, event_type="conversation.gate_resolved",
            source_entity_type="gate", source_entity_id=gate_id,
            sender_id=resolver_id, recipient_id=member_id, recipient_type=m_type,
            payload=payload_base, status="pending",
        )
        db.add(event)
        events.append(event)

    await db.flush()
    pushes: list[tuple[str, dict]] = []
    for event in events:
        pushes.append((
            str(event.recipient_id),
            {"event_id": str(event.id), "event_type": "conversation.gate_resolved", **payload_base,
             "recipient_id": str(event.recipient_id)},
        ))
    return pushes
