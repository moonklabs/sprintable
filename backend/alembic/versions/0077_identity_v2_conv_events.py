"""E-MEMBER-SSOT AC3-2 Batch 1: conversations/events 식별 컬럼 v2 (canonical members.id 이행).

blueprint §4 Phase4. legacy 식별자(휴먼 team_member.id)를 canonical members.id로 옮기는 *_v2 컬럼 +
별칭(member_identity_aliases) 백필. 읽기 COALESCE(col_v2, alias_resolve(col))는 후속 배치(read-cut).

대상(Phase0서 FK 이미 완화된 conv/events 선행):
- conversations.created_by_v2 / resolved_by_v2
- conversation_participants.member_id_v2
- conversation_messages.sender_id_v2 / mentioned_ids_v2(배열)
- events.sender_id_v2 / recipient_id_v2

백필 = COALESCE(alias.member_id, legacy): 에이전트/org-member id는 이미 canonical(legacy 보존),
레거시 휴먼 team_member.id만 alias로 canonical member.id 치환. orphan-safe(alias 없으면 legacy 유지).
⚠️ *_v2 FK는 보류(트랩#7): write 경로가 아직 _v2를 안 쓰므로 신규행 _v2 NULL — FK 신규검증 회피.
cutover 후 추가. 추가형(legacy 컬럼 미삭제)·가역.

Revision ID: 0077
Revises: 0076
Create Date: 2026-06-03
"""
from __future__ import annotations

from alembic import op

revision = "0077"
down_revision = "0076"
branch_labels = None
depends_on = None

# (table, scalar column) — _v2 컬럼 + COALESCE(alias) 백필
_SCALAR: list[tuple[str, str]] = [
    ("conversations", "created_by"),
    ("conversations", "resolved_by"),
    ("conversation_participants", "member_id"),
    ("conversation_messages", "sender_id"),
    ("events", "sender_id"),
    ("events", "recipient_id"),
]


def upgrade() -> None:
    for table, col in _SCALAR:
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col}_v2 uuid")
        # 백필: 레거시 휴먼 team_member.id는 alias로 canonical화, 그 외(agent/org-member)는 legacy 보존(orphan-safe)
        op.execute(
            f"""
            UPDATE {table} SET {col}_v2 = COALESCE(
                (SELECT a.member_id FROM member_identity_aliases a WHERE a.alias_id = {table}.{col}),
                {table}.{col}
            )
            WHERE {col} IS NOT NULL AND {col}_v2 IS NULL
            """
        )

    # mentioned_ids(배열): 원소별 alias 치환
    op.execute("ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS mentioned_ids_v2 uuid[]")
    op.execute(
        """
        UPDATE conversation_messages SET mentioned_ids_v2 = (
            SELECT array_agg(COALESCE(a.member_id, e) ORDER BY ord)
            FROM unnest(mentioned_ids) WITH ORDINALITY AS t(e, ord)
            LEFT JOIN member_identity_aliases a ON a.alias_id = t.e
        )
        WHERE mentioned_ids IS NOT NULL
          AND array_length(mentioned_ids, 1) > 0
          AND mentioned_ids_v2 IS NULL
        """
    )

    # hot lookup: events.recipient_id_v2 (SSE 백필/poll)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_events_recipient_id_v2 ON events (recipient_id_v2)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_conv_participants_member_id_v2 ON conversation_participants (member_id_v2)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_events_recipient_id_v2")
    op.execute("DROP INDEX IF EXISTS ix_conv_participants_member_id_v2")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS mentioned_ids_v2")
    for table, col in _SCALAR:
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {col}_v2")
