"""E-DG S26: sprints_status_check 를 full enum 으로 확장 (review·archived 허용).

S26 가 sprint 전이에 review(active→review)·archived(closed→archived)를 추가했으나 기존 DB CHECK
(planning|active|closed)가 그 값을 거부 → 실 Postgres 에서 IntegrityError. CHECK 를 5-enum 으로 ALTER.
⚠️백필 불필요: 기존 행은 전부 planning/active/closed 라 wider 제약서 그대로 유효(안전한 확장 ALTER).
([[feedback_baseline_check_ci_sqlite_blindspot]]·[[feedback_constraint_exhaustive_writer_audit]] — enum
추가 시 baseline schema.sql CHECK 동반 갱신 필수.)
"""
from alembic import op

revision = "0129"
down_revision = "0128"
branch_labels = None
depends_on = None

_FULL = "('planning', 'active', 'review', 'closed', 'archived')"
_OLD = "('planning', 'active', 'closed')"


def upgrade() -> None:
    op.execute("ALTER TABLE sprints DROP CONSTRAINT IF EXISTS sprints_status_check")
    op.execute(
        f"ALTER TABLE sprints ADD CONSTRAINT sprints_status_check CHECK (status IN {_FULL})"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE sprints DROP CONSTRAINT IF EXISTS sprints_status_check")
    op.execute(
        f"ALTER TABLE sprints ADD CONSTRAINT sprints_status_check CHECK (status IN {_OLD})"
    )
