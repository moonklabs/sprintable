"""story #2728(P0·과금) — platform_settings 테이블 신설.

선생님 기결정③ 집행: 금액·gating·노출 등 플랫폼 전역 가변값은 어드민에서 관리(코드 상수·env var
금지 — env var는 GCP 서비스 재배포가 있어야 바뀌어 "코드 배포 없이"를 못 만족한다).

release_notes(0142)와 동일 원칙 — 제품 전역(org 무관) 글로벌 테이블, 소수 행(설정 키 단위가
아니라 명시 컬럼 — 값 종류가 적고 타입이 제각각이라 key-value 스키마보다 명시 컬럼이 더
정직하다). **DDL owner = 이 OSS 백엔드 단독**(sprintable-admin/internal-api는 vendored-pin
모델로 이 테이블에 UPDATE만 하고 마이그를 만들지 않는다 — README.md 경계 원칙 그대로).

시드 1행(id 고정 UUID, 싱글턴 — 이 테이블은 정확히 1행만 갖는다는 게 설계 불변식): 둘 다
기본 False(선생님 결정② — Toss 심사 완료 前엔 결제 관련 어떤 것도 prod live 금지, 안전측
기본값). billing_price_public/billing_checkout_enabled를 별개 컬럼으로 분리한 이유는
그라운딩 문서(story #2728) ③ 참고 — 정보노출과 실제결제처리는 성격이 다른 축.

idempotent: 테이블 inspect 가드(시드는 create 직후만, release_notes 0142와 동일 패턴).

Revision ID: 0255
Revises: 0254
Create Date: 2026-08-18
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0255"
down_revision = "0254"
branch_labels = None
depends_on = None

_SINGLETON_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "platform_settings" in set(insp.get_table_names()):
        return  # idempotent

    op.create_table(
        "platform_settings",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        # story #2728③ — 가격 "표시"(정보 노출)와 "결제 진입"(실제 처리)을 별개 축으로 분리.
        # 둘 다 기본 false(Toss 심사 완료 前 prod 결제표면 전면 차단, 선생님 결정②).
        sa.Column("billing_price_public", sa.Boolean(), nullable=False,
                  server_default=sa.text("false")),
        sa.Column("billing_checkout_enabled", sa.Boolean(), nullable=False,
                  server_default=sa.text("false")),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )

    # 싱글턴 시드 1행(고정 id) — 컬럼 값 자체가 아니라 "정확히 1행"이 설계 불변식.
    op.execute(
        sa.text(
            "INSERT INTO platform_settings (id, billing_price_public, billing_checkout_enabled) "
            "VALUES (:id, false, false)"
        ).bindparams(id=_SINGLETON_ID)
    )


def downgrade() -> None:
    op.drop_table("platform_settings")
