"""hitl: agent_hitl_requests.request_type CHECK에 'gate_approval' 추가 (S-GATE-2 라이브 버그)

E-HITL-GATING dogfood가 적출한 라이브 버그: enforce_gate(S-GATE-2) ask 분기가
HitlRequest(request_type='gate_approval')로 INSERT 하는데, baseline CHECK 제약
`agent_hitl_requests_request_type_check`(approval·input·confirmation·escalation)이 'gate_approval'을
미허용 → asyncpg CheckViolationError → **모든 ask park 경로 500**. CI SQLite가 PG CHECK 제약을
강제 안 해 유닛 테스트가 못 잡음(asyncpg/PG 블라인드스팟).

fix: 허용집합에 'gate_approval' 추가(**확대**라 기존 행 전부 통과 → 검증 즉시·prod-safe).
제약은 baseline 출신이라 마이그레이션으로 DROP+ADD.

Revision ID: 0124
Revises: 0123
"""
from alembic import op

revision = "0124"
down_revision = "0123"
branch_labels = None
depends_on = None

_ALLOWED_NEW = "ARRAY['approval', 'input', 'confirmation', 'escalation', 'gate_approval']"
_ALLOWED_OLD = "ARRAY['approval', 'input', 'confirmation', 'escalation']"


def _set_constraint(allowed: str) -> None:
    op.execute(
        "ALTER TABLE agent_hitl_requests "
        "DROP CONSTRAINT IF EXISTS agent_hitl_requests_request_type_check"
    )
    op.execute(
        "ALTER TABLE agent_hitl_requests "
        "ADD CONSTRAINT agent_hitl_requests_request_type_check "
        f"CHECK (request_type = ANY ({allowed}::text[]))"
    )


def upgrade() -> None:
    _set_constraint(_ALLOWED_NEW)


def downgrade() -> None:
    # 주의: downgrade 전 'gate_approval' 행이 있으면 ADD 가 실패한다(역방향은 축소).
    _set_constraint(_ALLOWED_OLD)
