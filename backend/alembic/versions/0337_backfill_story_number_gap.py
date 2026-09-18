"""story #3505(위생·BE·소형, 디디 3502 그라운딩 부수 발견, 2026-09-05) — 기존 story_
number NULL 행 백필. `recipe_repeat_scheduler.py::_create_next_story`가
`allocate_story_number()`를 안 부르고 Story를 직접 생성해 온 자리가 뿌리(같은 커밋의
코드 fix가 향후 신규 행은 막는다) — 이 마이그는 이미 벌어진 NULL 행만 정정한다.

방향: 프로젝트별로 NULL 행에 그 프로젝트의 «지금 있는 최대 story_number»(COALESCE 0)
이어서 순번을 매긴다(created_at, id 순 — 결정적). 중복 0(다른 프로젝트끼리 값 공간이
안 겹친다, allocate_story_number() 자체가 project_id 스코프인 것과 동형).

되돌릴 수 없음(downgrade는 no-op) — 백필 이전에 NULL이었다는 사실 자체가 "번호가
없었다"는 뜻이라, 되돌린다는 것은 다시 NULL로 만드는 것뿐인데 그 사이 실제로 그
story_number를 참조하는 새 행(대화 링크 등)이 생겼을 수 있어 안전하지 않다 — no-fiction
원칙, 순방향 정정만.
"""
from __future__ import annotations

from alembic import op

revision = "0337"
down_revision = "0336"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        WITH null_rows AS (
            SELECT id, project_id,
                   ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn
            FROM stories
            WHERE story_number IS NULL
        ),
        project_max AS (
            SELECT project_id, COALESCE(MAX(story_number), 0) AS max_num
            FROM stories
            GROUP BY project_id
        )
        UPDATE stories
        SET story_number = project_max.max_num + null_rows.rn
        FROM null_rows
        JOIN project_max ON project_max.project_id = null_rows.project_id
        WHERE stories.id = null_rows.id
        """
    )


def downgrade() -> None:
    pass
