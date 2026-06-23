"""E-DG-REAL P0 (1ff89d23): 누적 빈-껍데기 merge 게이트 void backfill (idempotent).

배경: P0 前에는 모든 story→done이 `evaluate_merge_gate(ci_result=None, pr_number=0)`를 거쳐
무조건 'CI unknown (self-report only)' 게이트 shell을 만들었다(증거 0·사람이 판단 불가). P0 코드가
이를 막지만(evidence-driven materialization), 이미 누적된 shell은 인박스에 남는다. 이 job이 그것을
**void**(audit 보존·인박스서 제거·delete 아님) 처리한다.

대상(보수적·무PR shell만): gate_type='merge' · status='pending' · decision_basis='CI unknown
(self-report only)' · neutral_facts.pr_number 가 없음/0. 실 PR 있는 게이트·approved/auto_passed·
held 등은 건드리지 않는다. 재실행 멱등(이미 voided면 status가 pending이 아니라 재대상 아님).

env: DATABASE_URL (백엔드 동일·cloud-sql-proxy/in-VPC). 쓰기 작업.
실행:
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_void_empty_merge_gates            # dry-run
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_void_empty_merge_gates --apply     # 실제 void
옵션: --org <uuid> 로 특정 org만.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.database import async_session_factory
from app.models.gate import Gate

MERGE_GATE_TYPE = "merge"
_SHELL_BASIS = "CI unknown (self-report only)"
_VOID_NOTE = "no-substance shell · replaced by evidence-driven gating (E-DG-REAL P0 1ff89d23)"


def _is_no_pr(neutral_facts: dict | None) -> bool:
    """실 PR 컨텍스트가 없는 shell인지 — pr_number 없음/0/falsy."""
    if not neutral_facts:
        return True
    return not neutral_facts.get("pr_number")


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL 미설정", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(description="void empty 'CI unknown' merge gate shells (idempotent)")
    parser.add_argument("--apply", action="store_true", help="실제 void 커밋 (미지정 시 dry-run)")
    parser.add_argument("--org", type=str, default=None, help="특정 org_id 만 (기본 전체)")
    args = parser.parse_args()

    q = select(Gate).where(
        Gate.gate_type == MERGE_GATE_TYPE,
        Gate.status == "pending",
        Gate.decision_basis == _SHELL_BASIS,
    )
    if args.org:
        q = q.where(Gate.org_id == uuid.UUID(args.org))

    async with async_session_factory() as db:
        rows = (await db.execute(q)).scalars().all()
        targets = [g for g in rows if _is_no_pr(g.neutral_facts)]
        skipped_has_pr = len(rows) - len(targets)

        print(
            f"matched pending 'CI unknown' merge gates: {len(rows)} "
            f"(no-PR shells: {len(targets)}, has-PR skipped: {skipped_has_pr})"
        )

        if not args.apply:
            for g in targets[:20]:
                print(f"  [dry-run void] gate={g.id} org={g.org_id} story={g.work_item_id}")
            if len(targets) > 20:
                print(f"  … +{len(targets) - 20} more")
            print("dry-run — no changes. 실제 적용은 --apply.")
            return 0

        now = datetime.now(timezone.utc)
        for g in targets:
            g.status = "voided"
            g.resolved_at = now
            g.resolution_note = _VOID_NOTE
        await db.commit()
        print(f"voided {len(targets)} no-substance shell gates.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
