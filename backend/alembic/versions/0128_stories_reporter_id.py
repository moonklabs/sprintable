"""9f25e74a: stories.reporter_id(=creator) 추가 + audit 백필(no-guess).

보드 '내가 등록한'(reporter) 필터 지원. additive nullable 컬럼 — prod 코드(미인지) 무영향.
백필은 story_activities(activity_type='story_created')의 실 created_by(actor)로만 — ⚠️추측 일괄
백필 금지: create activity 없는 historical story 는 NULL 유지(실값 없으면 NULL). 신규 story 는
create 경로가 reporter_id 를 채운다.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0128"
down_revision = "0127"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("stories")}
    if "reporter_id" not in cols:
        op.add_column("stories", sa.Column("reporter_id", UUID(as_uuid=True), nullable=True))
        op.create_index("ix_stories_reporter_id", "stories", ["reporter_id"])
    # 백필(no-guess): story_created activity 의 실 created_by 만. 다중이면 가장 이른 것(DISTINCT ON).
    op.execute(
        """
        UPDATE stories s SET reporter_id = sub.actor
        FROM (
            SELECT DISTINCT ON (story_id) story_id, created_by AS actor
            FROM story_activities
            WHERE activity_type = 'story_created'
            ORDER BY story_id, created_at ASC
        ) sub
        WHERE sub.story_id = s.id AND s.reporter_id IS NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_stories_reporter_id")
    op.drop_column("stories", "reporter_id")
