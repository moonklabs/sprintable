"""OB-4: onboarding_events append-only funnel 계측 store.

블루프린트 §6 · 측정계약 doc(`ob-4-onboarding-funnel-measurement-contract`). FE emit 4종 + BE
emit 8종을 단일 append-only 테이블에 캡처. ``session_id``(FE 조인키)·``agent_id``(post-auth)·dims.
**키 평문 미저장**(``key_prefix`` prefix-only·AC3).

additive·신규 테이블·백필 불요. baseline schema.sql 미변경(post-0096 신규 테이블·0130~0136 동형 —
fresh-DB CI[baseline + alembic upgrade head]가 0137 적용·create_all 금지). fresh-runnable·idempotent.

Revision ID: 0137
Revises: 0136
Create Date: 2026-06-25
"""
from __future__ import annotations

from alembic import op

revision = "0137"
down_revision = "0136"
branch_labels = None
depends_on = None

_INDEX_COLS = ("event", "session_id", "agent_id", "env", "runtime", "failure_reason", "server_ts")


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS onboarding_events (
            id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            event         text NOT NULL,
            session_id    uuid,
            agent_id      uuid,
            org_id        uuid,
            project_id    uuid,
            runtime       text,
            env           text,
            transport     text,
            key_prefix    text,
            failure_reason text,
            client_ts     timestamptz,
            meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
            server_ts     timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    for col in _INDEX_COLS:
        op.execute(
            f"CREATE INDEX IF NOT EXISTS ix_onboarding_events_{col} ON onboarding_events ({col})"
        )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS onboarding_events")
