"""story #4141([E-RECIPE-1] Phase3, 페드루 PO 確定 2026-09-22) AC4 — evidence/artifact
entity_references 백필(멱등·dry-run 기본). 배경은 app/services/evidence_artifact_
reference_backfill.py 모듈 docstring 참조 — write-path(routers/evidence.py·
routers/visual_artifacts.py) 신설 前에 생성된 기존 행은 backlinks에서 0건으로 보인다.

env: DATABASE_URL이 있으면 그것을 쓴다. 없으면 ALEMBIC_URL로 떨어진다(scripts/jobs/
_db_env.py — sprintable-verify-oneoff Cloud Run Job 관례, backfill_doc_base64_assets.py
와 동형).

실행:
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_evidence_artifact_references            # dry-run
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_evidence_artifact_references --apply     # 실제 반영
옵션: --org <uuid> 특정 org만(기본 전체).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from scripts.jobs._db_env import resolve_database_url

_db_url_summary = resolve_database_url()

from app.core.database import async_session_factory  # noqa: E402 — 위 폴백이 먼저 돌아야 한다
from app.services.evidence_artifact_reference_backfill import (  # noqa: E402
    backfill_artifact_references,
    backfill_evidence_references,
)


async def main() -> int:
    if _db_url_summary is None:
        print("DATABASE_URL·ALEMBIC_URL 둘 다 미설정", file=sys.stderr)
        return 2
    print(f"[db] {_db_url_summary}", file=sys.stderr)

    parser = argparse.ArgumentParser(
        description="evidence/artifact entity_references 백필(멱등·dry-run 기본)"
    )
    parser.add_argument("--apply", action="store_true", help="실제 반영(미지정 시 dry-run)")
    parser.add_argument("--org", type=str, default=None, help="특정 org_id만(기본 전체)")
    args = parser.parse_args()

    org_id = uuid.UUID(args.org) if args.org else None
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] evidence/artifact reference 백필 시작 org={args.org or 'ALL'}", file=sys.stderr)

    async with async_session_factory() as session:
        ev_totals = await backfill_evidence_references(session, apply=args.apply, org_id=org_id)
        art_totals = await backfill_artifact_references(session, apply=args.apply, org_id=org_id)

    print(
        f"[{mode}] evidence — scanned={ev_totals.evidence_scanned} "
        f"with_refs_extracted={ev_totals.evidence_with_refs_extracted} errors={len(ev_totals.errors)}"
    )
    for err in ev_totals.errors:
        print(f"  [evidence error] {err}", file=sys.stderr)
    print(
        f"[{mode}] artifact — scanned={art_totals.artifact_scanned} "
        f"with_refs_extracted={art_totals.artifact_with_refs_extracted} errors={len(art_totals.errors)}"
    )
    for err in art_totals.errors:
        print(f"  [artifact error] {err}", file=sys.stderr)
    if not args.apply:
        print("(dry-run — 쓰기 없음. --apply로 실제 반영)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
