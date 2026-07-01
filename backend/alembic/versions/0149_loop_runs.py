"""E-LOOP-LEDGER S1(story e333e8b1): loop_runs 척추 테이블(append-only spine).

Revision ID: 0149
Revises: 0148
Create Date: 2026-07-01

블루프린트 `e-loop-ledger-blueprint` §1. loop(goal→brief→variants→decision→execute→
measure→outcome) 반복의 spine 엔티티 — 나머지(hypotheses/docs/assets/gate)는 EXTEND,
이 테이블만 신설. `chosen_artifact_id`는 컬럼만 만들고 FK 제약은 없다(S2가 loop_artifacts
테이블 생성 후 ALTER TABLE ADD CONSTRAINT로 잠근다 — 순환 의존을 컬럼 재생성 없이 해소).

status FSM: draft→briefing→generating→deciding→executing→measuring→closed 순차 진행.
abandoned는 closed/measuring 이전 어느 상태에서든 진입 가능(조기 중단). closed/abandoned는
terminal(역전이 없음) — app/models/hypothesis.py의 is_valid_transition 패턴과 동형.

idempotent: 테이블 단위 inspect 가드(0113 hypotheses 선례와 동일 클래스).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision = "0149"
down_revision = "0148"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    if "loop_runs" not in existing:
        op.create_table(
            "loop_runs",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "project_id",
                UUID(as_uuid=True),
                sa.ForeignKey("projects.id", ondelete="CASCADE"),
                nullable=False,
            ),
            # self-FK — lineage(N⇒N-1). SET NULL(CASCADE 아님): soft-delete 테이블이라 실
            # DELETE 드물지만, 혹시 발생해도 lineage 전체 연쇄삭제보다 고아 허용이 안전.
            sa.Column(
                "parent_loop_id",
                UUID(as_uuid=True),
                sa.ForeignKey("loop_runs.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "hypothesis_id",
                UUID(as_uuid=True),
                sa.ForeignKey("hypotheses.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "brief_doc_id",
                UUID(as_uuid=True),
                sa.ForeignKey("docs.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "decision_gate_id",
                UUID(as_uuid=True),
                sa.ForeignKey("gate.id", ondelete="SET NULL"),
                nullable=True,
            ),
            # loop_artifacts(S2)가 아직 없어 FK 없이 컬럼만.
            sa.Column("chosen_artifact_id", UUID(as_uuid=True), nullable=True),
            sa.Column("recipe_slug", sa.Text(), nullable=True),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column(
                "goal_tags",
                ARRAY(sa.Text()),
                nullable=False,
                server_default=sa.text("'{}'::text[]"),
            ),
            sa.Column("status", sa.String(24), nullable=False, server_default="draft"),
            sa.Column("outcome_snapshot", JSONB, nullable=True),
            sa.Column("outcome_attributed_at", sa.DateTime(timezone=True), nullable=True),
            # FK 비강제(hypotheses.owner_member_id/assignee_id 동형 컨벤션) — 서버 resolve_member 해소.
            sa.Column("created_by_member_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.CheckConstraint(
                "status IN ('draft','briefing','generating','deciding','executing',"
                "'measuring','closed','abandoned')",
                name="ck_loop_runs_status",
            ),
            sa.CheckConstraint(
                "parent_loop_id IS NULL OR parent_loop_id <> id",
                name="ck_loop_runs_parent_not_self",
            ),
        )
        op.create_index("ix_loop_runs_org_id", "loop_runs", ["org_id"])
        op.create_index(
            "ix_loop_runs_org_project_status_created_at",
            "loop_runs",
            ["org_id", "project_id", "status", sa.text("created_at DESC")],
        )
        op.create_index("ix_loop_runs_parent_loop_id", "loop_runs", ["parent_loop_id"])
        op.create_index(
            "ix_loop_runs_goal_tags_gin",
            "loop_runs",
            ["goal_tags"],
            postgresql_using="gin",
        )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    if "loop_runs" in existing:
        op.drop_table("loop_runs")
