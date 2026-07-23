"""R2(da9d1781): 실시간 presence/working SSE 이벤트 발행 — 폴링 대체.

기존 event-stream 위에 이벤트 타입만 추가:
- `conversation.working` — 채팅 typing 인디케이터(FE 1.5s 폴링 `/conversations/{id}/working` 대체)
- `presence` — 팀 presence 변경 트리거(FE 3s 폴링 `/team-presence` 대체)

story #2139/#2132(2026-07-23) 근본수정: 예전엔 `events.publish_event()`(org-level `_subscribers`
fanout)만 호출했는데, 그 레지스트리는 아무도 구독하지 않는 영구 죽은 코드였다(`_subscribers.add()`
호출처 저장소 전체 0곳 — 계측 건강 확認 후 양성대조(story.assignee_changed 14~30ms 도달)와
대조해 240초간 0건 확認, 관측 실패 아니라 진짜 죽은 경로). 지금은 `events.push_to_org_members()`
(`_push_to_agent()` 개별 push로 귀결 — 실제 배달 경로, cross-instance 포함)로 교체됐다.

best-effort: 발행 실패가 caller(메시지 dispatch·reply·SSE 연결 lifecycle)를 절대 깨지 않는다(try/except).
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


async def emit_conversation_working(org_id, conversation_id) -> None:
    """해당 conversation의 현재 working member 목록을 push(채팅 typing). FE가 폴링 없이 이벤트로 갱신.

    수신자 스코프(#2139 §3, 오르테가 확定): **참가자만** — payload가 conversation 단위라
    org 전체로 보내면 참가자가 아닌 사람에게도 새는 것이라 conversation.working과
    presence(org 전체)는 서로 다른 스코프를 각각 지켜야 한다.

    #2120: chat_presence.list_working이 async(Redis 공유)로 전환돼 이 함수도 async — 호출부는 await.
    """
    try:
        from app.models.conversation import ConversationParticipant
        from app.routers.events import push_to_org_members
        from app.services import chat_presence

        from app.core.database import async_session_factory
        from sqlalchemy import select

        async with async_session_factory() as session:
            rows = await session.execute(
                select(ConversationParticipant.member_id).where(
                    ConversationParticipant.conversation_id == conversation_id,
                )
            )
            participant_ids = {str(r[0]) for r in rows.all()}

        await push_to_org_members(
            str(org_id),
            "conversation.working",
            {
                "conversation_id": str(conversation_id),
                "working": await chat_presence.list_working(str(conversation_id)),
            },
            member_ids=participant_ids,
        )
    except Exception:
        logger.warning("emit conversation.working failed conv=%s", conversation_id, exc_info=True)


async def emit_presence(org_id) -> None:
    """팀 presence(online/idle/working) 변경 트리거. FE가 /team-presence를 1회 refetch(폴링 대체).

    수신자 스코프(#2139 §3, 오르테가 확定): **org 전체** — 호출부(agent_gateway.py 커넥트/
    디스커넥트, conversations.py working 변경) 전부 project_id를 애초에 안 들고 있다(에이전트는
    multi-project를 걸치고 DM 대화는 project 자체가 없음 — 데이터가 원래 org 단위). 좁히려면
    호출부의 project_id 조달이 선행돼야 하므로 이 스토리(버그수정) 스코프 밖 — 별도 스토리.

    경량 트리거(스냅샷 미포함) — presence 집계는 DB 조회라 sync 발행점에서 산출하지 않고 FE refetch에 위임.
    """
    try:
        from app.routers.events import push_to_org_members

        await push_to_org_members(str(org_id), "presence", {})
    except Exception:
        logger.warning("emit presence failed org=%s", org_id, exc_info=True)
