"""story #2637 §0-c(#2636서 이관) — notification_preferences에 event_key 구독 축 추가.

Revision ID: 0250
Revises: 0249
Create Date: 2026-08-14

event_key는 문자열(예: "org.acme.widget.made")이라 기존 scope_id(UUID)에 못 담는다 — 새
nullable 컬럼으로 분리. scope_type="event_key"일 때 scope_id는 NULL(이벤트키 자체가
식별자라 별도 UUID 불필요)이고 event_key 컬럼이 그 값을 담는다.

기존 uq_notif_pref_global(scope_id IS NULL) 파티셜 유니크는 event_key IS NULL 조건을
추가해 event_key-scope 행을 그 버킷에서 제외한다(안 그러면 서로 다른 event_key를 가진
행들이 전부 "scope_id IS NULL" 하나의 유니크 버킷에 몰려 두 번째 event_key 등록부터
충돌한다). event_key-scope 전용 파티셜 유니크(uq_notif_pref_event_key)를 새로 추가.

소비는 app/services/channel_router.py — scope_type_order에 event_key 축을 conversation/
project와 global 사이에 끼워 넣는다(사용자가 특정 대화를 명시로 커스텀했으면 그게 여전히
이기고, 아무 대화-구조 축도 없으면 "이 이벤트타입 전체 mute"가 순수 global보다 먼저 이긴다).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0250"
down_revision = "0249"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "notification_preferences",
        sa.Column("event_key", sa.Text(), nullable=True),
    )
    op.drop_index("uq_notif_pref_global", table_name="notification_preferences")
    op.create_index(
        "uq_notif_pref_global",
        "notification_preferences",
        ["member_id", "scope_type", "channel"],
        unique=True,
        postgresql_where=sa.text("scope_id IS NULL AND event_key IS NULL"),
    )
    op.create_index(
        "uq_notif_pref_event_key",
        "notification_preferences",
        ["member_id", "event_key", "channel"],
        unique=True,
        postgresql_where=sa.text("event_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_notif_pref_event_key", table_name="notification_preferences")
    op.drop_index("uq_notif_pref_global", table_name="notification_preferences")
    op.create_index(
        "uq_notif_pref_global",
        "notification_preferences",
        ["member_id", "scope_type", "channel"],
        unique=True,
        postgresql_where=sa.text("scope_id IS NULL"),
    )
    op.drop_column("notification_preferences", "event_key")
