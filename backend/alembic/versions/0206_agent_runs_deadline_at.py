"""story #2161(2026-07-24, 오르테가군 판정) — agent_runs.deadline_at 컬럼.

Revision ID: 0206
Revises: 0205
Create Date: 2026-07-24

'running' 정체 방지 — POST /agent-runs 와 PATCH /agent-runs/{id} 는 서로 모르는 두 독립 MCP
호출(sprintable_mcp/tools/agent_runs.py: emit_event/update_run_status)이라, 종료 신호가
안 오면(에이전트 크래시/kill/timeout) status='running' 이 영원히 안 닫혔다(까심군 AC1 확定).
`a2a_tasks.deadline_at`(0168, story 2a57dc0f)과 동일 처방 — 생성 시점에 이미 종료 예정 시각을
기록해, 폴링과 무관한 cron 스위퍼가 능동적으로 판정한다("시작할 때 이미 끝날 시각을 갖고
태어나게", 오르테가군 지시).

nullable(기존 행 백필 없음, 순수 additive) — 마이그 이전 생성된 레거시 run은 NULL이며, 소비
코드(app/services/agent_run_lifecycle.py)가 `deadline_at ?? started_at + AGENT_RUN_TIMEOUT_
HOURS`로 폴백해 무회귀 처리한다(0168과 동형 폴백 — 기존 stuck row도 자동 스위퍼 사정권).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0206"
down_revision = "0205"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column("deadline_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_runs", "deadline_at")
