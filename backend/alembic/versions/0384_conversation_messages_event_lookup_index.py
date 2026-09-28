"""story #4081(E-RECIPE-1 후속·성능, 까디르 #4455 QA 실측) — `conversation_messages.metadata`
(msg_metadata, JSONB)에서 `_find_existing_stage_publish`(events.py, story #4075)·
`get_event_publish_history`(#2665)가 읽는 event 조회 축에 고정 비용 인덱스를 얹는다.

## 그라운딩(로컬 realdb, 5만 행·그중 1만 행 event 메타 — AC1 기준선)
인덱스 前: `_find_existing_stage_publish` 동형 4조건(event_key·work_item_type·
work_item_id·stage) 쿼리가 `Seq Scan`(Rows Removed by Filter: 50000, buffers 1066+,
Execution Time 3.7ms — 0건 매치 최악 케이스). `start-candidates`(events.py:3160)가
적용 정의 수만큼 이 쿼리를 반복하므로 스토리 패널을 열 때마다 그 배수로 든다.

인덱스 後: 같은 쿼리가 `Index Scan`(buffers 8, Execution Time 0.26ms) — 행수 무관 고정
비용에 근접. `publish-history`(event_key 단일 조건)도 이 인덱스의 leading column만으로
`Bitmap Index Scan`을 탄다(별도 인덱스 불요, AC4 — 실측: `Bitmap Heap Scan` recheck
event_key만).

## 컬럼 설계 — stage 의도적 제외(디디군 #4082 코디 — 크로스세션 합의, cross-session msg
2026-09-21)
`(event_key, work_item_type, work_item_id, stage, ...)`로 stage까지 넣으면, stage
조건이 없는 조회(#4082가 만들 "최신 stage 1건" — `ORDER BY created_at DESC LIMIT 1`,
stage 무관)가 그 인덱스 순서(3-컬럼 prefix 고정 뒤 stage로 먼저 정렬됨)를 못 타 별도
정렬이 붙는다. `_find_existing_stage_publish`는 반대로 stage를 인덱스에서 빼도 손해가
거의 없다 — 3-컬럼 prefix(event_key+work_item_type+work_item_id)만으로 이미 극도로
좁혀진(실측: 매치 5건 미만) 뒤 stage는 heap filter로 거르는 비용이 무시할 수준이기
때문(위 EXPLAIN 실측 — `Index Cond`는 3컬럼, `Filter`가 stage 단독으로 5건 제거).
그래서 `(event_key, work_item_type, work_item_id, created_at DESC)` 4컬럼으로 확定 —
두 조회(그리고 #4082의 신규 조회) 전부 이 하나로 최적 커버.

## partial WHERE — `?` 연산자 대신 `IS NOT NULL`(중요한 실측 정정)
처음 `WHERE metadata ? 'event'`(top-level 키 존재)로 짰더니 `enable_seqscan=off`로
강제해도 플래너가 이 인덱스를 **전혀** 못 골랐다(Seq Scan 비용에 10000000000 페널티를
줘도 대안이 안 나옴 — 즉 구조적으로 못 씀, 골라서 안 쓴 게 아니라 후보 자체가 안 생김).
원인: 쿼리의 `(metadata->'event'->>'event_key') = 'x'` 조건이 인덱스의 부분조건
`metadata ? 'event'`를 «함의한다»는 걸 플래너가 증명 못 한다(`->>`와 `?`는 다른
연산자라 플래너의 부분인덱스 함의증명기가 그 사이를 못 잇는다 — 알려진 Postgres 플래너
한계). 부분조건을 `(metadata->'event'->>'event_key') IS NOT NULL`로 바꾸면(쿼리의
등호 조건이 IS NOT NULL을 표준적으로 함의 — 플래너가 늘 증명하는 자리) 즉시 `Bitmap
Index Scan`으로 해소됐다(재실측 확認). 이 파일의 인덱스는 그 교정된 형태다 — 다음
사람이 "더 정확해 보이는" `?`로 되돌리면 인덱스가 조용히 죽는다(에러 없이 그냥 안 쓰임
— 그래서 여기 남긴다).

## CONCURRENTLY 미사용(0217 선례 그대로 재사용, 새 판단 0)
이 프로젝트 `alembic/env.py`는 `transaction_per_migration`을 안 켠다 — dev 실배포
경로(기존 DB에 증분 1개만 적용)에서 `autocommit_block()`(CONCURRENTLY 전제)이
`AssertionError`로 죽는다는 게 0217에서 실물로 확認된 구조적 제약(0217 모듈 docstring
참조, 재검증 없이 그대로 재사용 — "발명 대신 재사용" 원칙). 평범한 트랜잭션 내
`CREATE INDEX`로 간다 — 대상 표가 이 스토리 그라운딩 기준(5만 행)에서 index build
수십ms 수준이라 브리프 라이트락 비용이 작다(prod 실 행수는 dev 배포 전 미확認 — 그
자리는 PO 라이브 배포 판단으로 남긴다, AC4).

Revision ID: 0384
Revises: 0383
Create Date: 2026-09-21
"""
from alembic import op
import sqlalchemy as sa

revision = "0384"
down_revision = "0383"
branch_labels = None
depends_on = None

_INDEX_NAME = "ix_conversation_messages_event_lookup"


def upgrade() -> None:
    op.create_index(
        _INDEX_NAME,
        "conversation_messages",
        [
            sa.text("(metadata->'event'->>'event_key')"),
            sa.text("(metadata->'event'->'payload'->>'work_item_type')"),
            sa.text("(metadata->'event'->'payload'->>'work_item_id')"),
            sa.text("created_at DESC"),
        ],
        unique=False,
        postgresql_where=sa.text("(metadata->'event'->>'event_key') IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="conversation_messages")
