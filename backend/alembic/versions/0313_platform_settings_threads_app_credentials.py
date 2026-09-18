"""story #3373(Phase1·마케팅운영, 페드루 PO 정정 2026-09-03 08:40Z) —
platform_settings.threads_platform_app_id/encrypted_app_secret.

블루프린트 §8: SaaS 기본은 공용 Threads(Meta) 앱, 조직별 자격(channel_app_credentials,
0312)은 옵션. 공용 앱 자격은 env var(threads_app_id/secret)가 아니라 어드민 관리값
(선생님 결정③, 0270/0282와 동일 선례)이라 이 싱글턴 테이블에 둔다. 둘 다 nullable —
시드값 없음(미설정 상태로 시작, 관리자가 채워야 공용 앱 fallback이 생긴다).

DDL owner = 이 백엔드(platform_setting.py 모듈 docstring 원칙) — 값을 실제로 채우는
UPDATE는 sprintable-admin/internal-api(require_operator) 몫, 이 리비전은 컬럼만 연다.

Revision ID: 0313
Revises: 0312
Create Date: 2026-09-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0313"
down_revision = "0312"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("platform_settings", sa.Column("threads_platform_app_id", sa.Text(), nullable=True))
    op.add_column(
        "platform_settings", sa.Column("threads_platform_encrypted_app_secret", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("platform_settings", "threads_platform_encrypted_app_secret")
    op.drop_column("platform_settings", "threads_platform_app_id")
