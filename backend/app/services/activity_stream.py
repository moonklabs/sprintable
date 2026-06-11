"""L1 BE-2: canonical 활동 mapper/extractor (블루프린트 §3.2·§5).

events 행을 canonical 활동(activity_events)으로 정규화한다. 수신자 fan-out(1 dispatch →
N recipient event)은 같은 dedup_key로 1 활동에 병합되고 source_event_ids/recipient_ids에
누적된다(array union). 추출은 idempotent하다.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid

from sqlalchemy import select, text, tuple_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity_event import ActivityEvent
from app.models.event import Event

logger = logging.getLogger(__name__)

# AC③: 수신자/배달 전용 필드는 fingerprint·dedup 식별에서 제외한다(fan-out은 같은 활동).
_DELIVERY_ONLY_KEYS = frozenset(
    {"recipient", "recipient_id", "recipient_type", "is_backfill", "event_id", "recipient_seq"}
)


def canonical_verb(event: Event) -> str:
    """AC②: 'dispatched' wrapper면 payload.event_type(내부 알림 verb)로 unwrap, 아니면 event_type."""
    if event.event_type == "dispatched":
        inner = (event.payload or {}).get("event_type")
        if isinstance(inner, str) and inner:
            return inner
    return event.event_type


def canonical_payload_fingerprint(payload: dict | None) -> str:
    """AC③: delivery-only 필드를 뺀 의미 payload의 결정적 해시(정렬 JSON → sha256)."""
    core = {k: v for k, v in (payload or {}).items() if k not in _DELIVERY_ONLY_KEYS}
    serialized = json.dumps(core, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def build_dedup_key(event: Event) -> str:
    """canonical 활동 식별자 — 수신자 fan-out은 같은 dedup_key로 1행 병합(AC④).

    구성 = (verb, object_type, object_id, actor, occurred_at, payload_fingerprint).
    fan-out 이벤트는 단일 dispatch flush라 created_at(occurred_at)을 공유하므로 시간을
    포함해도 같은 활동은 병합되고 별개 dispatch는 분리된다. recipient 등 delivery-only는
    fingerprint에서 이미 제외(AC③)되어 수신자별로 키가 갈리지 않는다.
    """
    parts = [
        canonical_verb(event),
        event.source_entity_type or "",
        str(event.source_entity_id or ""),
        str(event.sender_id or ""),
        event.created_at.isoformat() if event.created_at else "",
        canonical_payload_fingerprint(event.payload),
    ]
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def _canonical_payload(payload: dict | None) -> dict:
    return {k: v for k, v in (payload or {}).items() if k not in _DELIVERY_ONLY_KEYS}


# 같은 dedup_key 충돌 시 배열을 중복 없이 합집합(순서 무의미·set 의미). DO UPDATE라 양쪽 모두
# 비어있지 않지만 coalesce로 방어.
def _array_union_sql(column: str, cast: str) -> text:
    return text(
        f"(SELECT coalesce(array_agg(DISTINCT x), '{{}}'::{cast}) "
        f"FROM unnest(activity_events.{column} || excluded.{column}) AS x)"
    )


async def upsert_activity_from_events(db: AsyncSession, event_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """events → activity_events 추출/upsert. 같은 dedup_key는 source/recipient를 array union으로
    누적(AC④)하며, 재실행해도 결과가 동일하다(AC⑤ idempotent — array_agg DISTINCT).

    반환: 영향 활동의 activity_id 목록(입력 event 순서, created_at·id 정렬).
    """
    if not event_ids:
        return []

    rows = (
        await db.execute(
            select(Event).where(Event.id.in_(event_ids)).order_by(Event.created_at, Event.id)
        )
    ).scalars().all()

    activity_ids: list[uuid.UUID] = []
    for ev in rows:
        recipient_ids = [ev.recipient_id] if ev.recipient_id is not None else []
        recipient_types = [ev.recipient_type] if ev.recipient_type else []
        stmt = (
            pg_insert(ActivityEvent.__table__)
            .values(
                activity_id=uuid.uuid4(),
                org_id=ev.org_id,
                project_id=ev.project_id,
                actor_id=ev.sender_id,
                verb=canonical_verb(ev),
                object_type=ev.source_entity_type,
                object_id=ev.source_entity_id,
                occurred_at=ev.created_at,
                representative_event_id=ev.id,
                source_event_ids=[ev.id],
                recipient_ids=recipient_ids,
                recipient_types=recipient_types,
                payload=_canonical_payload(ev.payload),
                dedup_key=build_dedup_key(ev),
                # activity_seq 생략(Identity·DB 생성)·created_at 생략(default now()).
            )
            .on_conflict_do_update(
                index_elements=["org_id", "dedup_key"],
                set_={
                    "source_event_ids": _array_union_sql("source_event_ids", "uuid[]"),
                    "recipient_ids": _array_union_sql("recipient_ids", "uuid[]"),
                    "recipient_types": _array_union_sql("recipient_types", "text[]"),
                },
            )
            .returning(ActivityEvent.__table__.c.activity_id)
        )
        result = await db.execute(stmt)
        activity_ids.append(result.scalar_one())

    return activity_ids


async def backfill_activity_events(db: AsyncSession, *, batch_size: int = 1000) -> dict[str, int]:
    """L1 BE-4: 기존 events를 (created_at ASC, id ASC) cursor scan하며 activity_events로 흡수.

    별도 idempotent job(테이블은 0116 마이그가 생성). delivered event cleanup 전 과거 row를
    수렴한다. 재실행해도 (org_id, dedup_key) unique + array_agg DISTINCT로 row count·source
    누적이 안정(AC②). 이미 삭제된 event는 scan에 없으므로 복원하지 않는다(AC③). 배치별로
    빠른 일괄 upsert를 시도하고, 실패 시에만 event 단위로 격리해 문제 row를 skip·집계한다.

    반환: {events_processed, events_skipped, batches}. 배치별 처리량·upsert·collapse는 로그.
    """
    processed = 0
    skipped = 0
    batches = 0
    cursor: tuple | None = None  # (created_at, id)

    while True:
        query = (
            select(Event.id, Event.created_at)
            .order_by(Event.created_at.asc(), Event.id.asc())
            .limit(batch_size)
        )
        if cursor is not None:
            query = query.where(tuple_(Event.created_at, Event.id) > tuple_(cursor[0], cursor[1]))

        rows = (await db.execute(query)).all()
        if not rows:
            break

        batch_ids = [row[0] for row in rows]
        batch_skipped = 0
        try:
            activity_ids = await upsert_activity_from_events(db, batch_ids)
            await db.commit()
        except Exception:
            # 배치 일괄이 실패하면 event 단위 savepoint로 격리 — 문제 row만 skip한다.
            await db.rollback()
            activity_ids = []
            for eid in batch_ids:
                try:
                    async with db.begin_nested():
                        activity_ids.extend(await upsert_activity_from_events(db, [eid]))
                except Exception:
                    batch_skipped += 1
                    logger.warning("backfill skip event=%s", eid, exc_info=True)
            await db.commit()

        processed += len(batch_ids)
        skipped += batch_skipped
        batches += 1
        cursor = (rows[-1][1], rows[-1][0])
        logger.info(
            "backfill batch %d: processed=%d upserts=%d collapsed=%d skipped=%d",
            batches,
            len(batch_ids),
            len(batch_ids) - batch_skipped,
            len(set(activity_ids)),
            batch_skipped,
        )

    result = {"events_processed": processed, "events_skipped": skipped, "batches": batches}
    logger.info("backfill complete: %s", result)
    return result
