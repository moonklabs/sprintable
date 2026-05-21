"""E-SSE-PUBSUB S1: PostgreSQL LISTEN/NOTIFY 발행 레이어.

publish_event() / _push_to_agent() 내부에서 호출.
실패 시 로컬 전파는 정상 유지 — graceful degradation.
"""
from __future__ import annotations

import json
import logging
import uuid

logger = logging.getLogger(__name__)

INSTANCE_ID: str = str(uuid.uuid4())
"""앱 기동 시 1회 생성 — 자기 자신이 발행한 notify 재수신 방지용."""

_CHANNEL = "sse_events"
_MAX_PAYLOAD_BYTES = 7500  # 8KB PG 제한 대비 여유


async def pg_notify(
    target: str,
    target_id: str,
    event_type: str,
    data: dict,
) -> None:
    """PostgreSQL NOTIFY 단발 발행. SQLAlchemy 기존 풀 재활용.

    target: "org" | "agent"
    target_id: org_id | member_id (str)
    실패 시 경고 로그만 — 예외 전파 금지.
    """
    payload: dict = {
        "instance_id": INSTANCE_ID,
        "target": target,
        "target_id": target_id,
        "event_type": event_type,
        "data": data,
    }

    payload_str = json.dumps(payload, default=str)
    if len(payload_str.encode()) > _MAX_PAYLOAD_BYTES:
        # 8KB 초과 시 content 제거 — id/event_type으로 구독측 재조회 유도
        data_slim = {k: v for k, v in data.items() if k != "content"}
        payload["data"] = data_slim
        payload_str = json.dumps(payload, default=str)

    try:
        from sqlalchemy import text
        from app.core.database import async_session_factory
        async with async_session_factory() as session:
            await session.execute(
                text("SELECT pg_notify(:ch, :pl)"),
                {"ch": _CHANNEL, "pl": payload_str},
            )
            await session.commit()
    except Exception as exc:
        logger.warning(
            "pg_notify failed channel=%s target=%s target_id=%s: %s",
            _CHANNEL, target, target_id, exc,
        )
