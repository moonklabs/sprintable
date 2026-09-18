"""org_connector_registry.kinds — story #3317(마케팅자동화·레시피 결함, PO 확定 2026-09-02).

미르코군 플러그인 wire가 describe_connector에 `kinds: string[]`(예: threads=['publish',
'measure'])를 추가한다(0.8.1). connector_key 없이 레시피 정의의 `capability.kind`만으로
"이 org에 그 kind를 만족하는 커넥터가 있는가"를 찾으려면 각 등록에 그 커넥터가 지원하는
kind 목록이 있어야 한다 — additive nullable 컬럼(기존 행은 NULL=kinds 정보 없음, apply
검증에서 "그 kind 미지원"과 동일하게 취급, 지어내지 않음).

idempotent: IF NOT EXISTS — 재실행·fresh DB 안전.
"""
from alembic import op

revision = "0300"
down_revision = "0299"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE org_connector_registry ADD COLUMN IF NOT EXISTS kinds jsonb NULL"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE org_connector_registry DROP COLUMN IF EXISTS kinds")
