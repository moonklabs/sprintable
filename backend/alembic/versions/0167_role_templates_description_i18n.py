"""E-RECRUIT S24(story 25e8828d) — role_templates.description_i18n 병행 JSONB 컬럼.

Revision ID: 0167
Revises: 0166
Create Date: 2026-07-09

선생님 결정 B(2026-07-09, 카탈로그 카드 완전 KO) — 유나 dev 스모크가 카탈로그 카드
(description)가 영어 단일이라 KO 워크스페이스에서도 항상 영어로 뜨는 걸 발견. role_behaviors
는 이미 0164(role_behaviors_i18n)로 이 문제를 풀었으니 description도 동형 병행 컬럼.

**role_behaviors_i18n과 오버레이 방향이 반대**임에 주의 — role_behaviors_i18n은 "ko가
canon(레거시 Text 컬럼) → en을 오버레이로 채운다"(role_behaviors 원본이 한글). 반면 신규
80직군 카탈로그의 description은 애초에 **영어로 저작**됐다(원본이 이미 영어) — 그래서
description_i18n은 "en(=description 원문)이 canon → **ko를 오버레이로 채운다**"가 맞다.
소비 코드는 `description_i18n.get(locale) or description`(role_behaviors_i18n과 동일
폴백 함수 재사용) — locale="ko"인데 아직 ko 콘텐츠가 없는 행은 자동으로 기존 영어
description으로 무회귀 폴백(정확히 지금 상태 유지, 회귀 0).

스키마만(콘텐츠 데이터 아님) — [[no-pr-for-data]] 게이트 무관. 순수 additive(기존
description Text 컬럼 무변경) — 기존 데이터 백필 없음(빈 dict 시작, PO 병행 저작·주입은
internal-api enrichment 경로로 별도 무-PR 처리, S23 화이트리스트 확장과 짝).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0167"
down_revision = "0166"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "role_templates",
        sa.Column(
            "description_i18n", postgresql.JSONB(astext_type=sa.Text()),
            nullable=False, server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("role_templates", "description_i18n")
