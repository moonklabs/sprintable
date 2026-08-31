"""story #1969(2026-08-30, PO 최종 판정) — inbox_items(A2-MIN decision) 기능 완전 은퇴.

실측 3종(dev 재고 0·신규 유입 dead·원 목표는 Gate/결재함 트랙이 이미 대체)으로 PO가
완전 폐기를 확定(선생님 확定 불요 — 데이터로 갈리는 제품 판단·역행 가능). 라우터/모델/
BFF/시크릿 등 코드 참조는 이 마이그와 별개 커밋에서 전부 제거 완료(참조 grep 0 수렴
확認 済).

⛔prod 재고 실측 게이트 — 저자(디디)는 dev 전용 세션이라 prod DB에 접근 권한이 없다
(feedback_no_prod_access_no_prod_claims). dev에서 0건을 확인했다고 prod도 0건이라고
단정하지 않는다 — 이 마이그가 실제로 prod에 적용되는 순간(cloudbuild.yaml 자동 실행,
fail-closed) 그 시점의 실 row 수를 직접 세어 분기한다: 0건이면 즉시 drop, 1건 이상이면
데이터를 잃지 않도록 `inbox_items_archived_1969`로 rename만 하고 drop은 보류(사람이
필요 시 별도로 덤프·정리).

Revision ID: 0293
Revises: 0292
Create Date: 2026-08-30

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0293"
down_revision = "0292"
branch_labels = None
depends_on = None

_ARCHIVE_TABLE = "inbox_items_archived_1969"


# 카디르 QA 3라운드(2026-08-30, 페드루 정정) — moonklabs 실 Supabase DB에는 Operator
# Cockpit Phase A RPC 3종(resolve/dismiss/reassign_inbox_item, packages/db/supabase/
# migrations/20260426170300_inbox_resolve_fn.sql)이 `RETURNS public.inbox_items`
# composite 타입 의존으로 남아 있어 DROP TABLE이 DependentObjectsStillExist로 거부된다
# (disposable PG에 그 SQL을 실제로 심어 재현 확認). CASCADE 대신 명시 DROP FUNCTION —
# 혹시 다른 미확인 의존이 있으면 CASCADE처럼 조용히 삼키지 않고 크게 실패해야 한다.
# 호출부는 레포 전체 0건(rpc 호출 grep 0) — 순수 정리, 기능 손실 없음.
# validate_inbox_item_from_agent는 inbox_items 자신의 트리거 함수(생성 파일:
# 20260426170000_inbox_items.sql) — 테이블 drop이 트리거는 같이 지워도 함수 객체는
# 안 지워 고아로 남기므로 트리거를 먼저 명시 제거한 뒤 같이 정리한다.
_LEGACY_RPC_FUNCTIONS = (
    "resolve_inbox_item",
    "dismiss_inbox_item",
    "reassign_inbox_item",
)
_LEGACY_TRIGGER_FUNCTIONS = ("validate_inbox_item_from_agent",)


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "DROP TRIGGER IF EXISTS trg_inbox_items_validate_agent ON inbox_items"
    ))
    for fn in _LEGACY_RPC_FUNCTIONS + _LEGACY_TRIGGER_FUNCTIONS:
        bind.execute(sa.text(f"DROP FUNCTION IF EXISTS public.{fn}"))
    # 자체호스팅(packages/db/supabase) 스키마 실측(disposable PG 재현)으로 발견 — 그
    # 스키마의 inbox_outbox.inbox_item_id는 실 FK로 inbox_items를 참조한다. 이 SaaS
    # 스키마(baseline schema.sql)엔 그 FK가 없는 것으로 보이나, 그 파일 자체가 알려진
    # stale 덤프(test_check_env_drift 이력 참고)라 확신할 수 없다 — 0293이 0294보다
    # 먼저 도는 고정 순서(down_revision 체인)라도 FK가 실재하면 안전하도록, 있으면 그
    # 제약만(테이블 자체는 안 건드림) 선제 제거한다. IF EXISTS라 없으면 완전 무해.
    bind.execute(sa.text(
        "ALTER TABLE IF EXISTS inbox_outbox "
        "DROP CONSTRAINT IF EXISTS inbox_outbox_inbox_item_id_fkey"
    ))
    count = bind.execute(sa.text("SELECT COUNT(*) FROM inbox_items")).scalar_one()
    if count == 0:
        op.drop_table("inbox_items")
    else:
        # 재고가 있으면(dev 실측 0과 다른 환경) 데이터를 지어내지 않고 보존만 한다 — 실
        # 처분(덤프·이관)은 사람 판단으로 별도 진행.
        op.rename_table("inbox_items", _ARCHIVE_TABLE)


def downgrade() -> None:
    # 코드(InboxItem 모델·라우터·리포지토리 전부)가 이미 다른 커밋에서 제거됐다 — 테이블만
    # 되살려도 그걸 쓰는 앱 코드가 없어 반쪽 상태다. upgrade가 drop한 경우 원 스키마
    # 재구성은 무의미(재고 0으로 확인됐던 빈 테이블), rename한 경우 수동으로
    # `ALTER TABLE inbox_items_archived_1969 RENAME TO inbox_items`만 되돌리면 된다
    # (자동화 안 함 — 그 시점 운영자가 실제로 되돌릴 필요가 있는지 판단해야 하는 자리).
    pass
