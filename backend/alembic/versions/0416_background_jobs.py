"""story #4336 PR2(PO 04:32Z) — 요청 한도를 넘을 수 있는 일을 cron 워커가 이어서 하는 공용 작업 줄(`background_jobs`).

첫 종류 = `channel_video_confirm`(채널 영상 확인 — 크기 상한이 어댑터 최대라 시간 근거가 없어 작업화). 다음 PR(② 첨부 변환 ·
컨텍스트팩 · 회고 종합)이 종류를 더할 때 `ck_background_jobs_kind`를 같이 넓힌다. 모델 = `app/models/background_job.py`.

번호: 착지 순 사다리 — 0414 = #4760(4303) · 0415 = 디디 4299 ② · 이 파일 0416(down 0415). 앞 PR이 들어가기 전까지 fresh DB RED 예상.

Revision ID: 0416
Revises: 0415
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0416"
down_revision = "0415"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "background_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("result", postgresql.JSONB(), nullable=True),
        sa.Column("error", postgresql.JSONB(), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("requested_by_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('channel_video_confirm')", name="ck_background_jobs_kind"),
        sa.CheckConstraint("status IN ('pending', 'in_progress', 'completed', 'failed')", name="ck_background_jobs_status"),
    )
    op.create_index("ix_background_jobs_org_id", "background_jobs", ["org_id"])
    op.create_index(
        "ix_background_jobs_due", "background_jobs", ["created_at"],
        postgresql_where=sa.text("status IN ('pending', 'in_progress')"),
    )


def downgrade() -> None:
    op.drop_index("ix_background_jobs_due", table_name="background_jobs")
    op.drop_index("ix_background_jobs_org_id", table_name="background_jobs")
    op.drop_table("background_jobs")
