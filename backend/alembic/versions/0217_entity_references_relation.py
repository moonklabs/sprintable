"""story #2267(C-9, E-CONNECT) — entity_references.relation: 「생성 출처」 축 신설.

`relation`은 `form`(어떻게 보이는가: mention/embed/proof)·`source_field`(어느 «필드»에서
파싱됐나: 지금 유일값 "body")와 다른 축이다 — 창조 출처는 텍스트 필드에서 파싱된 게 아니라
«생성 행위» 자체에서 온 것이라 그 둘로는 못 담는다(오르테가군 판정, 2026-07-29).

⛔⛔NULL-distinct 함정 두 번째 재발(로컬 disposable PG로 직접 재현, 2026-07-29): 처음엔
relation을 nullable(NULL=본문 참조)로 설계했는데 — Postgres 기본(NULLS DISTINCT)상 NULL
행끼리 "다른 값"으로 취급돼 **유일성이 아예 안 걸린다**(기존 멘션 전부가 NULL이라 지금까지
막던 중복이 통째로 풀리는 회귀 — 실PG 테스트 3건이 실제로 이렇게 깨지는 것을 확認했다).
`NULLS NOT DISTINCT`(PG15+)로 1차 수정했으나, 오르테가군 재검토: 특정 PG 버전 기능
의존은 로컬·dev·prod 버전 불일치 리스크가 남는다 — **source_field가 이미 쓰는 선례**
(NOT NULL + sentinel "body")를 그대로 따른다. `relation`은 NOT NULL, 기본값 'none'
(=본문 참조) 또는 'created_from'(=출처) 둘 뿐 — **정확성(CHECK·유니크 동작)은 PG 버전과
무관**(옛 PG에서도 이 컬럼/제약 자체는 그대로 동작한다 — NULLS NOT DISTINCT처럼 구문 자체가
없는 버전에서 실패하는 종류의 의존이 아니다).

⛔"마이그 0"이 깨지는가 + PG11+ 전제 확認(오르테가군 요청①, 2026-07-30): `ADD COLUMN ...
NOT NULL DEFAULT 'none'`이 **"즉시(테이블 재작성 0)"인 것 자체는 PG11+ 최적화**(상수
기본값 한정 — PG10 이하에서는 이 문장도 전체 재작성이 돈다. 옛 버전에서도 결과는 같지만
느릴 뿐, 틀리게 동작하진 않는다). ⭐**dev·prod 버전 확認 완료**(`gcloud sql instances list`,
2026-07-30): 둘 다 `POSTGRES_15` — 이 최적화 경로가 실제로 적용된다. 로컬 PG(16.13)로도
실측: 138행 표에서 1.1ms. 데이터가 실제로 채워지므로 엄밀히는 "데이터 마이그레이션 0"은
아니지만, 이 경로는 행 수와 무관하게 항상 즉시(대상 표가 prod에서 지금보다 커도 위험이
없다) — "마이그 0"은 목표가 아니라 결과였을 뿐, 이 경로는 그 결과를 다른 방식(사람이 쓴
UPDATE 없음)으로 달성한다.

⛔⛔CONCURRENTLY 제거(오르테가군 판정, 2026-07-30 — dev 배포 실패 사고 후 재검토): 원래
`CREATE INDEX CONCURRENTLY`를 `autocommit_block()`으로 감쌌었으나, 이 프로젝트의
`alembic/env.py`가 `transaction_per_migration`을 켜지 않은 채(기본 False) 「기존 DB에
증분 1개만 얹는」 실배포 경로를 타면 `autocommit_block()` 진입 자체가 `AssertionError
(self._transaction is not None)`로 죽는다는 것을 dev 배포에서 실물로 맞았다(로컬 재현:
`alembic upgrade 0216` 후 `0217` 단독 적용 시 100% 재현 — "빈 DB에서 수십 개 배치 적용"
경로에서만 우연히 통과했었다). alembic 자체 문서도 "autocommit block을 쓰려면
transaction_per_migration을 권장"이라 명시한다 — 즉 이건 이 마이그레이션 하나의 실수가
아니라 **이 프로젝트 설정에서 `autocommit_block()`을 원리적으로 못 쓴다**는 사실이다
(`alembic/env.py` 옆에 그 사실을 남겨 재발을 막는다).

CONCURRENTLY의 원래 목적(대상 표가 커서 인덱스 빌드 중 쓰기를 막지 않으려는 것)도 이
자리엔 안 맞았다 — dev 실측(#2277) `entity_references` 총 행수 62건, 락이 걸려도 순간이다.
CONCURRENTLY는 수십만~수백만 행 규모에서 값이 있는 도구이지 여기선 비용(트랜잭션 밖 실행
제약)만 있고 값이 없었다 — 평범한 트랜잭션 내 DROP+CREATE로 되돌린다(같은 트랜잭션
안이라 MVCC상 다른 커넥션은 커밋 전까지 중간 상태를 못 보므로, 임시 이름으로 만들었다가
RENAME하는 「유일성 공백 없음」 안무 자체가 더 이상 필요 없다 — DROP 직후 CREATE가 그냥
원자적이다).

Revision ID: 0217
Revises: 0216
Create Date: 2026-07-29
"""
from alembic import op
import sqlalchemy as sa

revision = "0217"
down_revision = "0216"
branch_labels = None
depends_on = None

_INDEX_NAME = "uq_entity_references_non_proof"


def upgrade() -> None:
    # 상수 기본값 ADD COLUMN NOT NULL은 PG11+에서 메타데이터 연산만(테이블 재작성 0) —
    # 기존 행 전부가 이 문장 하나로 'none'을 갖게 된다(별도 배치 UPDATE 불요, 위 모듈
    # docstring 참조).
    op.add_column(
        "entity_references",
        sa.Column("relation", sa.Text(), nullable=False, server_default="none"),
    )
    op.create_check_constraint(
        "ck_entity_references_relation",
        "entity_references",
        "relation IN ('none', 'created_from')",
    )
    # 같은 트랜잭션 안 DROP+CREATE — 62행 규모에서 락은 순간, MVCC상 원자적으로 보인다.
    op.execute(f"DROP INDEX IF EXISTS {_INDEX_NAME}")
    op.execute(
        f"""
        CREATE UNIQUE INDEX {_INDEX_NAME}
        ON entity_references (source_type, source_field, source_id, target_type, target_id, form, relation)
        WHERE form <> 'proof'
        """
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {_INDEX_NAME}")
    op.execute(
        f"""
        CREATE UNIQUE INDEX {_INDEX_NAME}
        ON entity_references (source_type, source_field, source_id, target_type, target_id, form)
        WHERE form <> 'proof'
        """
    )
    op.drop_constraint("ck_entity_references_relation", "entity_references", type_="check")
    op.drop_column("entity_references", "relation")
