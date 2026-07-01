"""B1(9f27af8f): retro_sessions.phase 6게이트 → 3능동게이트+terminal de-gate.

유나 locked mockup §B1 — group/discuss는 강제 통과 게이트였던 게 문제라 phase 자체에서 제거
(rename 아님). 기존 라이브 세션은 PO 권고 매핑으로 일괄 이관(전보존 — items/votes/actions/
grouping은 phase와 무관한 별도 테이블이라 이 마이그가 손대지 않음):
  collect→collect, group→vote, vote→vote, discuss→action, action→action, closed→closed

순서: (a) UPDATE phase 매핑 적용 → (b) CHECK 제약을 4값 세트로 교체(순서 반대면 기존 group/
discuss 세션이 남아있는 동안 CHECK 위반).

downgrade()는 phase 값 자체는 복원 안 함(group→vote/discuss→action은 손실 매핑이라 역산
불가 — 어느 vote 세션이 원래 group이었는지 정보가 없음) — CHECK 제약만 6값으로 되돌려
downgrade 직후 앱이 계속 4값으로만 쓰면 기능상 문제 없음(6값 CHECK가 4값의 상위집합).
"""
from __future__ import annotations

from alembic import op

revision = "0145"
down_revision = "0144"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE retro_sessions
        SET phase = CASE phase
            WHEN 'group' THEN 'vote'
            WHEN 'discuss' THEN 'action'
            ELSE phase
        END
        WHERE phase IN ('group', 'discuss')
        """
    )
    op.drop_constraint("retro_sessions_phase_check", "retro_sessions", type_="check")
    op.create_check_constraint(
        "retro_sessions_phase_check",
        "retro_sessions",
        "phase = ANY (ARRAY['collect'::text, 'vote'::text, 'action'::text, 'closed'::text])",
    )


def downgrade() -> None:
    op.drop_constraint("retro_sessions_phase_check", "retro_sessions", type_="check")
    op.create_check_constraint(
        "retro_sessions_phase_check",
        "retro_sessions",
        "phase = ANY (ARRAY['collect'::text, 'group'::text, 'vote'::text, 'discuss'::text, "
        "'action'::text, 'closed'::text])",
    )
