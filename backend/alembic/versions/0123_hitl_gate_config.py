"""HITL 게이트 레벨 config 테이블 — E-HITL-GATING S-GATE-1 (f9e54965).

정책 hitl-gating-policy-v1 §3. org 기본값(project_id NULL) → project 오버라이드 계층으로
(work_type × actor_type) → level(auto/ask/block) 저장. **신규 테이블·additive·백필 0** —
dev 전용 가치 실험이나 dev/prod 공유 DB라 prod DB 에도 생성되되 prod 코드 무참조(무영향).

유니크: 부분 인덱스 2(org 기본값 / project 오버라이드) — NULL distinct 함정 회피, NULLS NOT
DISTINCT(PG15) 비의존(이식성). 안전 하한(§3d)·집행(Cage/H1)은 S-GATE-3/S-GATE-2.

idempotent: IF NOT EXISTS — 재실행·fresh DB 안전.
"""
from alembic import op

revision = "0123"
down_revision = "0122"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS hitl_gate_config (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id      uuid NOT NULL,
            project_id  uuid NULL,
            work_type   text NOT NULL,
            actor_type  text NOT NULL,
            level       text NOT NULL,
            created_by  uuid NULL,
            created_at  timestamptz NOT NULL DEFAULT now(),
            updated_at  timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_hitl_gate_work_type  CHECK (work_type  IN ('done', 'merge')),
            CONSTRAINT ck_hitl_gate_actor_type CHECK (actor_type IN ('agent', 'human')),
            CONSTRAINT ck_hitl_gate_level      CHECK (level      IN ('auto', 'ask', 'block'))
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_hitl_gate_config_org_id ON hitl_gate_config (org_id)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_hitl_gate_config_project_id ON hitl_gate_config (project_id)"
    )
    # 축당 1행: org 기본값(project NULL) / project 오버라이드 각각 부분 유니크
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_hitl_gate_org_default "
        "ON hitl_gate_config (org_id, work_type, actor_type) WHERE project_id IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_hitl_gate_project_override "
        "ON hitl_gate_config (org_id, project_id, work_type, actor_type) WHERE project_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS hitl_gate_config")
