"""story #f2b66f32(3025, BE·상태 자가회수) — 기존 잔존분 1회 백필(idempotent).

그라운딩(2026-08-24, 실측 `/api/v2/gates?status=pending` 56건 GROUP BY): gate_type=merge
(work_item_type=story) 33건 전건이 target story.status=='done'인데 게이트만 pending으로 영구
잔존했다. 이 job은 그 잔존분을 `gate_self_reclamation.reclaim_stale_merge_gates_for_story()`
(story #f2b66f32 신규, 정확히 같은 로직 — story.status→done 전이 시 forward hook과 동일 함수
재사용, 중복 구현 0)로 회수한다.

⚠️`backfill_void_empty_merge_gates.py`(E-DG-REAL P0, 선례)와 다른 기준 — 그 job은 "실 PR
컨텍스트 없는 shell"(decision_basis 텍스트 매칭)만 대상으로 하고 실 PR 연결 게이트는 명시적으로
skip한다. 이 job은 "target story가 이미 done인가"만 본다 — 그래서 self-report shell(31건)뿐
아니라 실 PR이 있는데도 reconcile 웹훅이 놓친 2건(PR#3350 MERGED·PR#3307 CLOSED, gh 실측)까지
동일하게 잡는다. 두 job은 서로 다른 기준이라 중복 대상이 있어도 안전(재실행 멱등 — 이미
voided면 status가 pending이 아니라 재대상 아님).

env: DATABASE_URL이 있으면 그것을 쓴다. 없으면 ALEMBIC_URL로 폴백(scripts/jobs/_db_env.py).
실행:
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_void_stale_done_merge_gates            # dry-run
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_void_stale_done_merge_gates --apply     # 실제 void
옵션: --org <uuid> 로 특정 org만.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from sqlalchemy import select

from scripts.jobs._db_env import resolve_database_url

_db_url_summary = resolve_database_url()

from app.core.database import async_session_factory  # noqa: E402 — 위 폴백이 먼저 돌아야 한다
from app.models.gate import Gate  # noqa: E402
from app.models.pm import Story  # noqa: E402

MERGE_GATE_TYPE = "merge"


async def main() -> int:
    if _db_url_summary is None:
        print("DATABASE_URL·ALEMBIC_URL 둘 다 미설정", file=sys.stderr)
        return 2
    print(f"[db] {_db_url_summary}", file=sys.stderr)

    parser = argparse.ArgumentParser(
        description="target story가 이미 done인데 pending으로 잔존한 merge gate를 voided로 회수(idempotent)"
    )
    parser.add_argument("--apply", action="store_true", help="실제 회수 커밋 (미지정 시 dry-run)")
    parser.add_argument("--org", type=str, default=None, help="특정 org_id만 (기본 전체)")
    args = parser.parse_args()

    q = (
        select(Gate.org_id, Gate.work_item_id)
        .join(Story, Story.id == Gate.work_item_id)
        .where(
            Gate.gate_type == MERGE_GATE_TYPE,
            Gate.work_item_type == "story",
            Gate.status == "pending",
            Story.status == "done",
        )
        .distinct()
    )
    if args.org:
        q = q.where(Gate.org_id == uuid.UUID(args.org))

    async with async_session_factory() as db:
        pairs = (await db.execute(q)).all()
        print(f"target stories(이미 done인데 pending merge gate 있음): {len(pairs)}")

        if not args.apply:
            for org_id, story_id in pairs[:20]:
                print(f"  [dry-run] org={org_id} story={story_id}")
            if len(pairs) > 20:
                print(f"  … +{len(pairs) - 20} more")
            print("dry-run — no changes. 실제 적용은 --apply.")
            return 0

        from app.services.gate_self_reclamation import reclaim_stale_merge_gates_for_story

        total_reclaimed = 0
        for org_id, story_id in pairs:
            reclaimed = await reclaim_stale_merge_gates_for_story(db, org_id, story_id)
            total_reclaimed += len(reclaimed)
        await db.commit()
        print(f"voided {total_reclaimed} stale merge gates across {len(pairs)} stories.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
