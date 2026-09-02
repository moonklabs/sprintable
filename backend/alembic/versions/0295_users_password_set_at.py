"""story #3247(PO QA 지적, 카디르+codex 실증) — totp/disable의 password 재검증 우회체인
차단용 신호 신설.

카디르+codex가 실HTTP+실PG로 증명한 공격: OAuth 전용 계정(비밀번호 없음)의 탈취
세션/API키로 ①set-password(재인증 0, 별건 ab2a503f)로 방금 비밀번호를 심고 →
②그 방금 심은 비밀번호를 totp/disable에 제출 → ③서버가 정상 재검증으로 인정해
2FA를 해제한다 — 독립 자격증명 0으로 뚫린다.

이 컬럼은 "그 비밀번호가 지금 세션(토큰 iat)보다 먼저 존재했는가"를 서버가 판별할
수 있게 하는 최소 신호다. nullable — 이 마이그레이션 전에 이미 비밀번호를 가진
기존 유저는 이 제약의 대상이 아니다(0290 locale과 동형 논지 — 과거 시점을 아는
방법이 없어 백필은 거짓 신호. NULL은 "제약 이전부터 있던 것으로 신뢰"로 해석되며
0290의 nullable=제약 없음과 정확히 대칭). set-password/change-password/reset-password
가 앞으로 이 컬럼을 갱신한다(코드 변경, 이 마이그레이션 범위 밖).

Revision ID: 0295
Revises: 0294
Create Date: 2026-08-30

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0295"
down_revision = "0294"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("password_set_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "password_set_at")
