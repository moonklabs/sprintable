"""webhook_configs.member_id 축 보정: users.id → org_member.id (휴먼 config)

#1726 의 `_get_caller_member_id` 가 `canonicalize(auth.user_id)` = **users.id** 축으로 휴먼 webhook
config 를 저장/스코프해, 디스패치(conversation_participants.member_id = org_member.id 축)와 불일치 →
webhook silent 미배달. 코드는 `resolve_member().id`(휴먼=org_member.id·에이전트=team_member.id) 로 수정.
이 마이그는 그 사이 users.id 축으로 저장된 휴먼 config 를 org_member.id 로 **1회 보정**한다.

- **idempotent**: 보정 후 member_id = org_member.id 라 `om.user_id = wc.member_id` 조인이 다시 안 잡힘.
- **에이전트 무접촉**: agent config(member_id = team_member.id)는 org_members.user_id(=users.id)와 안
  맞아 매칭 0 → 보정 대상 아님(무회귀).
- **이미-정상 무접촉**: 기존 org_member.id 축 config 도 조인 0 → 무접촉.
- org-scope 조인(`om.org_id = wc.org_id`)으로 cross-org 오매핑 차단.

Revision ID: 0138
Revises: 0137
"""
from alembic import op

revision = "0138"
down_revision = "0137"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE webhook_configs wc
        SET member_id = om.id
        FROM org_members om
        WHERE om.user_id = wc.member_id
          AND om.org_id = wc.org_id
        """
    )


def downgrade() -> None:
    # 데이터 보정 — 원 users.id 가 소실되어 역보정 불가. forward-only no-op.
    pass
