"""E-SSE-PUBSUB S1/S2: PostgreSQL LISTEN/NOTIFY 발행·수신 레이어.

S1: publish_event() / _push_to_agent() 내부에서 pg_notify() 호출.
S2: listen_loop() — 다른 인스턴스의 NOTIFY를 수신해 로컬 큐 디스패치.
실패 시 로컬 전파는 정상 유지 — graceful degradation.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

logger = logging.getLogger(__name__)

INSTANCE_ID: str = str(uuid.uuid4())
"""앱 기동 시 1회 생성 — 자기 자신이 발행한 notify 재수신 방지용."""

_CHANNEL = "sse_events"
_MAX_PAYLOAD_BYTES = 7500  # 8KB PG 제한 대비 여유

# ── NOTIFY 발행 ────────────────────────────────────────────────────────────────

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


# ── LISTEN 수신기 ──────────────────────────────────────────────────────────────

def _on_notification(conn: object, pid: int, channel: str, payload_str: str) -> None:
    """asyncpg 알림 콜백 (sync). 수신 즉시 dispatch task 스케줄."""
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_dispatch_received(payload_str))
    except Exception as exc:
        logger.warning("pg_listen dispatch schedule failed: %s", exc)


async def _dispatch_received(payload_str: str) -> None:
    """LISTEN 수신 payload → 로컬 큐 디스패치. pg_notify 재발행 금지."""
    try:
        payload = json.loads(payload_str)
    except (json.JSONDecodeError, ValueError):
        return

    # 자기 자신이 발행한 이벤트 skip
    if payload.get("instance_id") == INSTANCE_ID:
        return

    target = payload.get("target")
    target_id = str(payload.get("target_id", ""))
    event_type = str(payload.get("event_type", ""))
    data = payload.get("data") or {}

    try:
        from app.routers.events import publish_event, _push_to_agent
        if target == "org":
            publish_event(target_id, event_type, data, _from_listener=True)
        elif target == "agent":
            _push_to_agent(target_id, data, _from_listener=True)
    except Exception as exc:
        logger.warning("pg_listen dispatch failed target=%s: %s", target, exc)


def _resolve_listen_url(s=None) -> str:
    """LISTEN raw 연결 URL — ee7794eb ③: DB_PGBOUNCER on 時 transaction-mode PgBouncer 는 LISTEN/NOTIFY
    미지원이라 **direct Cloud SQL**(database_url_direct)로 우회. 미설정 폴백=database_url(non-PgBouncer)."""
    if s is None:
        from app.core.config import settings as s
    return (s.database_url_direct or s.database_url).replace("postgresql+asyncpg://", "postgresql://", 1)


def check_listen_config(s=None) -> None:
    """fail-closed: DB_PGBOUNCER on 인데 direct URL 없으면 raise — LISTEN 이 PgBouncer 경유로 깨지는
    misconfig 를 startup서 차단(silent 이벤트 유실 방지). main lifespan 이 create_task 前 호출."""
    if s is None:
        from app.core.config import settings as s
    if s.db_pgbouncer and not s.database_url_direct:
        raise RuntimeError(
            "DB_PGBOUNCER=on requires DATABASE_URL_DIRECT — pg_pubsub LISTEN 은 transaction-mode "
            "PgBouncer 비호환이라 direct Cloud SQL URL 필수 (fail-closed·ee7794eb ③)."
        )


async def listen_loop() -> None:
    """PG LISTEN 수신 루프. lifespan startup에서 background task로 실행.

    - raw asyncpg 전용 커넥션 1개 (SQLAlchemy pool 미점유·DB_PGBOUNCER 시 direct Cloud SQL 우회)
    - 연결 실패 시 exponential backoff 1s→2s→4s→max 30s
    - CancelledError 수신 시 커넥션 정리 후 종료
    """
    import asyncpg

    raw_url = _resolve_listen_url()
    delay = 1.0

    logger.info("pg_listen starting on channel=%s instance=%s", _CHANNEL, INSTANCE_ID)

    while True:
        conn: asyncpg.Connection | None = None
        try:
            conn = await asyncpg.connect(raw_url)
            await conn.add_listener(_CHANNEL, _on_notification)
            delay = 1.0  # 연결 성공 시 backoff 리셋
            logger.info("pg_listen connected")
            # 커넥션 유지 — CancelledError까지 대기
            while True:
                await asyncio.sleep(30)
        except asyncio.CancelledError:
            logger.info("pg_listen cancelled — shutting down")
            break
        except Exception as exc:
            logger.warning("pg_listen error: %s — reconnecting in %.1fs", exc, delay)
        finally:
            if conn is not None:
                try:
                    await conn.remove_listener(_CHANNEL, _on_notification)
                    await conn.close()
                except Exception:
                    pass
        await asyncio.sleep(delay)
        delay = min(delay * 2, 30)
