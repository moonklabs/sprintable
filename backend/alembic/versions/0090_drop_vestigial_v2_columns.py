"""E-MEMBER-SSOT AC3-5 ⑤: vestigial *_v2 식별 컬럼 DROP.

AC3-2(0077/0078/0079)가 legacy team_member.id 식별 컬럼을 canonical members.id로 옮기는 *_v2 컬럼 +
alias 백필을 추가했으나, 최종 채택 전략은 **(A) resolver-cutover**(legacy 컬럼이 canonicalize로 canonical
보유) — *_v2 read-cut은 미착수(app 코드 *_v2 참조 0건). 즉 *_v2는 **백필-only vestigial**.

app 전수 grep 재확인(develop 0089 기준): *_v2 식별 컬럼 코드 참조 0건(모델 주석만 — 동반 갱신). 파괴적
DROP이나 미참조 확정 → 안전. canonical 진실은 legacy 컬럼(canonicalize_member_id) 유지, 본 DROP은 미사용
중복 컬럼/인덱스 소거(곱연산 잔재 정리). 가역: DOWN은 nullable 컬럼+인덱스 재추가(백필-only라 데이터 손실 0).

⚠️ 0077 conv/events·0078 assignee·0079 participation/notif/webhook/reward/docs 전수.

Revision ID: 0090
Revises: 0089
Create Date: 2026-06-04
"""
from __future__ import annotations

from alembic import op

revision = "0090"
down_revision = "0089"
branch_labels = None
depends_on = None

# scalar uuid *_v2 컬럼 (table, base_col) — 0077/0078/0079 전수
_V2_SCALAR: list[tuple[str, str]] = [
    # 0077 conv/events
    ("conversations", "created_by"),
    ("conversations", "resolved_by"),
    ("conversation_participants", "member_id"),
    ("conversation_messages", "sender_id"),
    ("events", "sender_id"),
    ("events", "recipient_id"),
    # 0078 assignee
    ("epics", "assignee_id"),
    ("stories", "assignee_id"),
    ("tasks", "assignee_id"),
    # 0079 rest
    ("participation", "member_id"),
    ("notification_preferences", "member_id"),
    ("webhook_configs", "member_id"),
    ("reward_ledger", "member_id"),
    ("reward_ledger", "granted_by"),
    ("docs", "created_by"),
    ("docs", "assignee_id"),
    ("doc_comments", "created_by"),
    ("doc_revisions", "created_by"),
]
# 배열 *_v2 컬럼 (0077 mentioned_ids)
_V2_ARRAY: list[tuple[str, str]] = [
    ("conversation_messages", "mentioned_ids"),
]
# *_v2 인덱스 (index, table, v2_col) — DROP COLUMN이 자동 제거하나 명시적·가역 재생성 위해 보유
_V2_INDEXES: list[tuple[str, str, str]] = [
    ("ix_events_recipient_id_v2", "events", "recipient_id_v2"),
    ("ix_conv_participants_member_id_v2", "conversation_participants", "member_id_v2"),
    ("ix_epics_assignee_id_v2", "epics", "assignee_id_v2"),
    ("ix_stories_assignee_id_v2", "stories", "assignee_id_v2"),
    ("ix_tasks_assignee_id_v2", "tasks", "assignee_id_v2"),
    ("ix_participation_member_id_v2", "participation", "member_id_v2"),
    ("ix_notification_preferences_member_id_v2", "notification_preferences", "member_id_v2"),
    ("ix_webhook_configs_member_id_v2", "webhook_configs", "member_id_v2"),
    ("ix_reward_ledger_member_id_v2", "reward_ledger", "member_id_v2"),
]


def upgrade() -> None:
    # 인덱스 먼저 명시 제거(컬럼 DROP이 자동 제거하나 멱등·명시), 그 뒤 컬럼 DROP
    for idx, _table, _col in _V2_INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {idx}")
    for table, col in _V2_SCALAR:
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {col}_v2")
    for table, col in _V2_ARRAY:
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {col}_v2")


def downgrade() -> None:
    # 가역: nullable 컬럼+인덱스 재추가(백필-only였으므로 데이터 손실 0 — canonical 진실은 legacy 컬럼).
    for table, col in _V2_SCALAR:
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col}_v2 uuid")
    for table, col in _V2_ARRAY:
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col}_v2 uuid[]")
    for idx, table, v2col in _V2_INDEXES:
        op.execute(f"CREATE INDEX IF NOT EXISTS {idx} ON {table} ({v2col})")
