"""story #4297(까디르 판정) — 활동 스트림 최신순 커서(order=desc · before_seq)가 읽는 정렬에 인덱스를 얹는다.

조회: `WHERE org_id = :org [AND project_id = :proj] [AND activity_seq < :before] ORDER BY activity_seq DESC LIMIT n`.
activity_events 인덱스(0116)는 전부 `occurred_at DESC` 꼬리라 activity_seq 순서를 못 준다 — 없으면 한 조직(또는 프로젝트)의 활동을
전부 읽어 정렬한 뒤 잘랐다(계속 쌓이는 표 · 바쁜 조직일수록 느려짐). 두 인덱스로 커서 한 쪽이 인덱스 역순 훑기 + LIMIT가 된다:
- `(org_id, activity_seq DESC)` — 프로젝트 필터 없는 조회(에이전트 team-context).
- `(org_id, project_id, activity_seq DESC)` — 팀 활동 화면(늘 project_id).
기본 ASC(after_seq) 조회도 같은 인덱스를 정순으로 탄다.

## CONCURRENTLY 미사용(0217 · 0384 · 0406 선례 그대로)
env.py가 transaction_per_migration을 안 켜서 autocommit_block()(CONCURRENTLY 전제)이 증분 적용 경로에서 죽는다(0217 docstring).
평범한 트랜잭션 내 CREATE INDEX.

번호: 착지 순 사다리 — 열린 PR 중 마이그를 가진 것 0(2026-09-25 06:4xZ 확인) → 0409(down 0408).

Revision ID: 0409
Revises: 0408
"""
import sqlalchemy as sa

from alembic import op

revision = "0409"
down_revision = "0408"
branch_labels = None
depends_on = None

_ORG_SEQ = "ix_activity_events_org_seq"
_PROJECT_SEQ = "ix_activity_events_project_seq"


def upgrade() -> None:
    op.create_index(_ORG_SEQ, "activity_events", ["org_id", sa.text("activity_seq DESC")])
    op.create_index(_PROJECT_SEQ, "activity_events", ["org_id", "project_id", sa.text("activity_seq DESC")])


def downgrade() -> None:
    op.drop_index(_PROJECT_SEQ, table_name="activity_events")
    op.drop_index(_ORG_SEQ, table_name="activity_events")
