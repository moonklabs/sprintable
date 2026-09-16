"""기기별 자격증명 테이블 `agent_device_credentials` — `sk_live_*`(org 전역 장수명 bearer)의
blast radius를 좁힌다. 노트북 1대를 잃으면 org 전체 키를 회전해야 하고 그 회전이 연결된
모든 에이전트를 끊던 것을, **기기 단위 폐기**(revoke 1대 = 그 기기만 끊김)로 바꾼다.

⚠️평문/파생 비밀 컬럼이 없다 — 공개키(DER)만 저장하고 개인키는 서버에 오지 않는다.
`agent_api_keys`/`human_api_keys` 가 가진 `key_hash`/`key_prefix` 에 해당하는 컬럼을
의도적으로 두지 않는다(탈취할 장수명 bearer 비밀이 애초에 존재하지 않는다).

`member_id` = 등록한 휴먼(폐기 권한 축), `agent_member_id` = 이 자격증명으로 인증되는
에이전트. 둘 다 members.id — 0075 1:1 불변식(members.id = team_member.id)으로
`_resolve_api_key` 의 신원 해소와 같은 id 공간이다.

`last_server_seq` 는 리플레이 방어용 서버 발급 단조 증가 카운터(compare-and-set) —
`device_installations.last_server_seq` 와 동형 의미론.

`key_fingerprint` 부분 인덱스는 인증 hot-path가 **active 행만** 조회하기 때문이다(폐기된
기기는 후보에서 아예 빠져야 한다 — revoked 행이 인덱스에 남아 스캔을 늘릴 이유가 없다).

Revision ID: 0379
Revises: 0378
Create Date: 2026-09-15

⚠️ 0375 로 시작했다가 develop 이 같은 번호를 선점해(0375~0378 체인) 0379 로 재번호했다.
   develop 의 0375_status_changed_verdict_optional_fields 와 revision ID 가 «중복»이면
   alembic 멀티헤드가 되어 `alembic upgrade heads`(bootstrap.py 가 실행)가 깨진다.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0379"
down_revision = "0378"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_device_credentials",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "member_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("members.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "agent_member_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("members.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("device_label", sa.Text(), nullable=False),
        sa.Column("public_key_der", sa.LargeBinary(), nullable=False),
        sa.Column("key_fingerprint", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_server_seq", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "member_id", "device_label", name="uq_agent_device_credentials_member_label"
        ),
    )
    op.create_index("ix_agent_device_credentials_member_id", "agent_device_credentials", ["member_id"])
    op.create_index(
        "ix_agent_device_credentials_agent_member_id", "agent_device_credentials", ["agent_member_id"]
    )
    op.create_index(
        "ix_agent_device_credentials_key_fingerprint_active",
        "agent_device_credentials", ["key_fingerprint"],
        postgresql_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    op.drop_index("ix_agent_device_credentials_key_fingerprint_active", table_name="agent_device_credentials")
    op.drop_index("ix_agent_device_credentials_agent_member_id", table_name="agent_device_credentials")
    op.drop_index("ix_agent_device_credentials_member_id", table_name="agent_device_credentials")
    op.drop_table("agent_device_credentials")
