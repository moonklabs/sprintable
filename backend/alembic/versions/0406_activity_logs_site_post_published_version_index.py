"""story #4260 — 블로그 레시피 멘션의 «발행됨» 판정(#4256 · events.py `_open_site_draft_ids_for_work_item`)이 읽는 발행 감사 로그 조회에
부분 식 인덱스를 얹는다.

판정: 이 초안의 어느 버전이든 `activity_logs`(action = 'site_post_published')의 `context->>'version_id'`로 걸리면 «발행됨». activity_logs에는
(org_id, created_at) · (actor_id, created_at) · (entity_type, entity_id) 인덱스(0036)뿐이라, 이 조회는 한 조직의 **모든 액션 로그**를 훑고 걸렀다
(계속 쌓이는 표). 발행 로그만 담는 부분 식 인덱스로 버전 id 한 번의 인덱스 조회가 된다 — 발행 로그만 들어가 작고 쓰기 비용도 발행 때뿐.

## 조회 쪽 짝(같은 PR · events.py)
식 인덱스는 리터럴 키에, 부분조건은 리터럴 값에 고정된다. ORM `context["version_id"]`는 키를 bind parameter로, `action == "..."`는 값을
parameter로 컴파일해 generic plan에서 이 인덱스가 후보에도 못 오른다(0384 · #4081과 같은 부류). 그래서 조회는 키와 액션 값을 리터럴로 쓴다 —
되돌리면 test_4260이 잡는다.

## CONCURRENTLY 미사용(0217 · 0384 선례 그대로)
이 프로젝트 alembic/env.py는 transaction_per_migration을 안 켜서 autocommit_block()(CONCURRENTLY 전제)이 증분 적용 경로에서 죽는다(0217 docstring).
평범한 트랜잭션 내 CREATE INDEX — 부분조건으로 발행 로그만 담아 빌드 대상이 작다.

번호: 착지 순 사다리(PO 09:33Z) — 미르코 4621(4258)이 0405(down 0404)로 먼저 PR이 열려 이 파일은 0406(down 0405). 둘 다 0404를 부모로 열면 sibling
가드가 둘 다 RED라 게이트가 막힌다. 4621 병합 전까지 이 PR의 fresh-DB alembic upgrade는 RED — 예상 상태.

Revision ID: 0406
Revises: 0405
"""
import sqlalchemy as sa

from alembic import op

revision = "0406"
down_revision = "0405"
branch_labels = None
depends_on = None

_INDEX_NAME = "ix_activity_logs_site_post_published_version"


def upgrade() -> None:
    op.create_index(
        _INDEX_NAME,
        "activity_logs",
        [sa.text("(context->>'version_id')")],
        unique=False,
        postgresql_where=sa.text("action = 'site_post_published'"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="activity_logs")
