"""R2(da9d1781): 실시간 presence/working SSE 이벤트 발행 — 폴링 대체.

기존 event-stream(events.publish_event·pg_pubsub 멀티인스턴스 backplane) 위에 **이벤트 타입만 추가**:
- `conversation.working` — 채팅 typing 인디케이터(FE 1.5s 폴링 `/conversations/{id}/working` 대체)
- `presence` — 팀 presence 변경 트리거(FE 3s 폴링 `/team-presence` 대체)

best-effort: 발행 실패가 caller(메시지 dispatch·reply·SSE 연결 lifecycle)를 절대 깨지 않는다(try/except).
publish_event 는 sync — 동기 발행점(chat_presence transition 등)에서도 호출 가능.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def emit_conversation_working(org_id, conversation_id) -> None:
    """해당 conversation 의 현재 working member 목록을 push(채팅 typing). FE 가 폴링 없이 이벤트로 갱신."""
    try:
        from app.routers.events import publish_event
        from app.services import chat_presence

        publish_event(
            str(org_id),
            "conversation.working",
            {
                "conversation_id": str(conversation_id),
                "working": chat_presence.list_working(str(conversation_id)),
            },
        )
    except Exception:
        logger.warning("emit conversation.working failed conv=%s", conversation_id, exc_info=True)


def emit_presence(org_id) -> None:
    """팀 presence(online/idle/working) 변경 트리거. FE 가 /team-presence 를 1회 refetch(폴링 대체).

    경량 트리거(스냅샷 미포함) — presence 집계는 DB 조회라 sync 발행점에서 산출하지 않고 FE refetch 에 위임.
    """
    try:
        from app.routers.events import publish_event

        publish_event(str(org_id), "presence", {})
    except Exception:
        logger.warning("emit presence failed org=%s", org_id, exc_info=True)
