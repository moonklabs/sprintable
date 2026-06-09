"""E-MEMBER-SSOT AC3-6: conversation/events legacy 식별 컬럼 FK 완화 + canonicalize (ghost id 해소).

0077이 conv/events를 _v2 컬럼으로만 백필(read-cut 미착수)하고 **legacy 컬럼은 team_members FK 유지·
canonicalize 미실행**. (A) resolver-cutover 채택 후 0085/0086이 retro/pm/webhook/reward/docs/notif만
canonicalize → **conv/events 누락**. 0090서 _v2 vestigial DROP → conv/events legacy 컬럼에 ghost(레거시
team_member) id 잔존.

증상: flag-ON resolver가 canonical 해소하나 conv 행은 ghost-keyed → ghost-keyed 대화 유실(선생님 80챗).
prod(flag-OFF)는 legacy 해소라 아직 보이나 **flag flip 시 동일 회귀 → flip 전 수정 필수**.

본 마이그(0078/0079 FK 완화 + 0085/0086 canonicalize 동형):
1. team_members FK 완화(6 컬럼) — 0088 rename로 FK가 team_members_legacy 가리킴. canonical(org_member.id)은
   legacy 테이블에 부재라 FK 유지 시 canonicalize UPDATE가 위반 → 완화 선행(inspector 멱등).
2. conversation_participants dedup — (conversation_id, member_id) 유니크. canonical+ghost 동시참가 OR
   다중 ghost→동일 canonical 시 유니크 위반 → ROW_NUMBER로 (conversation_id, 해소된 canonical)별 1행만 유지
   (AC3-3 standup preflight 동형).
3. canonicalize(orphan-safe): col = alias.member_id WHERE alias_id = col (alias 없는 agent 불변).
4. mentioned_ids 배열 원소별 canonicalize(0077 _v2 배열 패턴 동형).

⚠️ 가역: canonicalize(데이터 remap)+FK 완화는 forward-only(0085/0086 동형). down은 no-op(team_members가
0088서 뷰라 FK 재추가 불가 + ghost 매핑 비가역). 추가형·멱등(재실행 안전).

Revision ID: 0092
Revises: 0091
Create Date: 2026-06-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0092"
down_revision = "0091"
branch_labels = None
depends_on = None

# team_members FK 완화 대상 (table, column)
_FK_TARGETS: list[tuple[str, str]] = [
    ("conversation_participants", "member_id"),
    ("conversation_messages", "sender_id"),
    ("conversations", "created_by"),
    ("conversations", "resolved_by"),
    ("events", "sender_id"),
    ("events", "recipient_id"),
]
# canonicalize 대상 scalar 컬럼(conversation_participants는 dedup 후 별도 처리)
_SCALAR: list[tuple[str, str]] = [
    ("conversations", "created_by"),
    ("conversations", "resolved_by"),
    ("conversation_messages", "sender_id"),
    ("events", "sender_id"),
    ("events", "recipient_id"),
]


def _drop_tm_fk(insp: sa.Inspector, table: str, col: str) -> None:
    # 0088 rename로 referred_table이 team_members_legacy일 수 있음(둘 다 매칭).
    for fk in insp.get_foreign_keys(table):
        if fk.get("referred_table") in ("team_members", "team_members_legacy") and col in fk.get("constrained_columns", []):
            if fk.get("name"):
                op.drop_constraint(fk["name"], table, type_="foreignkey")


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    # 1. team_members FK 완화(멱등) — canonical이 legacy 테이블 부재라 canonicalize 전 필수
    for table, col in _FK_TARGETS:
        if table in tables:
            _drop_tm_fk(insp, table, col)

    # 2. conversation_participants dedup — (conversation_id, 해소된 canonical)별 1행만 유지
    if "conversation_participants" in tables:
        op.execute(
            """
            DELETE FROM conversation_participants cp
            USING (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY conversation_id, COALESCE(
                        (SELECT a.member_id FROM member_identity_aliases a WHERE a.alias_id = conversation_participants.member_id),
                        member_id
                    )
                    ORDER BY joined_at ASC, id ASC
                ) AS rn
                FROM conversation_participants
            ) dup
            WHERE cp.id = dup.id AND dup.rn > 1
            """
        )
        # dedup 후 남은 ghost → canonical (이제 (conversation_id, canonical) 유일 보장)
        op.execute(
            """
            UPDATE conversation_participants cp SET member_id = a.member_id
            FROM member_identity_aliases a
            WHERE a.alias_id = cp.member_id AND cp.member_id <> a.member_id
            """
        )

    # 3. scalar 컬럼 canonicalize(orphan-safe: alias 있는 ghost만)
    for table, col in _SCALAR:
        if table in tables:
            op.execute(
                f"""
                UPDATE {table} t SET {col} = a.member_id
                FROM member_identity_aliases a
                WHERE a.alias_id = t.{col} AND t.{col} <> a.member_id
                """
            )

    # 4. mentioned_ids 배열 원소별 canonicalize(0077 _v2 배열 패턴 동형)
    if "conversation_messages" in tables:
        op.execute(
            """
            UPDATE conversation_messages SET mentioned_ids = COALESCE((
                SELECT array_agg(COALESCE(a.member_id, t.e) ORDER BY ord)
                FROM unnest(mentioned_ids) WITH ORDINALITY AS t(e, ord)
                LEFT JOIN member_identity_aliases a ON a.alias_id = t.e
            ), mentioned_ids)
            WHERE mentioned_ids IS NOT NULL AND array_length(mentioned_ids, 1) > 0
              AND EXISTS (
                  SELECT 1 FROM unnest(mentioned_ids) e
                  JOIN member_identity_aliases a ON a.alias_id = e
              )
            """
        )


def downgrade() -> None:
    # forward-only(0085/0086 동형): canonicalize 데이터 remap + FK 완화는 비가역
    # (team_members가 0088서 뷰라 FK 재추가 불가, ghost 매핑 역산 불가). no-op.
    pass
