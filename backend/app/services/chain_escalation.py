"""story #2617: human-less 대화의 chain-expired 상태를 대화 밖(org owner/admin)으로 승격.

DM 전용 예외(#3009)를 human-presence 예외로 일반화(channel_router.py)하면서, human이
없는 대화는 더 이상 chain-depth 게이트로 전달이 막히지 않는다(속도 우선, #2617 PO 지시) —
대신 "무감독 연쇄가 계속되고 있다"를 아무도 모르는 채로 두면 안 된다(AC4, 조용한 단락 금지).
이 모듈은 대화 참가자가 아니라 **org owner/admin**에게 대화 밖에서 알린다(그 대화엔 알릴
human이 아예 없으므로).

⚠️이 알림은 «관측»이지 «차단»이 아니다 — 진짜 A↔B 무한루프가 토큰을 계속 태우는 문제
자체는 이 스토리 스코프 밖이다(#2617 스토리 본문 «잔여 위험» 명시, PO 조건(b) — 휴리스틱
탐지·org 설정 상한은 후속 축).

⚠️대화당 24시간 쿨다운으로 dedup한다(PO 조건(a)) — 우리 fleet 자체가 customer-zero라
팀 DM 전부가 상시 human-less 연쇄다. dedup 없이는 org owner가 일상 작업마다 알림 스팸을
받는다. Redis 불가 시 fail-closed(스팸 방지가 관측성보다 우선 — 미발화가 스팸보다 안전).
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

_COOLDOWN_SEC = 24 * 60 * 60  # 24h/대화 — PO 조건(a) 예시값 그대로.


async def _claim_escalation_slot(conversation_id: uuid.UUID) -> bool:
    """이 대화에 대해 지금 알림을 쏴야 하는지(dedup) — Redis SET NX EX. True = 이번이 이
    쿨다운 창의 첫 발화(알림 진행). Redis 클라이언트 없음/에러 시 False(fail-closed)."""
    from app.services import redis_shared

    key = redis_shared.key("chain_escalation", str(conversation_id))

    async def _op(client) -> bool:
        return bool(await client.set(key, "1", nx=True, ex=_COOLDOWN_SEC))

    return await redis_shared.with_fallback(_op, lambda: False)


async def escalate_unsupervised_chain(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    conversation_id: uuid.UUID,
    project_id: uuid.UUID | None,
    depth: int,
    cap: int,
) -> None:
    """human-less 대화가 chain cap을 넘었음을 org owner/admin에게 대화 밖 알림으로 승격.
    best-effort·24h/대화 dedup·실패해도 메시지 발신 트랜잭션을 막지 않는다(caller가
    savepoint로 격리해 호출하는 것을 전제 — doc.py의 approval 알림과 동일 관례).

    ⛔핫픽스(2026-08-13, 선생님 직접 지시): settings.chain_escalation_notify_enabled(기본
    False)로 게이트 — 원 게이트 조건(depth > cap)이 human-less 대화에서 영구 참인 상시
    상태라 에피소드 개념 없이 24h마다 전량 재발화해 알림 폭주를 냈다. 재설계(상시 상태가
    아니라 새 폭주 에피소드/이상 패턴 기반) 전까지 발화만 차단(코드/dedup 로직은 유지 —
    agent_group_default_mentions와 동형 패턴)."""
    from app.core.config import settings
    if not settings.chain_escalation_notify_enabled:
        return
    try:
        if not await _claim_escalation_slot(conversation_id):
            return  # 쿨다운 중 — 이미 알렸음(스팸 방지, PO 조건(a))

        from app.models.project import OrgMember
        from app.services.notification_dispatch import dispatch_notification

        approver_ids = (await db.execute(
            select(OrgMember.id).where(
                OrgMember.org_id == org_id,
                OrgMember.role.in_(("owner", "admin")),
                OrgMember.deleted_at.is_(None),
            )
        )).scalars().all()
        if not approver_ids:
            return

        await dispatch_notification(
            db, org_id=org_id, event_type="conversation.unsupervised_chain_expired",
            target_member_ids=list(approver_ids),
            title="무인간 대화 무감독 연쇄 감지",
            body=f"human 참가자가 없는 대화에서 에이전트 연쇄가 {depth}턴(cap {cap})을 넘었습니다.",
            reference_type="conversation", reference_id=conversation_id,
            source_project_id=project_id,
            via_outbox=True,
        )
    except Exception:  # noqa: BLE001 — best-effort, 메시지 발신을 막지 않는다.
        logger.warning(
            "unsupervised chain escalation failed conversation_id=%s", conversation_id, exc_info=True,
        )
