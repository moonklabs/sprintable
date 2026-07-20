"""story #1939 QA fix(까심 REQUEST_CHANGES): uq_asset_folders_parent_name → NULLS NOT DISTINCT.

배경: 기존 `UNIQUE (org_id, project_id, parent_id, name)`는 PG 기본이 NULLS DISTINCT라
project_id/parent_id 중 하나라도 NULL이면 DB 제약 자체가 발동하지 않는다(NULL <> NULL 항상
무충돌). 폴더 생성 가능한 4개 조합 중:
  (a) root(project_id·parent_id 둘 다 NULL)
  (b) project_id SET + parent_id NULL — 프로젝트 최상위 폴더(핵심 시나리오)
  (c) project_id NULL + parent_id SET(org-level 중첩)
  (d) project_id·parent_id 둘 다 non-NULL — 기존 제약이 실제로 발동하는 유일 조합
(a)(b)(c) 세 조합에서 app-level 사전조회(assets.py create_folder)가 붙잡지 못하는 동시 요청
레이스는 중복 폴더를 조용히 2건 생성할 수 있었다(TOCTOU). PG15+(dev/prod Cloud SQL 둘 다
POSTGRES_15 실측 확인)의 `UNIQUE NULLS NOT DISTINCT`로 교체해 4개 조합 전부 DB 레벨에서
방어한다 — NULL도 값으로 취급해 동일 (org_id, project_id, parent_id, name) 조합을 유일하게
강제.

컬럼 구성은 기존 제약과 동일(org_id, project_id, parent_id, name) — 바뀌는 건 NULL 처리
방식뿐이라 별도 데이터 백필 불요. 단, upgrade 시점에 기존 NULL-조합 중복 row가 이미 있다면
ADD CONSTRAINT가 실패한다(의도된 fail-closed — 조용히 넘어가지 않고 데이터 정합성 문제를
표면화).

Revision ID: 0198
Revises: 0197
Create Date: 2026-07-17
"""
from __future__ import annotations

from alembic import op

revision = "0198"
down_revision = "0197"
branch_labels = None
depends_on = None

_CONSTRAINT = "uq_asset_folders_parent_name"
_TABLE = "asset_folders"
_COLS = "org_id, project_id, parent_id, name"


def upgrade() -> None:
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT {_CONSTRAINT}")
    op.execute(
        f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CONSTRAINT} "
        f"UNIQUE NULLS NOT DISTINCT ({_COLS})"
    )


def downgrade() -> None:
    op.execute(f"ALTER TABLE {_TABLE} DROP CONSTRAINT {_CONSTRAINT}")
    op.execute(f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CONSTRAINT} UNIQUE ({_COLS})")
