"""story #2223(E-CONNECT) — reference_semantic_candidates 배치 백필.

#2328이 "새 참조만"(소급 안 함)로 설계했으나, create_story가 그 write-path
(_reconcile_story_references_and_candidates)를 한 번도 안 불렀던 버그(오르테가군,
2026-07-30 아침 수정) 때문에 이 표가 선 뒤(2026-07-29)로도 실제로 쌓인 행이 거의 없었다
(실측: 104/1349 ≈ 7.7%) — "소급"이 사실상 "첫 채우기"다.

기존 story description/acceptance_criteria 전량을 `generate_and_store_candidates()`(story
저장 시점 write-path와 완전히 같은 함수)에 다시 흘려보낸다 — 새 로직을 만들지 않는다.
멱등 — `store_semantic_candidates`의 ON CONFLICT DO NOTHING(자연키 유니크)이 재실행을
안전하게 만든다. 이미 declared된 후보는 caller가 그 키로 다시 insert를 시도해도 conflict라
그대로 보존된다(사람의 승격 결정이 재계산으로 지워지지 않는다는 #2328의 불변식 그대로).

env: DATABASE_URL (백엔드 동일, cloud-sql-proxy/in-VPC 경유). 쓰기 작업.
실행: cd backend && DATABASE_URL=... python -m scripts.backfill_reference_semantic_candidates
      [--batch-size N] [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import uuid
from collections import Counter

from sqlalchemy import select

from app.core.database import async_session_factory
from app.models.pm import Story
from app.services.reference_semantic_candidates import generate_and_store_candidates

logger = logging.getLogger("backfill_reference_semantic_candidates")


async def _run(batch_size: int, dry_run: bool) -> dict:
    stories_scanned = 0
    stories_with_content = 0
    candidates_inserted = 0
    errors: list[tuple[str, str]] = []
    last_created_at = None
    last_id: uuid.UUID | None = None

    async with async_session_factory() as db:
        while True:
            query = select(Story).order_by(Story.created_at.asc(), Story.id.asc()).limit(batch_size)
            if last_created_at is not None:
                query = query.where(
                    (Story.created_at > last_created_at)
                    | ((Story.created_at == last_created_at) & (Story.id > last_id))
                )
            rows = (await db.execute(query)).scalars().all()
            if not rows:
                break

            for story in rows:
                stories_scanned += 1
                last_created_at, last_id = story.created_at, story.id
                has_content = bool(story.description) or bool(story.acceptance_criteria)
                if not has_content:
                    continue
                stories_with_content += 1
                if dry_run:
                    continue
                try:
                    for field, content in (
                        ("description", story.description),
                        ("acceptance_criteria", story.acceptance_criteria),
                    ):
                        if not content:
                            continue
                        n = await generate_and_store_candidates(
                            db, org_id=story.org_id, project_id=story.project_id,
                            source_type="story", source_field=field, source_id=story.id,
                            content=content,
                        )
                        candidates_inserted += n
                    await db.commit()
                except Exception as exc:  # noqa: BLE001 — 한 스토리 실패가 배치 전체를 안 죽인다
                    await db.rollback()
                    errors.append((str(story.id), repr(exc)))
                    logger.warning("story %s backfill 실패: %r", story.id, exc)

            if len(rows) < batch_size:
                break

        # 분포 리포트 — 오르테가군 요청(종별 분포 + 미분류 수)
        from app.models.reference_semantic_candidate import ReferenceSemanticCandidate

        all_rows = (await db.execute(
            select(ReferenceSemanticCandidate.relation_kind)
        )).scalars().all()
        kind_dist = Counter(k if k is not None else "(미분류)" for k in all_rows)

    return {
        "stories_scanned": stories_scanned,
        "stories_with_content": stories_with_content,
        "candidates_inserted": candidates_inserted,
        "errors": errors,
        "total_candidate_rows": sum(kind_dist.values()),
        "kind_distribution": dict(kind_dist),
    }


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL 미설정", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(description="reference_semantic_candidates 배치 백필 (idempotent)")
    parser.add_argument("--batch-size", type=int, default=200, help="배치당 story 수 (기본 200)")
    parser.add_argument("--dry-run", action="store_true", help="쓰기 없이 대상 건수만 센다")
    args = parser.parse_args()

    result = await _run(batch_size=args.batch_size, dry_run=args.dry_run)

    print(
        f"backfill done: stories_scanned={result['stories_scanned']} "
        f"stories_with_content={result['stories_with_content']} "
        f"candidates_inserted={result['candidates_inserted']} "
        f"errors={len(result['errors'])}"
    )
    print(f"total_candidate_rows(now)={result['total_candidate_rows']}")
    print(f"kind_distribution={result['kind_distribution']}")
    if result["errors"]:
        for sid, err in result["errors"][:20]:
            print(f"  ERROR story={sid}: {err}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    raise SystemExit(asyncio.run(main()))
