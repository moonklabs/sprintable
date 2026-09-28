"""story #4299 ② — 보드 목록 · 미매달림 버킷 · glance attention이 `stories`를 **프로젝트로 거르는 순차 훑기**로 읽던 것.

## 그라운딩(dev DB · 읽기 전용 EXPLAIN (ANALYZE, BUFFERS) · PO 2026-09-28 · 문서 8a45c207의 40문장)
- 목록 `[4]` 5.9~7.8ms · count `[3]` 3.8~4.0ms — 둘 다 `Seq Scan on stories`(8,009행 중 그 프로젝트 행만 남김)를 두 번.
- attention `[5]`(in-review) · `[9]`(stalled 모집단) 3.4~3.7ms — 같은 프로젝트 거르기 순차 훑기.
기존 인덱스는 `idx_stories_project_id(project_id)` · `idx_stories_org_id(org_id)` 단일 칼럼뿐이라 플래너가 표 전체를 훑었다(표 크기에 비례 —
계속 쌓이는 표).

## 인덱스
`stories (project_id, created_at DESC, id DESC) WHERE deleted_at IS NULL` — 목록 조회가 쓰는 조건 · 정렬 그대로
(`StoryRepository.list`: `project_id = …` · `deleted_at IS NULL` · `ORDER BY created_at DESC, id DESC`). 부분 조건이 조회의
`deleted_at IS NULL`과 글자 그대로 같아 플래너가 함의를 증명한다(0384 교훈 — 식이 어긋나면 인덱스가 조용히 안 쓰인다).
attention의 프로젝트 거르기(`project_id = … AND deleted_at IS NULL AND status …`)도 앞머리 칼럼으로 탄다.

## CONCURRENTLY 미사용(0217 · 0384 · 0412 선례 그대로)
env.py가 transaction_per_migration을 안 켜서 autocommit_block()(CONCURRENTLY 전제)이 증분 적용 경로에서 죽는다(0217 docstring).
평범한 트랜잭션 내 CREATE INDEX — 만드는 동안 `stories` 쓰기를 막는다(dev 8천 행 규모면 짧음 · prod 적용 시점은 PO 판단).

번호: 착지 순 사다리 — 열린 PR 중 마이그를 가진 것은 4760(4303 · 0414, down 0413) → 0415(down 0414) · PO 지정(2026-09-28 02:45Z).
4760 병합 전까지 이 PR의 fresh-DB alembic upgrade는 RED — 예상 상태(0406 · 0412 선례).

Revision ID: 0415
Revises: 0414
"""
import sqlalchemy as sa

from alembic import op

revision = "0415"
down_revision = "0414"
branch_labels = None
depends_on = None

_INDEX_NAME = "ix_stories_project_created_live"


def upgrade() -> None:
    op.create_index(
        _INDEX_NAME,
        "stories",
        ["project_id", sa.text("created_at DESC"), sa.text("id DESC")],
        unique=False,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="stories")
