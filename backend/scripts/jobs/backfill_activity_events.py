"""L1 BE-4: 기존 events → activity_events backfill job (idempotent).

events를 (created_at ASC, id ASC)로 cursor scan하며 BE-2 extractor(upsert_activity_from_events)
로 activity_events에 흡수한다. 0116 마이그는 테이블만 만들고 데이터는 이 job이 채운다. 재실행
멱등 — (org_id, dedup_key) unique + array_agg DISTINCT라 row count·source 누적이 안정.

env: DATABASE_URL이 있으면 그것을 쓴다(백엔드 동일, cloud-sql-proxy/in-VPC 경유). 없으면
ALEMBIC_URL로 떨어진다(scripts/jobs/_db_env.py — Cloud Run Job `sprintable-verify-oneoff`가
DATABASE_URL이 아니라 ALEMBIC_URL만 갖고 있다). 쓰기 작업.
실행: cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_activity_events [--batch-size N]

story #2384: scripts/jobs/ 로 이동(기존 scripts/ 루트는 Dockerfile이 명시적으로 배포 이미지에서
빼는 자리라 — deploy/setup/provision .sh·RUNBOOK 등 비-런타임 전용, recon-surface 최소화 의도.
운영 DB에 실제로 접속하는 스크립트는 여기(scripts/jobs/)에 둬야 sprintable-verify-oneoff 같은
Cloud Run 잡에서 실행 가능하다 — 자세한 경위는 scripts/jobs/README.md 참고.

2026-08-01, 카디르군 REQUEST_CHANGES 후속: 옮기기만 하고 README가 문서화한 ALEMBIC_URL 폴백을
안 붙였던 것을 놓쳤다(옆의 backfill_reference_semantic_candidates.py가 이미 하던 패턴). _db_env.py의
공용 헬퍼로 붙인다.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from scripts.jobs._db_env import resolve_database_url

logger = logging.getLogger("backfill_activity_events")

_db_url_summary = resolve_database_url()

from app.core.database import async_session_factory  # noqa: E402 — 위 폴백이 먼저 돌아야 한다
from app.services.activity_stream import backfill_activity_events  # noqa: E402


async def main() -> int:
    if _db_url_summary is None:
        print("DATABASE_URL·ALEMBIC_URL 둘 다 미설정", file=sys.stderr)
        return 2
    logger.info("DB 연결: %s", _db_url_summary)

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
