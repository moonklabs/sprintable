"""story #3806(Phase3·3-2 PR 6 정정, 페드루 PO 定 2026-09-11 13:42Z) — 「누가
시작했나」 두 세계 처방. 자동 워커(`process_due_ads_boost_starts`)와 사람의
「홍보 시작」 버튼이 같은 `boost_start` command 행으로 수렴하는데(멱등 upsert),
`requested_by_member_id`만으로는 구분이 안 된다 — 승인자 본인이 직접 클릭하면
자동 워커가 채운 값(`gate.resolver_id`)과 똑같아진다.

`initiated_by`: 'scheduler'|'human', nullable(기존 행은 이 정보를 몰라 null —
지어내지 않는다, 이 스토리 이전 데이터 없음이라 실질 영향 0이지만 원칙은 유지).
`publication_commands`에 얹는다(`AdsBoostRun`이 아니라) — «이 요청이 어떻게
왔나»는 요청 원장(command)의 속성이지, 실행 결과 상태(run)의 속성이 아니다.

Revision ID: 0367
Revises: 0366
Create Date: 2026-09-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0367"
down_revision = "0366"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "publication_commands",
        sa.Column("initiated_by", sa.Text(), nullable=True),
    )
    op.create_check_constraint(
        "ck_publication_commands_initiated_by",
        "publication_commands",
        "initiated_by IS NULL OR initiated_by IN ('scheduler', 'human')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_publication_commands_initiated_by", "publication_commands", type_="check")
    op.drop_column("publication_commands", "initiated_by")
