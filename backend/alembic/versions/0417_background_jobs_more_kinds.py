"""story #4336 PR2 ②(PO 04:32Z) — 공용 작업 줄(`background_jobs`)에 종류 셋을 더한다: 첨부 변환(요청 안 40s 예산을 넘기면) ·
컨텍스트팩(캐시 미스 · LLM 사슬) · 회고 종합/추천(늘 LLM). 체크 제약만 넓힌다(행 · 칸 변화 0).

번호: 0416 = #4773(PR2 ①) 다음. 앞 PR이 들어가기 전까지 fresh DB RED 예상.

Revision ID: 0417
Revises: 0416
"""
from alembic import op

revision = "0417"
down_revision = "0416"
branch_labels = None
depends_on = None

_NEW = "kind IN ('channel_video_confirm', 'attachment_convert', 'loop_context_pack', 'retro_synthesis')"
_OLD = "kind IN ('channel_video_confirm')"


def upgrade() -> None:
    op.drop_constraint("ck_background_jobs_kind", "background_jobs", type_="check")
    op.create_check_constraint("ck_background_jobs_kind", "background_jobs", _NEW)


def downgrade() -> None:
    # 새 종류 행이 남아 있으면 옛 제약을 걸 수 없다 — 끝난 · 실패한 작업 기록이라 지워도 화면 계약에 영향 없음(결과는 원 테이블에 있음).
    op.execute("DELETE FROM background_jobs WHERE kind <> 'channel_video_confirm'")
    op.drop_constraint("ck_background_jobs_kind", "background_jobs", type_="check")
    op.create_check_constraint("ck_background_jobs_kind", "background_jobs", _OLD)
