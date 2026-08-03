"""S-A4: ChannelRouter — 메시지 수신자별 전달 채널 결정 서비스.

라우팅만 담당. 전달(dispatch)은 caller의 책임.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
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
        # ⚠️ team_members 는 0088 이후 projection VIEW — org-agent 멀티프로젝트 grant(project_access)면
        # 같은 member.id 가 프로젝트 수만큼 행을 낸다. 무필터 scalar_one_or_none 은 MultipleResultsFound
        # 로 route_message 전체를 깨 chat→agent dispatch 가 멈춘다. type 은 전 행 동형이라 .limit(1) 로
        # 한 행만 취해 안전(_resolve_api_key 동일 패턴). 단일프로젝트 agent·휴먼은 1행이라 거동 무변경.
        sender_type: str | None = None
        if msg.sender_id:
            sender_type = (await db.execute(
                select(TeamMember.type).where(TeamMember.id == msg.sender_id).limit(1)
            )).scalar_one_or_none()

        # 3. conversation participants (발신자 제외)
        participant_rows = (await db.execute(
            select(ConversationParticipant.member_id).where(
                ConversationParticipant.conversation_id == msg.conversation_id,
            )
        )).scalars().all()
        recipient_ids = [pid for pid in participant_rows if pid != msg.sender_id]

        # story #2349 AC3 — 라이브 검증(2026-08-03, PO+디디, 스레드 7256d5cc)에서 실측으로 발견:
        # send_message의 user_blocker_ids exclusion은 _dispatch_conversation_event(Event row)·
        # mention_targets·candidate_targets 3곳만 잡았고, 이 함수(route_message)는 별개 쿼리로
        # recipient_ids를 처음부터 다시 뽑아 그 exclusion이 전혀 안 닿았다 — webhook-covered
        # 수신자(에이전트 대다수의 실제 수신 경로)에게는 차단이 «전혀 안 먹는» 상태로 머지됐었다.
        # route_message는 코드베이스 전체에서 정의 1곳·호출 2곳(pre-check용 별칭 _route L2033·
        # 실 webhook 발송용 L702)뿐이고, decisions 소비 분기도 channel=="discord"(webhook)·
        # 그 외(sse) 정확히 둘뿐이다(grep 전수 확認) — recipient_ids 원재료가 만들어지는 이
        # 지점 한 곳이 sse·discord·향후 추가될 모든 채널의 공통 상류라, 여기서 한 번만 걸러도
        # 채널 수와 무관하게 구조적으로 전부 막힌다.
        #
        # ⚠️recipient_ids는 이 함수 안에서만 쓰이는 local(decisions 계산 전용) — 이 목록을
        # 밖으로 반환하거나 ConversationParticipant를 건드리지 않는다(PO 확認 요청, 2026-08-03).
        # 즉 여기서 거르는 것은 «이 메시지의 알림/발송 대상»뿐이고 「대화 참가자」 관계 자체는
        # 그대로다 — 참가자 목록·읽기 권한(list_messages/_authorize_message_read)은 이 함수를
        # 전혀 거치지 않는 별도 경로라 안 끊긴다.
        #
        # #2814와 같은 결의 fail-open — 조회 실패해도 라우팅 자체는 안 막는다(대화 전송을
        # 부수 조회 하나 때문에 죽이지 않는다는 동일 트레이드오프. 로그 문구도 동일 패턴으로
        # 맞춰 "차단이 새는 빈도"를 하나의 문구로 셀 수 있게 한다).
        if msg.sender_id and recipient_ids:
            try:
                from app.models.user_block import UserBlock
                blocker_ids = set((await db.execute(
                    select(UserBlock.blocker_member_id).where(UserBlock.blocked_member_id == msg.sender_id)
                )).scalars().all())
                if blocker_ids:
                    recipient_ids = [pid for pid in recipient_ids if pid not in blocker_ids]
            except Exception:
                import logging
                logging.getLogger(__name__).warning(
                    "user_blocker_ids lookup failed message_id=%s — fail-open(no exclusion)", msg.id,
                    exc_info=True,
                )

        if not recipient_ids:
            return []

        # 4. 수신자 type 배치 조회
        member_rows = (await db.execute(
            select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(recipient_ids))
        )).all()
        member_type_map: dict[uuid.UUID, str] = {r[0]: r[1] for r in member_rows}

        # 5. preference 배치 조회 — thread/conversation/project/global 4 scope
        # conversation의 project_id 조회 (project scope fallback용)
        conv_project_id: uuid.UUID | None = (await db.execute(
            select(Conversation.project_id).where(Conversation.id == msg.conversation_id)
        )).scalar_one_or_none()

        scope_type_order: list[tuple[str, uuid.UUID | None]] = []
        if msg.thread_id:
            scope_type_order.append(("thread", msg.thread_id))
        scope_type_order.append(("conversation", msg.conversation_id))
        if conv_project_id:
            scope_type_order.append(("project", conv_project_id))
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

            # CB-S1 AC3: mentioned_ids 배열 기반 mentions 판단 (content regex 폐기)
            if level == "mentions":
                if not (msg.mentioned_ids and rid in msg.mentioned_ids):
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
