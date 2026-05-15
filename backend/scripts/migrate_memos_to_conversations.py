#!/usr/bin/env python3
"""S-B1: Memo 데이터 → Conversation 마이그레이션 스크립트.

변환 규칙:
  memo → conversation(id=memo.id) + root ConversationMessage(memo.content)
  memo_reply → thread ConversationMessage(thread_id=root_msg.id)
  status/resolved_by/resolved_at/created_at 보존
  원본 memo/reply row 삭제하지 않음

실행:
  cd backend
  python scripts/migrate_memos_to_conversations.py --dry-run          # DB 변경 없이 카운트
  python scripts/migrate_memos_to_conversations.py --yes               # 실제 실행
  python scripts/migrate_memos_to_conversations.py --rollback --yes    # 롤백
  python scripts/migrate_memos_to_conversations.py --dry-run --output summary.json
"""
import argparse
import asyncio
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, select, update

sys.path.insert(0, ".")
from app.core.database import async_session_factory  # noqa: E402
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant  # noqa: E402
from app.models.memo import Memo, MemoAssignee, MemoReply  # noqa: E402


# ─── 마이그레이션 ──────────────────────────────────────────────────────────────

async def migrate(dry_run: bool = False, yes: bool = False, output: str | None = None) -> dict:
    print(f"[migrate] {'DRY RUN — ' if dry_run else ''}memo → conversations 마이그레이션 시작")

    summary: dict = {
        "mode": "dry_run" if dry_run else "execute",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "skipped": [],
        "migrated": [],
        "errors": [],
    }

    async with async_session_factory() as db:
        # 멱등성 체크: 이미 이관된 conversation.id 조회 (conversation.id = memo.id 방식)
        existing_conv_ids = set(
            r[0] for r in (await db.execute(select(Conversation.id))).all()
        )
        print(f"[migrate] 기존 conversations: {len(existing_conv_ids)}건")

        memos = (await db.execute(
            select(Memo)
            .where(Memo.deleted_at.is_(None))
            .order_by(Memo.created_at.asc())
        )).scalars().all()
        print(f"[migrate] 대상 memo: {len(memos)}건")

        to_migrate = [m for m in memos if m.id not in existing_conv_ids]
        to_skip = [m for m in memos if m.id in existing_conv_ids]

        print(f"[migrate] 이관 대상: {len(to_migrate)}건 / 스킵(기존 이관): {len(to_skip)}건")
        summary["skipped"] = [str(m.id) for m in to_skip]

        if dry_run:
            total_replies = 0
            for memo in to_migrate:
                replies = (await db.execute(
                    select(MemoReply).where(MemoReply.memo_id == memo.id)
                )).scalars().all()
                total_replies += len(replies)
                summary["migrated"].append({"memo_id": str(memo.id), "reply_count": len(replies)})

            print(f"[migrate] DRY RUN 결과: conversation {len(to_migrate)}건 + root_message {len(to_migrate)}건 + reply {total_replies}건 생성 예정")
            print("[migrate] DRY RUN — DB 변경 없음")
            _write_summary(summary, output)
            return summary

        if not yes:
            print(f"\n⚠️  경고: {len(to_migrate)}개 conversation + root message + replies를 생성합니다.")
            print("    계속하려면 --yes 플래그를 추가하세요.")
            sys.exit(1)

        for memo in to_migrate:
            try:
                await _migrate_one(db, memo)
                summary["migrated"].append({"memo_id": str(memo.id)})
            except Exception as exc:
                print(f"  [error] memo {memo.id}: {exc}")
                summary["errors"].append({"memo_id": str(memo.id), "error": str(exc)})
                await db.rollback()

        await db.commit()
        print(f"[migrate] 완료 — conversation {len(summary['migrated'])}건, 오류 {len(summary['errors'])}건")

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    _write_summary(summary, output)
    return summary


