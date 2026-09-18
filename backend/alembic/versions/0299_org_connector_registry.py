"""org_connector_registry 테이블 — story #3317(마케팅자동화·레시피 결함, PO 확定 2026-09-02①).

미르코군 플러그인 `describe_connector`(0.7.0) 반환 스키마를 org별로 저장한다. 완전 신규·
additive 테이블 — 기존 어느 테이블도 안 건드림. (org_id, connector_key) 축당 1행(재등록은
upsert — 멀티버전 이력 아님, org_domain_label의 org 전용 upsert와 동형 스캐폴딩).

시크릿/토큰은 이 테이블에 오지 않는다(PO 명시) — org_config는 source="org_config" 선언된
비밀 아닌 조직 설정값만, requires_env는 환경변수 "이름"만(값 없음) — 둘 다 쓰기 시점에
서버가 강제(services/connector_registry.py 참조, 이 마이그는 스키마만).

idempotent: IF NOT EXISTS — 재실행·fresh DB 안전.
"""
from alembic import op

revision = "0299"
down_revision = "0298"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_connector_registry (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          uuid NOT NULL,
            connector_key   text NOT NULL,
            version         text NOT NULL,
            channel         text NOT NULL,
            fields          jsonb NOT NULL DEFAULT '[]'::jsonb,
            requires_env    jsonb NOT NULL DEFAULT '[]'::jsonb,
            org_config      jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_by      uuid NULL,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_org_connector_registry_org "
        "ON org_connector_registry (org_id)"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_org_connector_registry_org_key "
        "ON org_connector_registry (org_id, connector_key)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS org_connector_registry")
