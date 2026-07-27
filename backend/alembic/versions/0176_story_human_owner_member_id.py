"""P0-03(story 23b9bdac·doc trust-pipeline-be-design §5) — stories.human_owner_member_id.

Revision ID: 0176
Revises: 0175
Create Date: 2026-07-13

"에이전트가 교체되어도 인간 책임과 승인 라인이 사라지지 않음" — Human owner를 기존
assignee_id/assignee_ids(혼합 human/agent 리스트)와 별도 필드로 분리. 순수 additive
nullable 컬럼 — 기존 story 전부 무영향, 백필 없음. agent_delegate_ids는 신규 저장 없이
기존 assignee_ids를 Member.type=="agent"로 필터한 파생 뷰(BE 서비스 레이어)로 충분하다.

⚠️ FK 의도적 미부여: member 참조는 team_members(VIEW, TeamMember 모델)/org_members
양쪽에 걸쳐 해소되는 값이라 단일 물리 테이블을 대상으로 한 DB-level FK가 성립하지
않는다(Gate.resolver_id·Evidence.created_by·Story.assignee_id와 동일 기존 패턴 — 전부
bare UUID 컬럼, app-level resolve_member_identity 검증만). members(앵커) 테이블은
"코드가 아직 읽지/쓰지 않는" 별도 토대(app/models/member.py 문서화)라 그걸 FK 타겟으로
쓰면 실제 회수되는 team_member id와 어긋난다.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0176"
down_revision = "0175"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "stories",
        sa.Column("human_owner_member_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("stories", "human_owner_member_id")
