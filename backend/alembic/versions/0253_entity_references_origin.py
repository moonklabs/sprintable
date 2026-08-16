"""story #2679(BE·인가 아님, «샾+숫자» 오참조) — entity_references.origin: 「어떻게 감지됐나」 축 신설.

`origin`은 `form`(어떻게 보이는가)·`relation`(창조 출처 vs 본문 참조)과 또 다른 축이다 —
명시 토큰/`[제목](entity:...)`·human `#` 피커·agent `mentions` 필드로 caller가 **의도해서**
만든 참조('explicit')와, 서버가 본문의 맨 `#숫자`를 존재만 확인되면 **caller 의도 확인 없이**
자동 승격한 참조('auto')를 가른다. #2267(relation)이 이미 겪은 것과 같은 이유로 새 컬럼이
필요 — form/relation 둘 다 이미 CHECK로 닫힌 값 집합이라(각각 3값/2값) "감지 방식"이라는
제3의 뜻을 얹을 자리가 없다.

⛔`relation`과 달리 유일성 인덱스(`uq_entity_references_non_proof`)에 **origin은 넣지 않는다**
— origin은 "이게 다른 참조냐"를 가르는 정체성 축이 아니라 부수 속성(source_field가 이미
"body" 하나뿐이라 이 write-path엔 정체성 충돌 여지가 사실상 없다 — 드문 auto/explicit 동시
시도는 ON CONFLICT DO NOTHING이 먼저 쓰인 값을 유지, PO/미르코 핸드오프 스펙에 문서화된
의도적 단순화). 인덱스 재생성이 없으므로 0217과 달리 DROP+CREATE 안무도 불필요 — ADD COLUMN
+ CHECK 둘뿐.

상수 기본값 `ADD COLUMN ... NOT NULL DEFAULT 'explicit'`은 0217과 동일 근거로 PG11+에서
메타데이터 전용(테이블 재작성 0) — dev/prod 둘 다 POSTGRES_15 확인 이력 있음(0217 실측
그대로 재사용, 이번 마이그가 별도로 재확인하지 않음). 기존 행 전부(명시 멘션/브라켓
토큰으로 만들어진 것들) 전부 'explicit'로 시작하는 것이 정확한 값이다 — 이 write-path들은
지금까지 전부 명시 경로였다(auto 승격은 이 스토리에서 처음 생긴다).

Revision ID: 0253
Revises: 0252
Create Date: 2026-08-16
"""
from alembic import op
import sqlalchemy as sa

revision = "0253"
down_revision = "0252"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "entity_references",
        sa.Column("origin", sa.Text(), nullable=False, server_default="explicit"),
    )
    op.create_check_constraint(
        "ck_entity_references_origin",
        "entity_references",
        "origin IN ('explicit', 'auto')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_entity_references_origin", "entity_references", type_="check")
    op.drop_column("entity_references", "origin")
