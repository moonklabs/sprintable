"""179db213: DM 1-pair=1-DM enforce — dm_pair_key + partial unique index + preflight dedup.

create_conversation 이 동일 2-member pair 에 중복 DM 을 만들 수 있던 것을 막는다.
- conversations.dm_pair_key (정렬된 member-pair `min|max`) 추가 + type='dm' 백필.
- preflight dedup: 같은 (org,project,dm_pair_key) 다중 DM → keeper(최古 created_at) 1개로 머지
  (잉여 DM 의 conversation_messages 를 keeper 로 repoint **先**, 잉여 conv DELETE **後** — 메시지
  무손실. participants 는 keeper 가 동일 pair 보유·잉여는 conv DELETE 시 CASCADE).
- partial unique index uq_conversations_dm_pair (type='dm') → 동시생성 레이스 단일 DM 보장
  (핸들러가 IntegrityError catch → 기존 DM 반환).

멱등: ADD COLUMN/INDEX IF NOT EXISTS·dedup 재실행 시 단일 그룹이면 no-op.
롤백: index/column drop. 데이터 머지 비가역(0081/0099 동일 정책).

Revision ID: 0100
Revises: 0099
Create Date: 2026-06-06
"""
from __future__ import annotations

from alembic import op

revision = "0100"
down_revision = "0099"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. dm_pair_key 컬럼 (additive nullable)
    op.execute("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS dm_pair_key text")

    # 2. type='dm' 백필 — 정렬된 member-pair
    op.execute(
        """
        UPDATE conversations c SET dm_pair_key = sub.pk
        FROM (
            SELECT cp.conversation_id AS cid,
                   string_agg(cp.member_id::text, '|' ORDER BY cp.member_id) AS pk
            FROM conversation_participants cp
            GROUP BY cp.conversation_id
        ) sub
        WHERE c.id = sub.cid AND c.type = 'dm'
        """
    )

    # 3. preflight dedup (CP3) — 머지 그룹 로그
    op.execute(
        """
        DO $$
        DECLARE r record;
        BEGIN
            FOR r IN
                SELECT org_id, project_id, dm_pair_key, count(*) AS c
                FROM conversations
                WHERE type='dm' AND dm_pair_key IS NOT NULL
                GROUP BY org_id, project_id, dm_pair_key HAVING count(*) > 1
            LOOP
                RAISE NOTICE '179db213 DM dedup MERGE: org=% project=% pair=% dms=%',
                    r.org_id, r.project_id, r.dm_pair_key, r.c;
            END LOOP;
        END $$
        """
    )
    # 3a. 잉여 DM 의 메시지를 keeper(최古) 로 repoint (DELETE 先행 금지 — CASCADE 소실 방지·CP3)
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER w AS rn,
                   first_value(id) OVER w AS keeper
            FROM conversations
            WHERE type='dm' AND dm_pair_key IS NOT NULL
            WINDOW w AS (PARTITION BY org_id, project_id, dm_pair_key ORDER BY created_at ASC, id ASC)
        )
        UPDATE conversation_messages m SET conversation_id = r.keeper
        FROM ranked r WHERE m.conversation_id = r.id AND r.rn > 1
        """
    )
    # 3b. 잉여 DM DELETE (participants 는 FK CASCADE — keeper 가 동일 pair 보유)
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER (PARTITION BY org_id, project_id, dm_pair_key
                                      ORDER BY created_at ASC, id ASC) AS rn
            FROM conversations
            WHERE type='dm' AND dm_pair_key IS NOT NULL
        )
        DELETE FROM conversations c USING ranked r WHERE c.id = r.id AND r.rn > 1
        """
    )

    # 4. partial unique index (CP1/CP2 — type='dm' 1-pair=1-DM·레이스 가드)
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_dm_pair "
        "ON conversations (org_id, project_id, dm_pair_key) "
        "WHERE type = 'dm' AND dm_pair_key IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_conversations_dm_pair")
    op.execute("ALTER TABLE conversations DROP COLUMN IF EXISTS dm_pair_key")
    # 데이터 머지(중복 DM → 1)는 비가역(0081/0099 동일 정책).
