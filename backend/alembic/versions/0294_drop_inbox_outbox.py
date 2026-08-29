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

# 카디르 QA 3라운드(2026-08-30, 페드루 정정) — 0293과 동형 이유: moonklabs 실 Supabase
# DB에 남은 outbox claim/처리 RPC 4종(packages/db/supabase/migrations/
# 20260427100000_inbox_outbox_claim_fn.sql)이 `RETURNS public.inbox_outbox`
# composite(claim_pending_outbox는 SETOF) 의존이라 DROP TABLE을 거부한다. CASCADE 대신
# 명시 DROP FUNCTION. 호출부는 레포 전체 0건. touch_inbox_outbox_updated_at은 자신의
# 트리거 함수(생성 파일 20260426170200_inbox_outbox.sql) — 0293과 동형으로 트리거
# 먼저 명시 제거 후 같이 정리(고아 방지).
_LEGACY_RPC_FUNCTIONS = (
    "claim_pending_outbox",
    "mark_outbox_delivered",
    "mark_outbox_failed",
    "mark_outbox_dead",
)
_LEGACY_TRIGGER_FUNCTIONS = ("touch_inbox_outbox_updated_at",)


def upgrade() -> None:
    # 0293과 동일 문법 — 저자는 dev 전용이라 prod를 단정 안 함(feedback_no_prod_access_
    # no_prod_claims). 이 마이그가 실제로 prod에 적용되는 순간 그 시점의 실 row 수를 직접
    # 세어 분기한다.
    bind = op.get_bind()
    bind.execute(sa.text(
        "DROP TRIGGER IF EXISTS trg_inbox_outbox_touch_updated_at ON inbox_outbox"
    ))
    for fn in _LEGACY_RPC_FUNCTIONS + _LEGACY_TRIGGER_FUNCTIONS:
        bind.execute(sa.text(f"DROP FUNCTION IF EXISTS public.{fn}"))
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
