#!/usr/bin/env python3
"""
S41: conversations 롤백 — memo-origin conversation만 삭제, memo 원본 보존.

롤백 대상: Memo 테이블에 동일한 id가 있는 conversation (memo.id=conversation.id 1:1 매핑)
         → S37/S38에서 생성된 native DM/그룹은 보존됨.

실행:
  cd backend
  python scripts/rollback_conversations.py --dry-run   # 삭제 대상 확인 (안전)
  python scripts/rollback_conversations.py --yes        # 실제 삭제
"""
import argparse
import asyncio
import sys

from sqlalchemy import delete, select

sys.path.insert(0, ".")
from app.core.database import async_session_factory  # noqa: E402
from app.models.conversation import Conversation  # noqa: E402
from app.models.memo import Memo  # noqa: E402


async def rollback(dry_run: bool = False, yes: bool = False) -> None:
    async with async_session_factory() as db:
        # memo-origin conversation: Memo.id와 동일한 conversation.id만 대상
        memo_ids = [r[0] for r in (await db.execute(select(Memo.id))).all()]
        target_ids = [r[0] for r in (await db.execute(
            select(Conversation.id).where(Conversation.id.in_(memo_ids))
        )).all()]

        native_count = (await db.execute(
            select(Conversation.id).where(Conversation.id.notin_(memo_ids))
        )).rowcount

        print(f"[rollback] memo-origin conversation (삭제 대상): {len(target_ids)}건")
        print(f"[rollback] native conversation (보존): {native_count}건")

        if dry_run:
            print("[rollback] DRY RUN — 실제 DB 변경 없음인")
            return

        if not yes:
            print(f"\n⚠️  경고: memo-origin conversation {len(target_ids)}건을 삭제합니다.")
            print("    계속하려면 --yes 플래그를 추가하세요.")
            sys.exit(1)

        if not target_ids:
            print("[rollback] 삭제 대상 없음인")
            return

        result = await db.execute(
            delete(Conversation).where(Conversation.id.in_(target_ids))
        )
        await db.commit()
        print(f"[rollback] {result.rowcount}건 삭제 완료인. memo 원본 보존됨인")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="memo-origin conversations 롤백 (memo 보존)")
    parser.add_argument("--dry-run", action="store_true", help="삭제 대상만 출력, DB 변경 없음")
    parser.add_argument("--yes", action="store_true", help="확인 없이 즉시 실행")
    args = parser.parse_args()
    asyncio.run(rollback(dry_run=args.dry_run, yes=args.yes))
