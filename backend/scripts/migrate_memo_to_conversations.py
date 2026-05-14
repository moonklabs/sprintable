#!/usr/bin/env python3
"""
S41: memo_replies(chat) → conversation_messages 마이그레이션.

conversation.id = memo.id 1:1 매핑으로 thread_id 호환성 유지.
MCP 도구의 thread_id(=memo_id)가 conversation_id로 그대로 동작함.

실행:
  cd backend
  python scripts/migrate_memo_to_conversations.py [--dry-run]
"""
import argparse
import asyncio
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

sys.path.insert(0, ".")
from app.core.database import async_session_factory  # noqa: E402
from app.models.memo import Memo, MemoAssignee, MemoReply  # noqa: E402
from app.models.conversation import Conversation, ConversationParticipant, ConversationMessage  # noqa: E402


async def migrate(dry_run: bool = False) -> None:
    print(f"[migrate] {'DRY RUN — ' if dry_run else ''}memo → conversations 마이그레이션 시작인")

    async with async_session_factory() as db:
        # 이미 마이그레이션된 conversation.id 조회
        existing_ids = set(
            r[0] for r in (await db.execute(select(Conversation.id))).all()
        )
        print(f"[migrate] 기존 conversations: {len(existing_ids)}건")

        # chat 스레드가 있는 memo 조회 (reply가 1건 이상)
        memos_result = await db.execute(
            select(Memo)
            .where(Memo.deleted_at.is_(None))
            .order_by(Memo.created_at.asc())
        )
        memos = memos_result.scalars().all()
        print(f"[migrate] 대상 memo: {len(memos)}건")

        created_conv = 0
        created_msg = 0

        for memo in memos:
            if memo.id in existing_ids:
                print(f"  [skip] memo {memo.id} — 이미 conversation 존재")
                continue

            # assignees 조회 (MemoAssignee 테이블)
            assignee_rows = (await db.execute(
                select(MemoAssignee.member_id).where(MemoAssignee.memo_id == memo.id)
            )).all()
            participant_ids: set[uuid.UUID] = {r[0] for r in assignee_rows}
            if memo.assigned_to:
                participant_ids.add(memo.assigned_to)
            if memo.created_by:
                participant_ids.add(memo.created_by)

            # memo_replies 조회 (chat 메시지)
            replies = (await db.execute(
                select(MemoReply)
                .where(MemoReply.memo_id == memo.id)
                .order_by(MemoReply.created_at.asc())
            )).scalars().all()

            if not replies and not participant_ids:
                continue  # 빈 memo는 스킵

            print(f"  [conv] memo {memo.id} → conversation (replies={len(replies)}, participants={len(participant_ids)})")

            if not dry_run:
                # conversation 생성 (memo.id 재사용 → thread_id 호환)
                conv = Conversation(
                    id=memo.id,
                    project_id=memo.project_id,
                    org_id=memo.org_id,
                    type="group",
                    title=memo.title,
                    created_by=memo.created_by,
                )
                # created_at/updated_at 수동 설정
                conv.created_at = memo.created_at
                conv.updated_at = memo.updated_at or memo.created_at
                db.add(conv)

                # participants
                for pid in participant_ids:
                    db.add(ConversationParticipant(
                        conversation_id=memo.id,
                        member_id=pid,
                    ))

                # conversation_messages
                for reply in replies:
                    msg = ConversationMessage(
                        conversation_id=memo.id,
                        sender_id=reply.created_by,
                        content=reply.content,
                        mentioned_ids=[],
                    )
                    msg.created_at = reply.created_at
                    msg.updated_at = reply.created_at
                    db.add(msg)
                    created_msg += 1

                created_conv += 1

        if not dry_run:
            await db.commit()

        print(f"[migrate] 완료인 — conversations: {created_conv}건, messages: {created_msg}건")
        if dry_run:
            print("[migrate] DRY RUN — 실제 DB 변경 없음인")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="memo → conversations 마이그레이션")
    parser.add_argument("--dry-run", action="store_true", help="DB 변경 없이 결과만 출력")
    args = parser.parse_args()
    asyncio.run(migrate(dry_run=args.dry_run))
