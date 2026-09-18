"""org_domain_label 테이블 — story #3287([도메인탈고정·축1 Phase1] org 표시 라벨 레이어).

canonical slug(entity_type/status 저장값) 컬럼·enum·CHECK 제약은 **이 마이그가 안 건드린다**
(AC1) — 이 테이블은 완전히 신규·additive이고, 어느 기존 테이블(stories.status·work_item_type
등)에도 컬럼 추가나 제약 변경을 안 한다. 설계 doc entity:doc:1fa7e2a9-c8c2-4a8e-a9da-
35bce52a5012 §Phase 1 그대로 — hitl_gate_config(migration 0123)와 동형 스캐폴딩(신규
additive 테이블+부분 유니크 인덱스).

project_id는 후속 확장 훅(AC5, 이 슬라이스는 미사용) — project 오버라이드 부분 유니크
인덱스는 그 기능이 실제로 필요해질 때 별도 마이그로 추가한다(0123이 org/project 두 부분
유니크를 한 번에 만든 것과 달리, 이 슬라이스는 org 전용이라 하나만).

idempotent: IF NOT EXISTS — 재실행·fresh DB 안전.
"""
from alembic import op

revision = "0296"
down_revision = "0295"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_domain_label (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          uuid NOT NULL,
            project_id      uuid NULL,
            domain          text NOT NULL,
            canonical_slug  text NOT NULL,
            label_ko        text NULL,
            label_en        text NULL,
            created_by      uuid NULL,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_org_domain_label_domain CHECK (domain IN ('entity_type', 'status'))
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_org_domain_label_org_id ON org_domain_label (org_id)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_org_domain_label_project_id ON org_domain_label (project_id)"
    )
    # 축당(org, domain, canonical_slug) 1행 — org 기본값(project_id NULL)만. project 오버라이드
    # 부분 유니크는 그 기능 착수 시 별도 마이그로 추가(위 모듈 docstring 참고).
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_org_domain_label_org_default "
        "ON org_domain_label (org_id, domain, canonical_slug) WHERE project_id IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS org_domain_label")
