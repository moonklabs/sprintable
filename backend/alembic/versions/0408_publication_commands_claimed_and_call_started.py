"""story #4287 — 워커가 in_progress로 집은 뒤 죽은 발행 명령의 회수(PO 00:16Z 확정 설계).

- `claimed_at`: 워커가 in_progress로 집은 시각. 회수 쓸기의 «상한 시간 넘게 집힌 채» 기준.
- `provider_call_started_at`: 공급자 쓰기 직전 서비스 코드가 쓰고 커밋하는 영속 표식(집을 때 비운다). 있으면 나갔는지 모름 →
  needs_check, 없으면 호출 전 확실 → 자동 재시도.
- 부분 인덱스 `ix_publication_commands_in_progress_claimed` — 쓸기가 in_progress 행만 본다(틱마다 한 번).

두 칸 다 NULL 허용 · 기본값 없음 — 이 마이그 전에 집힌 in_progress 행은 `claimed_at`이 NULL이라 회수가 «호출 전 확실»로 읽지 않고
needs_check로 보낸다(PO ③). 소급 채우기 없음.

CONCURRENTLY 미사용(0217 · 0384 · 0406 선례) — 부분조건으로 in_progress 행만 담아 빌드 대상이 작다.

번호: 착지 순 사다리 — develop 머리 0407 위. 다른 열린 브랜치에 0408 이상 없음(00:17Z 원격 브랜치 전수 확인).

Revision ID: 0408
Revises: 0407
"""
import sqlalchemy as sa

from alembic import op

revision = "0408"
down_revision = "0407"
branch_labels = None
depends_on = None

_INDEX_NAME = "ix_publication_commands_in_progress_claimed"


def upgrade() -> None:
    op.add_column("publication_commands", sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("publication_commands", sa.Column("provider_call_started_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        _INDEX_NAME, "publication_commands", ["claimed_at"], unique=False,
        postgresql_where=sa.text("status = 'in_progress'"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="publication_commands")
    op.drop_column("publication_commands", "provider_call_started_at")
    op.drop_column("publication_commands", "claimed_at")