async def _migrate_one(db, memo: Memo) -> None:
    """단일 memo → conversation + root message + thread replies 변환."""
    # 참여자 수집
    assignee_ids = {
        r[0] for r in (await db.execute(
            select(MemoAssignee.member_id).where(MemoAssignee.memo_id == memo.id)
        )).all()
    }
    participant_ids: set[uuid.UUID] = assignee_ids
    if memo.assigned_to:
        participant_ids.add(memo.assigned_to)
    if memo.created_by:
        participant_ids.add(memo.created_by)

    replies = (await db.execute(
        select(MemoReply)
        .where(MemoReply.memo_id == memo.id)
        .order_by(MemoReply.created_at.asc())
    )).scalars().all()

    print(f"  [conv] memo {memo.id} ({memo.title or '제목없음'}) → conversation "
          f"(participants={len(participant_ids)}, replies={len(replies)})")

    # AC3: conversation 생성 (memo.id 재사용 → rollback 식별 가능)
    conv = Conversation(
        id=memo.id,
        project_id=memo.project_id,
        org_id=memo.org_id,
        type="group",
        title=memo.title,
        created_by=memo.created_by,
        status=memo.status or "open",
        resolved_by=memo.resolved_by,
        resolved_at=memo.resolved_at,
    )
    conv.created_at = memo.created_at
    conv.updated_at = memo.updated_at or memo.created_at
    db.add(conv)

    # participants
    for pid in participant_ids:
        db.add(ConversationParticipant(
            conversation_id=memo.id,
            member_id=pid,
        ))

    # AC3: root ConversationMessage (memo.content)
    await db.flush()
    root_msg = ConversationMessage(
        conversation_id=memo.id,
        sender_id=memo.created_by,
        content=memo.content or "",
        mentioned_ids=[],
        thread_id=None,
        reply_count=len(replies),
    )
    root_msg.created_at = memo.created_at
    root_msg.updated_at = memo.created_at
    if replies:
        root_msg.last_reply_at = replies[-1].created_at
    db.add(root_msg)
    await db.flush()

    # AC4: memo_reply → thread reply (thread_id = root_msg.id)
    for reply in replies:
        content = reply.content or ""
        if reply.attachments:
            content = f"{content}\n[attachments:{json.dumps(reply.attachments)}]"
        reply_msg = ConversationMessage(
            conversation_id=memo.id,
            sender_id=reply.created_by,
            content=content,
            mentioned_ids=[],
            thread_id=root_msg.id,
        )
        reply_msg.created_at = reply.created_at
        reply_msg.updated_at = reply.created_at
        db.add(reply_msg)


# ─── 롤백 ────────────────────────────────────────────────────────────────────

async def rollback(dry_run: bool = False, yes: bool = False, output: str | None = None) -> dict:
    """memo-origin conversation(conversation.id ∈ memo.id) 삭제. memo 원본 보존."""
    print(f"[rollback] {'DRY RUN — ' if dry_run else ''}롤백 시작")

    summary: dict = {
        "mode": "rollback_dry_run" if dry_run else "rollback_execute",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "target_ids": [],
    }

    async with async_session_factory() as db:
        memo_ids = [r[0] for r in (await db.execute(select(Memo.id))).all()]
        target_ids = [
            r[0] for r in (await db.execute(
                select(Conversation.id).where(Conversation.id.in_(memo_ids))
            )).all()
        ]
        print(f"[rollback] 삭제 대상 (memo-origin): {len(target_ids)}건")
        summary["target_ids"] = [str(i) for i in target_ids]

        if dry_run:
            print("[rollback] DRY RUN — DB 변경 없음")
            _write_summary(summary, output)
            return summary

        if not yes:
            print(f"\n⚠️  경고: {len(target_ids)}개 conversation을 삭제합니다. memo 원본은 보존됩니다.")
            print("    계속하려면 --yes 플래그를 추가하세요.")
            sys.exit(1)

        if not target_ids:
            print("[rollback] 삭제 대상 없음")
            _write_summary(summary, output)
            return summary

        result = await db.execute(
            delete(Conversation).where(Conversation.id.in_(target_ids))
        )
        await db.commit()
        print(f"[rollback] {result.rowcount}건 삭제 완료. memo 원본 보존됨.")

    summary["deleted_count"] = result.rowcount
    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    _write_summary(summary, output)
    return summary


# ─── 유틸 ────────────────────────────────────────────────────────────────────

def _write_summary(summary: dict, output: str | None) -> None:
    if output:
        Path(output).write_text(json.dumps(summary, indent=2, ensure_ascii=False))
        print(f"[summary] JSON 저장: {output}")
    else:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        fname = f"migration_summary_{ts}.json"
        Path(fname).write_text(json.dumps(summary, indent=2, ensure_ascii=False))
        print(f"[summary] JSON 저장: {fname}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="memo → conversations 마이그레이션 (S-B1)")
    parser.add_argument("--dry-run", action="store_true", help="DB 변경 없이 카운트만 출력")
    parser.add_argument("--yes", action="store_true", help="확인 없이 즉시 실행")
    parser.add_argument("--rollback", action="store_true", help="마이그레이션 롤백 (memo-origin conversation 삭제)")
    parser.add_argument("--output", type=str, default=None, help="JSON summary 저장 경로")
    args = parser.parse_args()

    if args.rollback:
        asyncio.run(rollback(dry_run=args.dry_run, yes=args.yes, output=args.output))
    else:
        asyncio.run(migrate(dry_run=args.dry_run, yes=args.yes, output=args.output))
