"""story #3828(UX-v3·대화·BE 1, 페드루 PO 確定 2026-09-13) — 「지시 한 줄 → 실행 →
결과가 같은 스레드로 돌아온다」의 연결 자리. 지금은 이 연결이 DB 어디에도 없다
(디디 그라운딩 2026-09-13 02:07Z — AgentRun엔 memo_id뿐, conversation/message 축
0). 이 실행이 어느 conversation에서·어느 메시지가 트리거해 시작됐는지를 기록할
nullable 2컬럼만 연다(백필 0 — 과거 run은 그 연결 자체가 없었다는 게 정직한 사실,
지어내지 않는다).

conversation_id는 ON DELETE SET NULL(대화가 지워져도 run 이력 자체는 남아야
한다 — agent_run_tool_calls의 run_id CASCADE와는 반대 방향 관례, 이유가 다르다:
그쪽은 "부모(run)가 없으면 자식(tool_call) 기록도 의미 없음", 이쪽은 "run은
독립적으로 유효한 실행 이력이고 conversation은 부가 링크일 뿐").
triggering_message_id도 동형(ON DELETE SET NULL).

Revision ID: 0374
Revises: 0373
Create Date: 2026-09-13
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0374"
down_revision = "0373"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column(
            "conversation_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.add_column(
        "agent_runs",
        sa.Column(
            "triggering_message_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversation_messages.id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.create_index("ix_agent_runs_conversation_id", "agent_runs", ["conversation_id"])
    op.create_index("ix_agent_runs_triggering_message_id", "agent_runs", ["triggering_message_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_runs_triggering_message_id", table_name="agent_runs")
    op.drop_index("ix_agent_runs_conversation_id", table_name="agent_runs")
    op.drop_column("agent_runs", "triggering_message_id")
    op.drop_column("agent_runs", "conversation_id")
