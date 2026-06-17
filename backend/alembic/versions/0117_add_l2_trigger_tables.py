"""L2-S2: L2 trigger state/firing 테이블 (additive).

Revision ID: 0117
Revises: 0116
Create Date: 2026-06-12

블루프린트 `blueprint-e-l2-intelligence-triggers` §3·§5 S2. L2 휴리스틱 트리거 워커의
cursor 상태(`l2_trigger_state`)와 발사 기록(`l2_trigger_firings`). additive — 기존 스키마
무변경. downgrade는 신규 테이블만 drop(AC①).

⚠️ `l2_trigger_state` 키: 스펙은 PK(worker_name, org_id)이나 Postgres PRIMARY KEY는 nullable
컬럼을 허용하지 않는다(org_id는 전-org 시스템 워커용 NULL 허용). 그래서 PK 대신
`(worker_name, COALESCE(org_id, zero-uuid))` UNIQUE 인덱스를 de-facto 키로 둔다 — NULL(global)을
sentinel로 접어 cross-version으로 "워커×org-스코프 1행"을 강제하고 upsert 타깃이 된다.

FK 정책: trigger 그래프는 decoupled projection이라 org/agent/anchor/event 참조는 비강제 plain
UUID(L1 activity_events·canonical id 컨벤션 정합).

idempotent: 테이블 단위 inspect 가드(0113/0116 선례).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0117"
down_revision = "0116"
branch_labels = None
depends_on = None

_GLOBAL_SENTINEL = "00000000-0000-0000-0000-000000000000"


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    if "l2_trigger_state" not in existing:
        op.create_table(
            "l2_trigger_state",
            sa.Column("worker_name", sa.Text(), nullable=False),
            # org_id NULL = 전-org 시스템 워커(BE-6 poll org_id=None 대응).
            sa.Column("org_id", UUID(as_uuid=True), nullable=True),
            sa.Column("last_activity_seq", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
        # de-facto 키 — NULL(global)을 sentinel로 접어 (worker, org-or-global) 1행 강제.
        op.create_index(
            "uq_l2_trigger_state_worker_org",
            "l2_trigger_state",
            ["worker_name", sa.text(f"COALESCE(org_id, '{_GLOBAL_SENTINEL}'::uuid)")],
            unique=True,
        )

    if "l2_trigger_firings" not in existing:
        op.create_table(
            "l2_trigger_firings",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("trigger_type", sa.Text(), nullable=False),
            sa.Column("target_agent_id", UUID(as_uuid=True), nullable=False),
            sa.Column("anchor_type", sa.Text(), nullable=True),
            sa.Column("anchor_id", UUID(as_uuid=True), nullable=True),
            sa.Column("dedup_key", sa.Text(), nullable=False),
            sa.Column("source_activity_seq", sa.BigInteger(), nullable=True),
            # AC③: event_id optional.
            sa.Column("event_id", UUID(as_uuid=True), nullable=True),
            sa.Column(
                "fired_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("payload", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        )
        # AC②: dedup_key unique — 같은 dedup_key 2회 insert는 1회만(AC④).
        op.create_index(
            "uq_l2_trigger_firings_dedup_key",
            "l2_trigger_firings",
            ["dedup_key"],
            unique=True,
        )
        # 워커가 에이전트의 최근 발사를 조회(dedup window·org 타임라인).
        op.create_index(
            "ix_l2_trigger_firings_target_fired",
            "l2_trigger_firings",
            ["org_id", "target_agent_id", sa.text("fired_at DESC")],
        )


def downgrade() -> None:
    # AC①: 신규 테이블만 drop(인덱스 동반 제거). 기존 스키마 무영향.
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())
    if "l2_trigger_firings" in existing:
        op.drop_table("l2_trigger_firings")
    if "l2_trigger_state" in existing:
        op.drop_table("l2_trigger_state")
