"""docs.slug_locked 영구 server_default false — 0107 deploy-window 하드닝.

0107 이 `slug_locked` 를 NOT NULL 로 추가한 뒤 server_default 를 제거했다. 그 결과 **migrate-first**
배포 순서(권장)에서 신 컬럼은 생겼으나 default 가 없어, 아직 갱신 안 된 **구 코드가 slug_locked 를
지정하지 않고 docs INSERT** 하면 NOT NULL 위반으로 doc 생성이 실패하는 전환 윈도우가 생긴다.

영구 server_default(false) 를 부여하면:
- migrate-first: 구 코드 INSERT(slug_locked 미지정) → DB default false 채움 → 무사.
- code-first: 신 코드가 컬럼 read → 컬럼 이미 존재 → 무사.
→ 양 방향 전환 윈도우 0. 앱은 여전히 모델 default=False 를 명시하므로 동작 불변(순수 안전판).

0107 은 이미 dev 적용돼 수정 불가 → 신규 마이그가 정도(PO GO). #1368(0108)과 같은 migrate-dev
윈도우에 함께 태운다(0107→0108→0109 선형).

Revision ID: 0109
Revises: 0108
Create Date: 2026-06-10
"""
import sqlalchemy as sa
from alembic import op

revision = "0109"
down_revision = "0108"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("docs", "slug_locked", server_default=sa.false())


def downgrade() -> None:
    op.alter_column("docs", "slug_locked", server_default=None)
