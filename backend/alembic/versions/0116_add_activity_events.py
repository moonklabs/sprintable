"""L1 BE-1: activity_events canonical 활동 테이블 (additive).

Revision ID: 0116
Revises: 0115
Create Date: 2026-06-11

블루프린트 `blueprint-e-l1-activity-graph` §3.1·§5 BE-1. 이벤트버스(events)를 canonical
활동 그래프로 정규화하기 위한 신규 물리 테이블. 기존 `events` 스키마/인덱스는 무변경
(additive). 이 마이그는 테이블+인덱스만 만들고 backfill은 하지 않는다(후속 BE story).

FK 정책: canonical projection 테이블이라 actor/object/event 참조는 비강제(plain UUID).
코드 컨벤션(hypotheses `assignee_id`·member 식별자 선례 — "FK 비강제 canonical id")과
정합하며, 원본 event가 정리돼도 활동 기록(감사 그래프)은 보존된다.

idempotent: 테이블 단위 inspect 가드(0113 선례). downgrade는 신규 테이블만 drop한다
(AC④ — 기존 events 무영향).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision = "0116"
down_revision = "0115"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    if "activity_events" in existing:
        return

    op.create_table(
        "activity_events",
        sa.Column("activity_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        # actor = 활동 주체(agent/human member). 시스템 활동은 NULL 허용.
        sa.Column("actor_id", UUID(as_uuid=True), nullable=True),
        sa.Column("verb", sa.Text(), nullable=False),
        sa.Column("object_type", sa.Text(), nullable=True),
        sa.Column("object_id", UUID(as_uuid=True), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        # 대표 원본 event(여러 event를 1 활동으로 합칠 때의 canonical pointer).
        sa.Column("representative_event_id", UUID(as_uuid=True), nullable=True),
        # 이 활동으로 합쳐진 원본 event들 / 수신자 fan-out(정규화 전 events에서 끌어온 투영).
        sa.Column("source_event_ids", ARRAY(UUID(as_uuid=True)), nullable=False, server_default="{}"),
        sa.Column("recipient_ids", ARRAY(UUID(as_uuid=True)), nullable=False, server_default="{}"),
        sa.Column("recipient_types", ARRAY(sa.Text()), nullable=False, server_default="{}"),
        sa.Column("payload", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        # (org_id, dedup_key) unique로 동일 활동 중복 흡수.
        sa.Column("dedup_key", sa.Text(), nullable=False),
        # 단조 증가 시퀀스(cursor 페이지네이션·정렬 안정성).
        sa.Column("activity_seq", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # AC②: (org_id, dedup_key) unique — 활동 dedup.
    op.create_index(
        "uq_activity_events_org_dedup",
        "activity_events",
        ["org_id", "dedup_key"],
        unique=True,
    )
    # AC③: 조회 인덱스 4종(project/actor/object/verb × time). 멀티테넌트라 org_id 선두.
    op.create_index(
        "ix_activity_events_project_time",
        "activity_events",
        ["org_id", "project_id", sa.text("occurred_at DESC")],
    )
    op.create_index(
        "ix_activity_events_actor_time",
        "activity_events",
        ["org_id", "actor_id", sa.text("occurred_at DESC")],
    )
    op.create_index(
        "ix_activity_events_object_time",
        "activity_events",
        ["org_id", "object_type", "object_id", sa.text("occurred_at DESC")],
    )
    op.create_index(
        "ix_activity_events_verb_time",
        "activity_events",
        ["org_id", "verb", sa.text("occurred_at DESC")],
    )


def downgrade() -> None:
    # AC④: 신규 테이블만 drop(인덱스 동반 제거). 기존 events 무영향.
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "activity_events" in set(insp.get_table_names()):
        op.drop_table("activity_events")
