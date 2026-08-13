"""[결제] story #2606: legal_document_versions 신설 — 약관/개인정보처리방침/환불정책 admin 버전관리.

pricing_versions(0146, E-ADMIN B1)와 동형 append-only 이력 테이블: 콘텐츠 값이 담긴 행은
절대 UPDATE되지 않는다. 새 버전이 생기면 새 행을 INSERT하고, 직전 "열린"(effective_to IS
NULL) 행의 effective_to를 새 행의 effective_from으로 닫는다.

pricing_versions와 다른 점 — doc_type(+locale)이 계보 키(tier/billing_cycle/currency 복합
키 불필요)라 partial unique index로 "doc_type×locale당 열린 행 최대 1개"를 DB가 직접
강제한다(pricing_versions엔 이 제약이 없어 서비스 레이어 로직에만 의존하는데, 이 테이블은
비용이 낮아 root-cause 가드를 추가한다 — 동시 두 CREATE 요청이 경합해도 두 번째가 unique
violation으로 즉시 실패, 침묵 데이터 오염 없음).

**locale(PO 지시, 2026-08-13)**: 사이트가 ko/en i18n이고 약관도 결국 두 언어가 될 것이라,
지금 재키잉하는 게 나중 마이그(기존 행 전부에 locale 백필+두 레포 모델/엔드포인트 재정의)보다
훨씬 싸다 — v1 콘텐츠는 ko 하나뿐이어도 스키마는 처음부터 doc_type×locale로 잡는다. 기본값
'ko'(NOT NULL) — 기존 관례 확장이 아니라 신설 테이블이라 nullable 과도기가 필요 없다.

이 마이그는 core 체인(main에도 존재) — pricing_versions와 달리 EE 전용이 아니다(약관은 모든
배포에 필요, dev OSS 모드 포함).

Revision ID: 0241
Revises: 0240
Create Date: 2026-08-13
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0241"
down_revision = "0240"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "legal_document_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("doc_type", sa.Text(), nullable=False),
        sa.Column("locale", sa.Text(), nullable=False, server_default="ko"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_format", sa.Text(), nullable=False, server_default="markdown"),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("effective_to", sa.DateTime(timezone=True), nullable=True),
        # operator email — internal-api L1 인증 principal(pricing_versions.created_by와 동형).
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint(
            "doc_type = ANY (ARRAY['terms'::text, 'privacy'::text, 'refund_policy'::text])",
            name="legal_document_versions_doc_type_check",
        ),
        sa.CheckConstraint(
            "locale = ANY (ARRAY['ko'::text, 'en'::text])",
            name="legal_document_versions_locale_check",
        ),
        sa.CheckConstraint(
            "content_format = ANY (ARRAY['markdown'::text, 'html'::text])",
            name="legal_document_versions_content_format_check",
        ),
        sa.CheckConstraint(
            "effective_to IS NULL OR effective_to > effective_from",
            name="legal_document_versions_effective_range_check",
        ),
    )
    # "현재 유효 버전" 조회 패턴(doc_type×locale당 최신 effective_from WHERE <= now())을 위한
    # 인덱스 — pricing_versions의 ix_pricing_versions_lineage_effective_from과 동형.
    op.create_index(
        "ix_legal_document_versions_type_effective_from",
        "legal_document_versions",
        ["doc_type", "locale", sa.text("effective_from DESC")],
    )
    # doc_type×locale당 열린(effective_to IS NULL) 행 최대 1개 — DB 레벨 가드(위 docstring 참조).
    op.create_index(
        "uq_legal_document_versions_open",
        "legal_document_versions",
        ["doc_type", "locale"],
        unique=True,
        postgresql_where=sa.text("effective_to IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_legal_document_versions_open", table_name="legal_document_versions")
    op.drop_index("ix_legal_document_versions_type_effective_from", table_name="legal_document_versions")
    op.drop_table("legal_document_versions")
