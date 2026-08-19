"""story #2813([Gate 강제·BE], 설계 카드 doc c1855e0d) — Gate→GitHub required check 발행에
필요한 SHA 귀속 축 신설.

그라운딩 발견(설계 doc gate-github-required-check-grounding-design-2813 §1): `gates` 테이블에
SHA 개념이 전혀 없었다 — `evaluate_merge_gate`/`reconcile_merge_gate_with_real_evidence` 인자에도
head_sha가 없고, verdict_capture.py가 웹훅에서 뽑는 head_sha가 게이트까지 전파되지 않는다. 이
마이그는 그 갭을 메운다:

- `gates.github_check_run_id`(BigInteger, nullable) — 이 게이트가 추적 중인 현재 GitHub
  check-run id. 같은 SHA에 대한 pending→success/failure 갱신은 이 id로 PATCH, 새 SHA(재-pending)
  는 새 check-run을 만들고 이 값을 교체한다.
- `gates.approved_head_sha`(Text, nullable) — "이 승인이 귀속된 SHA"(AC②). synchronize 웹훅
  수신 시 이 값과 새 head_sha가 다르면 게이트를 pending으로 되돌린다(재-pending).
- 신규 테이블 `gate_github_check_event` — check 발행/재-pending/해소 원장(AC④). 기존 audit
  테이블 3종(permission_audit_logs/login_audit_log/deletion_audit)은 전부 목적이 달라(권한변경·
  로그인·삭제 전용 스키마) 재사용 부적합 판정(그라운딩 §1) — 신규가 정본.

Revision ID: 0262
Revises: 0261
Create Date: 2026-08-19
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0262"
down_revision = "0261"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("github_check_run_id", sa.BigInteger(), nullable=True))
    op.add_column("gate", sa.Column("approved_head_sha", sa.Text(), nullable=True))

    op.create_table(
        "gate_github_check_event",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "org_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True,
        ),
        sa.Column(
            "gate_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("gate.id", ondelete="CASCADE"), nullable=False, index=True,
        ),
        sa.Column("story_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("repo_full_name", sa.Text(), nullable=False),
        sa.Column("pr_number", sa.Integer(), nullable=False),
        sa.Column("head_sha", sa.Text(), nullable=False),
        # published(최초/재-pending 발행) | re_pending(SHA 불일치로 되돌림) | resolved(success/failure).
        sa.Column("event_type", sa.Text(), nullable=False),
        # GitHub check-run conclusion 그대로: pending 발행이면 NULL(status=in_progress).
        sa.Column("check_conclusion", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_gate_github_check_event_gate_created",
        "gate_github_check_event", ["gate_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_gate_github_check_event_gate_created", table_name="gate_github_check_event")
    op.drop_table("gate_github_check_event")
    op.drop_column("gate", "approved_head_sha")
    op.drop_column("gate", "github_check_run_id")
