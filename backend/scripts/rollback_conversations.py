#!/usr/bin/env python3
"""
S41: conversations 롤백 — memo 원본 보존, conversations만 삭제.

실행:
  cd backend
  python scripts/rollback_conversations.py [--dry-run]
"""
import argparse
import asyncio
import sys

from sqlalchemy import delete

sys.path.insert(0, ".")
from app.core.database import async_session_factory  # noqa: E402
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant  # noqa: E402


async def rollback(dry_run: bool = False) -> None:
    print(f"[rollback] {'DRY RUN — ' if dry_run else ''}conversations 롤백 시작인")

    async with async_session_factory() as db:
        # CASCADE로 participants + messages도 자동 삭제됨
        if not dry_run:
            result = await db.execute(delete(Conversation))
            deleted = result.rowcount
            await db.commit()
            print(f"[rollback] conversations {deleted}건 삭제 완료인")
            print("[rollback] memo 원본 데이터 보존됨인")
        else:
            from sqlalchemy import select, func
            count = (await db.execute(select(func.count()).select_from(Conversation))).scalar_one()
            print(f"[rollback] DRY RUN — 삭제 예정 conversations: {count}건")
            print("[rollback] DRY RUN — 실제 DB 변경 없음인")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="conversations 롤백 (memo 보존)")
    parser.add_argument("--dry-run", action="store_true", help="DB 변경 없이 결과만 출력")
    args = parser.parse_args()
    asyncio.run(rollback(dry_run=args.dry_run))
