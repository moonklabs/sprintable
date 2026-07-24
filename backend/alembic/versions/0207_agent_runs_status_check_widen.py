"""story #2161(2026-07-24) — agent_runs_status_check 를 'abandoned' 포함하게 확장.

Revision ID: 0207
Revises: 0206
Create Date: 2026-07-24

리퍼(app/services/agent_run_lifecycle.py)가 기한 초과 'running' run을 'abandoned'으로 전이한다
— 오르테가군 지시: **'completed'로 위장 금지**(끝났는지 모르는 것을 성공적으로 끝난 것으로
둔갑시키면 거짓을 없애려던 수정이 더 나쁜 거짓을 만든다). 기존 CHECK
(queued|held|running|hitl_pending|completed|failed)에 'abandoned'이 없어 실 Postgres에서
그대로 쓰면 IntegrityError — 0129(sprints_status_check widen)와 동일 패턴으로 ALTER.

⚠️백필 불필요: 기존 행은 전부 기존 6-enum 안에 있어 wider 제약서도 그대로 유효(안전한 확장
ALTER). baseline schema.sql CHECK 동반 갱신 필수([[feedback_baseline_check_ci_sqlite_blindspot]]
— CI SQLite/session mock은 이 제약 위반을 못 잡는다, 실 PG에서만 드러남).
"""
from alembic import op

revision = "0207"
down_revision = "0206"
branch_labels = None
depends_on = None

_FULL = "('queued', 'held', 'running', 'hitl_pending', 'completed', 'failed', 'abandoned')"
_OLD = "('queued', 'held', 'running', 'hitl_pending', 'completed', 'failed')"


def upgrade() -> None:
    op.execute("ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check")
    op.execute(
        f"ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN {_FULL})"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check")
    op.execute(
        f"ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN {_OLD})"
    )
