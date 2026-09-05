"""story #3506(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — UTM 귀속 집계 조각②.
`org_pageview_utm_daily` 신설 — beacon이 utm_* 4키를 실었을 때만(적어도 하나라도
있을 때) (org_id, path, day, utm_source, utm_medium, utm_campaign, utm_content) 축으로
일별 upsert 집계한다(`org_pageview_daily`의 (org_id, path, day) 골격과 동형·PO 決定 (d)).

utm_* 4컬럼은 NOT NULL + 빈 문자열 기본값이다(NULL 아님) — Postgres UNIQUE 제약은
NULL을 서로 다른 값으로 취급해 (org_id, path, day, NULL, NULL, NULL, NULL) 조합이
매번 새 행을 만들어버린다(집계가 아니라 매 요청마다 증식). 이 4컬럼은 «측정값»이
아니라 «그룹핑 키»라 null≠0 원칙(정규화 metric 값 규약)의 적용 대상이 아니다 —
빈 문자열은 "그 차원이 이번 요청에 없었다"는 그룹 키로만 쓰인다.

페드루 PO 리뷰(2026-09-05, PR#3855) — 최초 버전은 `utm_content` 단독 인덱스를 열었으나
(A) 決定(조각③, hosted_site clicks=org_id+path 합산·utm_content 값 매칭 없음)으로
그 접근 패턴 자체가 없어졌다(폐기된 전제 위의 인덱스, raw 저장만·소비자 0) — 제거.
breakdown 세부조회(story 후속)가 실제로 그 축을 쓰게 되면 그때 연다.

Revision ID: 0336
Revises: 0335
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0336"
down_revision = "0335"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "org_pageview_utm_daily",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("utm_source", sa.Text(), nullable=False, server_default=""),
        sa.Column("utm_medium", sa.Text(), nullable=False, server_default=""),
        sa.Column("utm_campaign", sa.Text(), nullable=False, server_default=""),
        sa.Column("utm_content", sa.Text(), nullable=False, server_default=""),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint(
            "org_id", "path", "day", "utm_source", "utm_medium", "utm_campaign", "utm_content",
            name="uq_org_pageview_utm_daily_grouping",
        ),
    )
    # story #3506(e)/(A) 決定 — clicks 계산(조각③)은 org_id+path로 합산한다(위 UNIQUE
    # 제약의 선두 두 컬럼이 이미 그 조회를 받친다). utm_content 단독 lookup 경로는
    # 없어(raw 저장만) 별도 인덱스 불필요(PR#3855 리뷰로 제거).


def downgrade() -> None:
    op.drop_table("org_pageview_utm_daily")
