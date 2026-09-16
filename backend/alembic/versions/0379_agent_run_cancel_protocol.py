"""story #3961(「정지」 액션 — 중단 요청 프로토콜, PO 확定 2026-09-16) —
agent_runs_status_check를 cancel_requested·cancelled·cancelled_unacknowledged
포함하게 확장 + 감사 컬럼 5개 + preset.agent_run.cancel_requested 이벤트 정의 시드.

Revision ID: 0379
Revises: 0378
Create Date: 2026-09-16

0207(agent_runs_status_check widen)과 동일 패턴(DROP+ADD CONSTRAINT) — 기존 행은 전부
새 CHECK 안에 있어 백필 불필요.

⚠️baseline schema.sql CHECK 동반 갱신 필수([[feedback_baseline_check_ci_sqlite_blindspot]]
— CI SQLite/session mock은 이 제약 위반을 못 잡는다, 실 PG에서만 드러난다, 0207 docstring과
동일 함정) — 이 마이그와 같은 PR에서 `alembic/baseline/schema.sql`도 갱신했다.
"""
import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID

revision = "0379"
down_revision = "0378"
branch_labels = None
depends_on = None

_FULL = (
    "('queued', 'held', 'running', 'hitl_pending', 'completed', 'failed', 'abandoned', "
    "'cancel_requested', 'cancelled', 'cancelled_unacknowledged')"
)
_OLD = "('queued', 'held', 'running', 'hitl_pending', 'completed', 'failed', 'abandoned')"

_EVENT_KEY = "preset.agent_run.cancel_requested"
_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["run_id", "agent_id", "requested_by_member_id"],
    "properties": {
        "run_id": {"type": "string", "format": "uuid"},
        "agent_id": {"type": "string", "format": "uuid"},
        "requested_by_member_id": {"type": "string", "format": "uuid"},
        "reason": {"type": ["string", "null"]},
    },
}
# 정지 대상 에이전트 자신이 개입(자기보고 ack)을 요청받는 사람 — escalation
# kind=payload_field(agent_id에서 직접 뽑는다, preset.work.assigned와 동일 원칙).
# broadcast=none — 팀 전체가 볼 활동피드 항목이 아니라 대상 에이전트에게만 가는
# 운영 신호(preset.gate.verdict의 escalation=none과 동형 반대축).
_ROUTING = {
    "escalation": {
        "kind": "payload_field", "target": "agent", "member_id_field": "agent_id",
    },
    "broadcast": {"kind": "server_derived", "target": "none"},
}

# 15는 app/routers/agent_runs.py::_CANCEL_ACK_TIMEOUT_MINUTES와 같은 값(마이그는 앱 코드를
# import하지 않는 관례라 리터럴 중복 — 그 상수를 바꾸면 이 문구도 같이 바꿀 것).
_DESCRIPTION = (
    "사람(org owner/admin 또는 이 일의 담당자)이 이 실행을 중단해달라고 요청했습니다. "
    "가능한 한 빨리 다음 update_run_status 호출에서 status=\"cancelled\"로 ack하세요 — "
    "15분 안에 ack가 없으면 서버가 스스로 cancelled_unacknowledged로 확定합니다"
    "(실패로 기록되지 않습니다 — 정상 결과)."
)

event_definitions = sa.table(
    "event_definitions",
    sa.column("id", PGUUID(as_uuid=True)),
    sa.column("key", sa.Text),
    sa.column("org_id", PGUUID(as_uuid=True)),
    sa.column("name", sa.Text),
    sa.column("description", sa.Text),
    sa.column("payload_schema", JSONB),
    sa.column("routing", JSONB),
)


def upgrade() -> None:
    op.execute("ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check")
    op.execute(
        f"ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN {_FULL})"
    )

    # story #0090/#0212류 관례(IF NOT EXISTS) — baseline/schema.sql이 최신 구조를 이미
    # 포함해 두는 이 저장소 관행상, baseline stamp(0096) 후 순차 replay 경로에서 이 마이그가
    # 도달할 때 컬럼이 이미 있을 수 있다(idempotent ADD 아니면 DuplicateColumn) — 실측 확認.
    op.execute("ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cancel_requested_by uuid")
    op.execute("ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz")
    op.execute("ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cancel_reason text")
    op.execute("ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cancel_ack_at timestamptz")
    op.execute("ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cancel_outcome text")

    op.bulk_insert(
        event_definitions,
        [{
            "id": uuid.uuid4(),
            "key": _EVENT_KEY,
            "org_id": None,
            "name": "에이전트 실행 중단 요청",
            "description": _DESCRIPTION,
            "payload_schema": _PAYLOAD_SCHEMA,
            "routing": _ROUTING,
        }],
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM event_definitions WHERE key = '{_EVENT_KEY}' AND org_id IS NULL")

    op.drop_column("agent_runs", "cancel_outcome")
    op.drop_column("agent_runs", "cancel_ack_at")
    op.drop_column("agent_runs", "cancel_reason")
    op.drop_column("agent_runs", "cancel_requested_at")
    op.drop_column("agent_runs", "cancel_requested_by")

    op.execute("ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check")
    op.execute(
        f"ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN {_OLD})"
    )
