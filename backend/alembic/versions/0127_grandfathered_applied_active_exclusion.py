"""E-DG S19 fix(B2): add grandfathered_applied to uq_wf_step_run_active exclusion.

consume_grandfather 가 marker 를 ``grandfathered_applied`` 로 닫는데, 이 status 가 active partial-
unique(``uq_wf_step_run_active``) 제외 목록에 없어 — consume 이 marker.to_status 를 실 전이값으로
세팅하면 — 2nd(거버닝) transition step_run INSERT 가 동일 (org,entity,from,to,attempt) 로 충돌 →
SAVEPOINT 캐치 → step_run_id=None → governance 기록/relay 유실(까심 QA B2).

``grandfathered_applied`` 를 terminal 제외 목록에 추가해 consumed marker 가 active 에서 빠지게 한다.
기존 행에 이 status 는 없으므로(S19 신규) 재생성 안전.
"""
from alembic import op

revision = "0127"
down_revision = "0126"
branch_labels = None
depends_on = None

_COLS = "org_id, entity_type, entity_id, from_status, to_status, attempt"
_EXCL_OLD = (
    "'applied','rejected','failed','engine_failed','withdrawn','timed_out','cancelled','grandfathered'"
)
_EXCL_NEW = _EXCL_OLD + ",'grandfathered_applied'"


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_wf_step_run_active")
    op.execute(
        f"CREATE UNIQUE INDEX uq_wf_step_run_active ON workflow_line_step_runs ({_COLS}) "
        f"WHERE status NOT IN ({_EXCL_NEW})"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_wf_step_run_active")
    op.execute(
        f"CREATE UNIQUE INDEX uq_wf_step_run_active ON workflow_line_step_runs ({_COLS}) "
        f"WHERE status NOT IN ({_EXCL_OLD})"
    )
