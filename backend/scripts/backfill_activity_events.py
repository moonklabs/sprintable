"""L1 BE-4: 기존 events → activity_events backfill job (idempotent).

events를 (created_at ASC, id ASC)로 cursor scan하며 BE-2 extractor(upsert_activity_from_events)
로 activity_events에 흡수한다. 0116 마이그는 테이블만 만들고 데이터는 이 job이 채운다. 재실행
멱등 — (org_id, dedup_key) unique + array_agg DISTINCT라 row count·source 누적이 안정.

env: DATABASE_URL (백엔드 동일, cloud-sql-proxy/in-VPC 경유). 쓰기 작업.
실행: cd backend && DATABASE_URL=... python -m scripts.backfill_activity_events [--batch-size N]
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from app.core.database import async_session_factory
from app.services.activity_stream import backfill_activity_events

logger = logging.getLogger("backfill_activity_events")


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL 미설정", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(description="events → activity_events backfill (idempotent)")
    parser.add_argument("--batch-size", type=int, default=1000, help="배치당 scan할 event 수 (기본 1000)")
    args = parser.parse_args()

    async with async_session_factory() as db:
        result = await backfill_activity_events(db, batch_size=args.batch_size)

    print(
        f"backfill done: events_processed={result['events_processed']} "
        f"events_skipped={result['events_skipped']} batches={result['batches']}"
    )
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    raise SystemExit(asyncio.run(main()))
