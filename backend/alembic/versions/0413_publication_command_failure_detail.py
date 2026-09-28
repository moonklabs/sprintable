"""story #4336(PO 05:24Z 조건 2) — 발행 명령 워커가 «요청 때와 같은 오류 본문»을 명령에 남기는 칸.

즉시 발행은 요청 안에서 공급자 호출 전 검사(preflight)만 하고 대기열에 넣는다. 그 사이 예산 소진 · 할당량 · 글자 수 조건이 바뀌어
워커의 같은 검사에서 걸리면, 요청이 돌려줬을 오류 본문(코드 · 숫자 · 풀리는 시각)을 그대로 이 JSON 칸에 적어 화면이 같은 배너를
그린다(«실패 배지만 · 숫자 없음» 금지). 명령이 다시 대기열에 오르거나 끝나면 비운다.

번호: 착지 순 사다리(PO 08:31Z) — 0411 = #4713(4341 운영자 알림) · 0412 = #4715(4332 인덱스) · 이 파일 0413(down 0412).

Revision ID: 0413
Revises: 0412
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0413"
down_revision = "0412"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("publication_commands", sa.Column("failure_detail", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("publication_commands", "failure_detail")
