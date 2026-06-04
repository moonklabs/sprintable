"""E-MEMBER-SSOT AC3-5 ①: project_access member FK 가드된 VALIDATE.

0075가 project_access의 member FK 2종을 **NOT VALID**로 추가("후속 phase에서 VALIDATE"):
- fk_project_access_member (member_id → members.id, CASCADE)
- fk_project_access_inherited_member (inherited_from_member_id → members.id, SET NULL)

AC3-2c/2d로 휴먼/에이전트 placement·alias canonicalize가 완료돼 member_id 무결성이 갖춰진 지금
기존 행을 검증(VALIDATE)한다. NOT VALID FK도 신규 INSERT는 검증했으므로(트랩#7/8), 이건 기존
행 검증을 마저 켜는 **additive·비파괴** 단계.

⚠️ 가드(0080/0083 패턴): 부재 referent 행이 0건일 때만 VALIDATE(있으면 NOT VALID 유지 + RAISE
NOTICE — migrate 하드페일 방지). 제약 부재 DB(create_all auto-name 등)면 스킵(pg_constraint 가드).
data-dependent 분기라 bad>0은 실DB-only 발현(트랩#4b) — parity에 bad>0 가드 테스트 동봉.

⚠️ agent_api_keys.member_id FK는 0083서 bad=0 VALIDATE 완료 — 본 마이그 대상 아님.

Revision ID: 0089
Revises: 0088
Create Date: 2026-06-04
"""
from __future__ import annotations

from alembic import op

revision = "0089"
down_revision = "0088"
branch_labels = None
depends_on = None

# (제약명, 참조 컬럼) — 0075 NOT VALID FK 2종
_FKS = [
    ("fk_project_access_member", "member_id"),
    ("fk_project_access_inherited_member", "inherited_from_member_id"),
]


def upgrade() -> None:
    for conname, col in _FKS:
        op.execute(
            f"""
            DO $$
            DECLARE bad int;
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{conname}') THEN
                    SELECT count(*) INTO bad
                    FROM project_access pa
                    WHERE pa.{col} IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = pa.{col});
                    IF bad = 0 THEN
                        ALTER TABLE project_access VALIDATE CONSTRAINT {conname};
                        RAISE NOTICE '{conname} validated (bad=0)';
                    ELSE
                        RAISE NOTICE '{conname} NOT VALID 유지: members 부재 referent % 건 — 점검 후 재VALIDATE 필요', bad;
                    END IF;
                ELSE
                    RAISE NOTICE '{conname} 부재 — 스킵(create_all auto-name DB 등)';
                END IF;
            END $$;
            """
        )


def downgrade() -> None:
    # VALIDATE는 비파괴(제약 상태만 NOT VALID→validated). 역전 불요 — no-op.
    pass
