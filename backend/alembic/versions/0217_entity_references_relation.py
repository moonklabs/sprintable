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

⛔인덱스 재생성 락 검토(오르테가군 지적): `DROP INDEX` + `CREATE UNIQUE INDEX`를 일반
(non-concurrent) 방식으로 하면 테이블 쓰기를 인덱스 빌드가 끝날 때까지 막는다. dev 기준
이 표는 실측 62~138행이라 그 자체로는 순식간이지만, 실제 prod 적용 시점의 행 수는 지금과
다를 수 있어 CONCURRENTLY로 그 리스크 계열 자체를 없앤다(sentinel 방식이라 NULLS NOT
DISTINCT는 이제 불필요 — relation이 항상 구체값이라 일반 유니크 인덱스로 충분).

⛔순서 검토(오르테가군 재지적): 구 인덱스를 먼저 DROP하면 CONCURRENTLY 빌드가 끝날 때까지
유일성이 아예 없는 창이 생긴다(그 사이 중복이 들어오면 빌드 자체가 끝에 가서 실패). ⇒
①새 인덱스를 임시 이름으로 CONCURRENTLY 생성(구 인덱스와 공존 — 이 순간부터 이미 relation
포함 유일성이 걸린다) ②구 인덱스 DROP(카탈로그 연산·즉시) ③RENAME으로 canonical 이름
복구(카탈로그 연산·즉시). 한순간도 유일성이 비지 않는다.

CREATE INDEX CONCURRENTLY는 트랜잭션 밖에서만 도는 Postgres 제약이라 alembic의
`autocommit_block()`으로 그 한 문장만 감싼다.

Revision ID: 0215
Revises: 0214
Create Date: 2026-07-29
"""
from alembic import op
import sqlalchemy as sa

revision = "0217"
down_revision = "0216"
branch_labels = None
depends_on = None

_OLD_INDEX = "uq_entity_references_non_proof"
_NEW_INDEX_TMP = "uq_entity_references_non_proof_v2"


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
    # ① 새 인덱스를 임시 이름으로 CONCURRENTLY 생성 — 구 인덱스와 이 시점부터 공존한다.
    with op.get_context().autocommit_block():
        op.execute(
            f"""
            CREATE UNIQUE INDEX CONCURRENTLY {_NEW_INDEX_TMP}
            ON entity_references (source_type, source_field, source_id, target_type, target_id, form, relation)
            WHERE form <> 'proof'
            """
        )
    # ② 구 인덱스 제거(카탈로그 연산·즉시).
    op.execute(f"DROP INDEX IF EXISTS {_OLD_INDEX}")
    # ③ 새 인덱스를 canonical 이름으로(카탈로그 연산·즉시 — 락 걱정 없음).
    op.execute(f"ALTER INDEX {_NEW_INDEX_TMP} RENAME TO {_OLD_INDEX}")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(
            f"""
            CREATE UNIQUE INDEX CONCURRENTLY {_NEW_INDEX_TMP}
            ON entity_references (source_type, source_field, source_id, target_type, target_id, form)
            WHERE form <> 'proof'
            """
        )
    op.execute(f"DROP INDEX IF EXISTS {_OLD_INDEX}")
    op.execute(f"ALTER INDEX {_NEW_INDEX_TMP} RENAME TO {_OLD_INDEX}")
    op.drop_constraint("ck_entity_references_relation", "entity_references", type_="check")
    op.drop_column("entity_references", "relation")
