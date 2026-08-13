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

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation, ConversationMessage
from app.models.doc import Doc

logger = logging.getLogger(__name__)


async def _get_or_create_approval_dm(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    requester_id: uuid.UUID,
    approver_id: uuid.UUID,
) -> Conversation:
    """requester↔approver 기존 dm 재사용(가장 최근 1개), 없으면 생성.

    일반 create_conversation 엔드포인트의 "매 호출 신규" 정책(EF-S2, db75ecd0)과 의도적으로
    다르다 — 승인자당 안정적 단일 스레드(카드 상태 갱신 대상)가 필요한 시스템 배달 경로라서,
    여기 한정으로 get-or-create를 쓴다(엔드포인트 자체는 무변경).

    _enforce_agent_creator_policy 미적용: 사용자가 여는 방이 아니라, 게이트가 이미 독립적으로
    인가한(요청자=문서 상신자, 대상=org owner/admin) 시스템 발신 알림 배달이다.
    """
    pair_key = "|".join(str(m) for m in sorted((requester_id, approver_id)))
    existing = (
        await db.execute(
            select(Conversation)
            .where(
                Conversation.org_id == org_id,
                Conversation.type == "dm",
                Conversation.dm_pair_key == pair_key,
            )
            .order_by(Conversation.created_at.desc())
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
    doc: Doc,
    gate_id: uuid.UUID,
    requester_id: uuid.UUID,
    approver_ids: list[uuid.UUID],
) -> None:
    """승인자별 DM에 message_kind="request" 카드 메시지 게시 + SSE 이벤트(AC1/AC2).

    승인자별 SAVEPOINT 격리 — 한 승인자 배달 실패(예: DM insert 레이스)가 나머지 승인자
    배달이나, 이 함수를 부르는 doc 상신 트랜잭션(gate 생성·doc.status='pending') 자체를
    poison 하지 않는다([[feedback_savepoint_failopen_session_poison]] — bare flush 실패
    후 세션 오염이 후속 write를 통째로 삼키는 클래스).

    project_id 없는 doc(비정상 상태)은 배달 스킵(무대상, 조용히 반환).
    """
    if not doc.project_id or not approver_ids:
        return

    from app.routers.conversations import _dispatch_conversation_event
    from app.services.member_resolver import lookup_members_by_ids

    requester = (await lookup_members_by_ids({requester_id}, db)).get(requester_id)
    if requester is None:
        logger.warning("approval-request 카드 배달 스킵 — requester 미확인 doc=%s", doc.id)
        return

    for approver_id in approver_ids:
        try:
            async with db.begin_nested():
                conv = await _get_or_create_approval_dm(
                    db,
                    org_id=org_id,
                    project_id=doc.project_id,
                    requester_id=requester_id,
                    approver_id=approver_id,
                )
                msg = ConversationMessage(
                    conversation_id=conv.id,
                    sender_id=requester_id,
                    content=f"'{doc.title}' 문서 결재 요청",
                    mentioned_ids=[approver_id],
                    msg_metadata={
                        "activation": {
                            "audience": [str(approver_id)],
                            "kind": "request",
                            "expects_response": True,
                        },
                        "approval_target": {
                            "work_item_type": "doc",
                            "work_item_id": str(doc.id),
                            "gate_id": str(gate_id),
                            "actions": ["approve", "reject"],
                        },
                    },
                )
                db.add(msg)
                await db.flush()
                await _dispatch_conversation_event(db, conv, msg, org_id, requester)
        except Exception:  # noqa: BLE001 — best-effort, 개별 승인자 실패가 상신을 막지 않음.
            logger.warning(
                "approval-request 카드 배달 실패 doc=%s approver=%s",
                doc.id, approver_id, exc_info=True,
            )
