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


def upgrade() -> None:
    bind = op.get_bind()
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
