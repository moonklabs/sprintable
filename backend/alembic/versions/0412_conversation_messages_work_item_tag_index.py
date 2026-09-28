"""story #4332 — 게이트 목록(`GET /api/v2/gates`)이 느린 뿌리: `work_item_conversation.derive_conversation_ids_for_tagged_work_items`
(게이트마다 «그 work item을 태그한 대화» 찾기 · gates.py가 부름)가 `conversation_messages`를 전부 훑었다.

## 그라운딩(dev DB · 읽기 전용 EXPLAIN ANALYZE · 2026-09-26)
보드 첫 로드 모양(`work_item_type=story&status=pending` · 대기 게이트 16건 · 참여 메시지 많은 멤버):
- 게이트 본 조회 1.3ms.
- 태그 조회 `Parallel Seq Scan on conversation_messages` — 98,776행 전부(Rows Removed by Filter) · 버퍼 13.3k(디스크 6.4k) ·
  차가울 때 169ms · 데워진 뒤 69ms · 결과 0행. `metadata->'work_item'->>'type'/'id'`에 인덱스가 없어서 **메시지 표 전체 크기에 비례**
  (계속 쌓이는 표). 동시 요청마다 병렬 전체 스캔이 겹쳐 DB CPU가 찼다(동시 16 문장당 3.6→30.5ms · 풀 대기 0).

## 인덱스
`((metadata->'work_item'->>'type'), (metadata->'work_item'->>'id'), created_at DESC)` — 조회가 쓰는 식 그대로 · 최신 먼저 정렬.
부분 조건은 `(metadata->'work_item'->>'id') IS NOT NULL` — 0384가 실측으로 정정한 형태를 따른다: `metadata ? 'work_item'`로 쓰면
쿼리의 `->>` 조건이 그 부분 조건을 함의한다는 걸 플래너가 증명하지 못해 인덱스가 **조용히** 안 쓰인다. 태그된 메시지만 담겨 작다.

## CONCURRENTLY 미사용(0217 · 0384 선례 그대로)
env.py가 transaction_per_migration을 안 켜서 autocommit_block()(CONCURRENTLY 전제)이 증분 적용 경로에서 죽는다(0217 docstring).
평범한 트랜잭션 내 CREATE INDEX — 만드는 동안 `conversation_messages` 쓰기를 막는다(dev 10만 행 규모면 짧음 · prod 적용 시점은 PO 판단).

번호: 착지 순 사다리 — 열린 PR 중 마이그를 가진 것은 4713(4341 · 0411, down 0410) 하나(2026-09-26 08:3xZ 확인) → 0412(down 0411).
4713 병합 전까지 이 PR의 fresh-DB alembic upgrade는 RED — 예상 상태(0406 선례).

Revision ID: 0412
Revises: 0411
"""
import sqlalchemy as sa

from alembic import op

revision = "0412"
down_revision = "0411"
branch_labels = None
depends_on = None

_INDEX_NAME = "ix_conversation_messages_work_item_tag"


def upgrade() -> None:
    op.create_index(
        _INDEX_NAME,
        "conversation_messages",
        [
            sa.text("(metadata->'work_item'->>'type')"),
            sa.text("(metadata->'work_item'->>'id')"),
            sa.text("created_at DESC"),
        ],
        unique=False,
        postgresql_where=sa.text("(metadata->'work_item'->>'id') IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="conversation_messages")
