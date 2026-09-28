"""story #4336 PR2 ②(PO 04:32Z) — 공용 작업 줄(`background_jobs`)에 종류 셋을 더한다: 첨부 변환(요청 안 40s 예산을 넘기면) ·
컨텍스트팩(캐시 미스 · LLM 사슬) · 회고 종합/추천(늘 LLM). 체크 제약을 넓힌다.

PO 10:39Z — 작업 중복 막기: `dedup_key`(nullable) + 부분 유일 인덱스 `uq_background_jobs_open_dedup`
(org_id, kind, requested_by_member_id, dedup_key) WHERE 대기 · 실행 중 · dedup_key 있음. 같은 사람이 같은 대상으로 다시 부르거나 두 요청이
동시에 와도 열린 작업은 하나(INSERT … ON CONFLICT DO NOTHING → 기존 작업). 요청한 본인만 작업을 보므로 사람이 키에 든다.

번호: 0416 = #4773(PR2 ①) 다음. 앞 PR이 들어가기 전까지 fresh DB RED 예상.

Revision ID: 0417
Revises: 0416
"""
import sqlalchemy as sa

from alembic import op

revision = "0417"
down_revision = "0416"
branch_labels = None
depends_on = None

_NEW = "kind IN ('channel_video_confirm', 'attachment_convert', 'loop_context_pack', 'retro_synthesis')"
_OLD = "kind IN ('channel_video_confirm')"


_OPEN_DEDUP_WHERE = "status IN ('pending', 'in_progress') AND dedup_key IS NOT NULL"


def upgrade() -> None:
    op.drop_constraint("ck_background_jobs_kind", "background_jobs", type_="check")
    op.create_check_constraint("ck_background_jobs_kind", "background_jobs", _NEW)
    op.add_column("background_jobs", sa.Column("dedup_key", sa.Text(), nullable=True))
    op.create_index(
        "uq_background_jobs_open_dedup", "background_jobs", ["org_id", "kind", "requested_by_member_id", "dedup_key"],
        unique=True, postgresql_where=sa.text(_OPEN_DEDUP_WHERE),
    )


def downgrade() -> None:
    # 새 종류 행이 남아 있으면 옛 제약을 걸 수 없다 — 끝난 · 실패한 작업 기록이라 지워도 화면 계약에 영향 없음(결과는 원 테이블에 있음).
    op.drop_index("uq_background_jobs_open_dedup", table_name="background_jobs")
    op.drop_column("background_jobs", "dedup_key")
    op.execute("DELETE FROM background_jobs WHERE kind <> 'channel_video_confirm'")
    op.drop_constraint("ck_background_jobs_kind", "background_jobs", type_="check")
    op.create_check_constraint("ck_background_jobs_kind", "background_jobs", _OLD)
