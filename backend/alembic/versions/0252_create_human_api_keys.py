"""create human_api_keys table

Revision ID: 0252
Revises: 0251
Create Date: 2026-08-16

story #1940 — 휴먼 개인 API 키 셀프서브 발급. PO 판정(2026-08-16, A안): agent_api_keys
테이블/ApiKey 모델은 재사용하지 않는다 — app/dependencies/auth.py:131 코멘트("api_key
경로 = 에이전트 인증, 휴먼은 JWT")가 문서가 아니라 실제 강제되는 설계(member_ssot_apikey_cut
경로는 Member.type=="agent"를 명시로 걸어 휴먼 소유 키를 401로 거부하도록 이미 짜여 있음)
+ #1561 교훈("api_key_id 존재=agent" 신뢰 신호)이 이미 여러 보안결정 지점에 퍼져 있어,
그 불변식을 재사용으로 흔들면 이 스토리 하나로 전수 감사를 떠안게 된다. 완전히 별도
테이블+접두사(hu_live_, sk_live_와 구분)+별도 인증 해소 경로로 간다 — 기존 agent_api_keys
소비처는 0줄 접촉.

member_id는 members.id를 가리키되(canonical SSOT), scope 컬럼은 두지 않는다(휴먼 개인 키는
"이 휴먼 그대로"의 접근 권한을 그대로 쓴다 — agent처럼 tool-group scope로 축소하는 축이
아니다, 스토리 스코프).
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0252"
down_revision = "0251"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "human_api_keys",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("member_id", UUID(as_uuid=True), sa.ForeignKey("members.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.Text, nullable=True),
        sa.Column("key_prefix", sa.Text, nullable=False),
        sa.Column("key_hash", sa.Text, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_human_api_keys_member_id", "human_api_keys", ["member_id"])
    op.create_index("ix_human_api_keys_key_hash", "human_api_keys", ["key_hash"])


def downgrade() -> None:
    op.drop_table("human_api_keys")
