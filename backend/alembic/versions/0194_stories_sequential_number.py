"""story 9ac9b80f(FR·대표요청): stories에 프로젝트 스코프 사람-읽는 sequential #N 추가.

id(UUID)는 canonical PK로 그대로 유지 — story_number는 additive 참조 편의 컬럼
(project_id 내에서만 유일, PR/GitHub issue 넘버링과 동형). 신규 write는
app.repositories.story.allocate_story_number(advisory xact lock 기반 race-safe
채번)가 채운다.

기존 행 백필: (project_id, created_at, id) 순서로 프로젝트별 1부터 연속 채번(soft-delete된
행도 포함 — 번호는 GitHub issue처럼 재사용/스킵 없이 생성순 그대로 유지). set-based 단일
UPDATE(윈도우 함수)라 대상 규모와 무관하게 안전.

⚠️ nullable=True 유지(NOT NULL로 안 조인다): Story를 StoryRepository.create()/oss_seed 우회해
직접 ORM construct하는 기존 테스트 fixture가 리포지토리 전역에 51개 존재(이 스토리와 무관한
다른 에픽들) — NOT NULL로 조이면 전부 깨진다. 실 생성 경로(REST API·oss_seed) 둘 다 이미
allocate_story_number를 항상 호출하므로 실 데이터는 전부 non-null. Postgres UNIQUE는 NULL을
서로 다른 값으로 취급해 다건 NULL과 무충돌 공존(non-null 값끼리는 여전히 프로젝트 내 유일 강제).

Revision ID: 0194
Revises: 0193
Create Date: 2026-07-16
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0194"
down_revision = "0193"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("stories", sa.Column("story_number", sa.Integer(), nullable=True))

    op.execute(
        """
        UPDATE stories s
        SET story_number = sub.rn
        FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn
            FROM stories
        ) sub
        WHERE s.id = sub.id
        """
    )

    op.create_unique_constraint(
        "uq_stories_project_id_story_number", "stories", ["project_id", "story_number"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_stories_project_id_story_number", "stories", type_="unique")
    op.drop_column("stories", "story_number")
