"""story #1969 확장(2026-08-30, 카디르 QA — 페드루 승인) — inbox_outbox 은퇴.

0293(inbox_items 완전 은퇴) 검산에서 «inbox_items/InboxItem» 자구만 재느라 형제
결합체를 놓쳤다 — `inbox_outbox`는 inbox_item 라이프사이클 이벤트(resolved/dismissed/
reassigned)를 webhook으로 배달하는 직접결합 companion 큐(inbox_item_id 컬럼+색인,
`idx_inbox_outbox_inbox_item_id`)다. 소비 라우터(`GET /api/v2/internal/cron/
inbox-outbox`, backend/app/routers/cron.py)는 "현재 SQLAlchemy 기반 구현에서는
no-op(Supabase pg_cron 대체)"라는 자기 문서화 주석대로 실제 처리 로직이 없는 항상-200
스텁이었다 — inbox_items와 동형으로 코드는 살아있었으나 기능은 죽어 있던 것. 그 라우터
+ web BFF(`apps/web/src/app/api/cron/inbox-outbox`)는 별도 커밋에서 이미 제거.

Revision ID: 0294
Revises: 0293
Create Date: 2026-08-30

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0294"
down_revision = "0293"
branch_labels = None
depends_on = None

_ARCHIVE_TABLE = "inbox_outbox_archived_1969"


def upgrade() -> None:
    # 0293과 동일 문법 — 저자는 dev 전용이라 prod를 단정 안 함(feedback_no_prod_access_
    # no_prod_claims). 이 마이그가 실제로 prod에 적용되는 순간 그 시점의 실 row 수를 직접
    # 세어 분기한다.
    bind = op.get_bind()
    count = bind.execute(sa.text("SELECT COUNT(*) FROM inbox_outbox")).scalar_one()
    if count == 0:
        op.drop_table("inbox_outbox")
    else:
        op.rename_table("inbox_outbox", _ARCHIVE_TABLE)


def downgrade() -> None:
    # 0293과 동형 이유로 자동화 안 함 — 코드(cron 라우터·BFF)가 이미 다른 커밋에서
    # 제거돼 테이블만 되살려도 반쪽 상태. rename된 경우 수동으로
    # `ALTER TABLE inbox_outbox_archived_1969 RENAME TO inbox_outbox`만 되돌리면 된다.
    pass
