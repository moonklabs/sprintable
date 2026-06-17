"""plan_features PRIMARY KEY 복원 — 0114(#1403) 누락 drift (story e491d087).

a74bdc84 트리아지서 적출: ORM(`app/models/plan_feature.py`)은 `id`를 PK로 정의하나
DB(0096 baseline)에 부재. 0114(ORM-모델 39개 PK 복원, #1403)와 동일 클래스이나 그 목록에서
누락됐다. 머지된 0114는 미수정 — 별도 0120으로 plan_features만 idempotent 복원.

⚠️ ADD PRIMARY KEY는 대상 컬럼에 NULL/중복이 있으면 실패한다. fresh/clean DB에선 무조건
성공하나 real dev/prod 적용 전 dup-id/NULL 전수 preflight 필수 —
`backend/scripts/preflight/0120_plan_features_pk_preflight.sql` 동봉. preflight 0건 확인 후 머지.

⚠️ 별개 drift(보고됨): baseline schema.sql의 plan_features 컬럼(tier_id/feature_key/enabled/
limit_value)이 0049/ORM(code/name/tier/is_active/...)과 불일치한다 — 컬럼 정합은 본 PK 스토리와
별 트랙. 본 마이그는 양 버전에 공통 존재하는 `id` 컬럼의 PRIMARY KEY만 복원한다.
"""
from alembic import op

revision = "0120"
down_revision = "0119"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    from sqlalchemy import inspect

    if "plan_features" not in set(inspect(conn).get_table_names()):
        # 방어: 환경 편차로 테이블 부재 시 건너뜀(본 마이그는 추가만, 생성 안 함).
        return
    # PK 부재 시에만 추가(idempotent). 0114(#1403) 동일 가드 패턴.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.plan_features'::regclass AND contype = 'p'
            ) THEN
                ALTER TABLE public.plan_features
                    ADD CONSTRAINT plan_features_pkey PRIMARY KEY (id);
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    # 드리프트 교정이므로 되돌리지 않는다 — PK를 drop하면 원래 결함(ORM↔DB 불일치)을 재현한다.
    # (0114 / 0107 docs_pkey / 0113 epics_pkey와 동일 정책.)
    pass
