"""story #3722(Trust·BE, 페드루 PO 確定 2026-09-09) — 에이전트 인증 API 요청 1건 =
agent_run_tool_calls 1행. unhandled_error_events(0355)와 동형 관례(FK 없는 org_id/
method/path·비밀값 미저장) — run_id만 예외로 FK를 건다(agent_runs.id ON DELETE CASCADE,
그 run이 지워지면 그 run에 귀속된 호출 기록도 같이 지워지는 게 정직 — 「run이 없는데
run의 도구 호출 기록만 남는」 모순 방지). agent_id/org_id는 FK 없음(unhandled_error_
events 관례 그대로 — 조회용 요약 테이블, 강제 조인 이유 0).

⚠️페드루 PO 지시(2026-09-09 07:28Z) — 미르코 #4079(3734, 0356_site_channel_post_
drafts_soft_delete)와 revision 0356이 충돌해 #4079를 먼저 착지시키기로(선생님 급)
0357·down_revision="0355"(임시)로 재번호했다. #4079 착지 뒤 develop 리베이스하며
down_revision을 "0356"으로 한 번 더 고칠 것 — 지금은 과도기 상태.

Revision ID: 0357
Revises: 0355
Create Date: 2026-09-09
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0357"
down_revision = "0355"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_run_tool_calls",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "run_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=True,
        ),
        sa.Column("tool", sa.Text(), nullable=True),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("input_summary", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("attribution_reason", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    # run_id·created_at 복합 인덱스 — GET /agent-runs/{id}/tool-calls 커서 조회(run_id로
    # 필터 후 created_at DESC 최신순)가 정본 읽기 경로.
    op.create_index(
        "ix_agent_run_tool_calls_run_id_created_at", "agent_run_tool_calls", ["run_id", "created_at"],
    )
    # org_id·created_at — 보존기간 정리 스윕(30일)이 org 무관 전역 스캔이라 이 인덱스는
    # created_at 단독으로도 충분하지만, 향후 org별 감사 조회 대비 겸용으로 같이 둔다.
    op.create_index("ix_agent_run_tool_calls_created_at", "agent_run_tool_calls", ["created_at"])
    op.create_index("ix_agent_run_tool_calls_agent_id", "agent_run_tool_calls", ["agent_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_run_tool_calls_agent_id", table_name="agent_run_tool_calls")
    op.drop_index("ix_agent_run_tool_calls_created_at", table_name="agent_run_tool_calls")
    op.drop_index("ix_agent_run_tool_calls_run_id_created_at", table_name="agent_run_tool_calls")
    op.drop_table("agent_run_tool_calls")
