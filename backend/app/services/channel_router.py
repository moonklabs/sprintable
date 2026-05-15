"""S-A4: ChannelRouter — 메시지 수신자별 전달 채널 결정 서비스.

라우팅만 담당. 전달(dispatch)은 caller의 책임.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import ConversationMessage, ConversationParticipant
from app.models.notification_preference import NotificationPreference
from app.models.team import TeamMember


class ChannelRouterError(Exception):
    """ChannelRouter 장애 시 typed exception — caller가 SSE fallback 가능."""


@dataclass
class DeliveryDecision:
    member_id: uuid.UUID
    channel: str
    level: str
    reason: str


async def route_message(
    message_id: uuid.UUID,
    db: AsyncSession,
) -> list[DeliveryDecision]:
    """메시지 수신자별 DeliveryDecision 목록 반환.

    mute인 경우 해당 수신자 제외 (decision 미생성).
    mentions level인 경우 message content에 @{member_id} 없으면 제외.
    agent↔agent: preference 무관 sse 강제.
    """
    try:
        # 1. 메시지 + 발신자 조회
        msg = (await db.execute(
            select(ConversationMessage).where(ConversationMessage.id == message_id)
        )).scalar_one_or_none()
        if msg is None:
            raise ChannelRouterError(f"Message {message_id} not found")

        # 2. 발신자 type 확인
        sender_type: str | None = None
        if msg.sender_id:
            sender_type = (await db.execute(
                select(TeamMember.type).where(TeamMember.id == msg.sender_id)
            )).scalar_one_or_none()

        # 3. conversation participants (발신자 제외)
        participant_rows = (await db.execute(
            select(ConversationParticipant.member_id).where(
                ConversationParticipant.conversation_id == msg.conversation_id,
            )
        )).scalars().all()
        recipient_ids = [pid for pid in participant_rows if pid != msg.sender_id]
        if not recipient_ids:
            return []

        # 4. 수신자 type 배치 조회
        member_rows = (await db.execute(
            select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(recipient_ids))
        )).all()
        member_type_map: dict[uuid.UUID, str] = {r[0]: r[1] for r in member_rows}

        # 5. preference 배치 조회 — thread/conversation/global 3 scope
        scope_ids_to_check: list[uuid.UUID | None] = []
        scope_type_order: list[tuple[str, uuid.UUID | None]] = []
        if msg.thread_id:
            scope_type_order.append(("thread", msg.thread_id))
            scope_ids_to_check.append(msg.thread_id)
        scope_type_order.append(("conversation", msg.conversation_id))
        scope_ids_to_check.append(msg.conversation_id)
        scope_type_order.append(("global", None))

        pref_rows = (await db.execute(
            select(NotificationPreference).where(
                NotificationPreference.member_id.in_(recipient_ids),
            )
        )).scalars().all()

        # member_id → {(scope_type, scope_id): NotificationPreference}
        pref_map: dict[uuid.UUID, dict[tuple[str, uuid.UUID | None], NotificationPreference]] = {}
        for p in pref_rows:
            pref_map.setdefault(p.member_id, {})[(p.scope_type, p.scope_id)] = p

        # 6. 수신자별 라우팅 결정
        decisions: list[DeliveryDecision] = []
        for rid in recipient_ids:
            recipient_type = member_type_map.get(rid, "human")

            # agent↔agent → sse 강제 (AC5)
            if sender_type == "agent" and recipient_type == "agent":
                decisions.append(DeliveryDecision(
                    member_id=rid,
                    channel="sse",
                    level="all",
                    reason="agent-to-agent forced sse",
                ))
                continue

            # preference fallback: thread → conversation → global
            pref: NotificationPreference | None = None
            matched_scope = "global"
            for stype, sid in scope_type_order:
                candidate = pref_map.get(rid, {}).get((stype, sid))
                if candidate is not None:
                    pref = candidate
                    matched_scope = stype
                    break

            channel = pref.channel if pref else "sse"
            level = pref.level if pref else "all"

            # mute → skip (AC3)
            if level == "mute":
                continue

            # mentions → @{member_id} 포함 여부 체크 (AC4)
            if level == "mentions":
                pattern = rf"@{re.escape(str(rid))}"
                if not re.search(pattern, msg.content or ""):
                    continue

            decisions.append(DeliveryDecision(
                member_id=rid,
                channel=channel,
                level=level,
                reason=f"preference scope={matched_scope}",
            ))

        return decisions

    except ChannelRouterError:
        raise
    except Exception as exc:
        raise ChannelRouterError(f"ChannelRouter failed for message {message_id}: {exc}") from exc
