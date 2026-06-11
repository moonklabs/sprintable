"""PK 드리프트 일괄 교정: ORM이 PK를 가정하나 DB에 부재한 39개 테이블 PRIMARY KEY 복원.

Revision ID: 0114
Revises: 0113
Create Date: 2026-06-11

배경 (스토리 e491d087): baseline 스냅샷(dev 0096 pg_dump, alembic/baseline/schema.sql)이
PRIMARY KEY를 정확히 43개만 선언 → fresh-from-baseline DB(head)에서 127 base 테이블 중
75개가 DB PK 부재. ORM 메타데이터 교차 대조 결과 그 중 39개가 "모델은 PK 정의·DB 부재"
진짜 드리프트(docs 0107·epics 0113 step0와 동일 클래스). 이 마이그가 그 39개를 한 번에 닫는다.

PK 컬럼은 ORM 메타데이터(`Base.metadata.tables[t].primary_key.columns`)에서 도출 — 38개는
`id`, `project_settings`만 `project_id`. 각 테이블은 PK 부재 시에만 추가(idempotent).
downgrade는 되돌리지 않는다(드리프트 교정 — 되돌리면 결함 재현, 0107/0113 step0와 동일).

⚠️ ADD PRIMARY KEY는 대상 컬럼에 중복/NULL이 있으면 실패한다. fresh/clean DB에선 무조건
성공하나 real dev/prod 적용 전 dup-id/NULL 전수 preflight 필수 —
backend/scripts/preflight/0114_missing_pk_preflight.sql 동봉. preflight 0건 확인 후 머지.
② ORM 미모델 36개(legacy/append 로그류)는 본 마이그 범위 밖(별도 트리아지 a74bdc84).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0114"
down_revision = "0113"
branch_labels = None
depends_on = None

# (table, [pk_columns]) — ORM 메타데이터 도출. 전부 ['id'] 예외 project_settings=['project_id'].
TABLES_MISSING_PK: list[tuple[str, list[str]]] = [
    ("agent_api_keys", ["id"]),
    ("agent_audit_logs", ["id"]),
    ("agent_deployments", ["id"]),
    ("agent_hitl_policies", ["id"]),
    ("agent_hitl_requests", ["id"]),
    ("agent_personas", ["id"]),
    ("agent_routing_rules", ["id"]),
    ("agent_runs", ["id"]),
    ("agent_sessions", ["id"]),
    ("doc_comments", ["id"]),
    ("doc_revisions", ["id"]),
    ("inbox_items", ["id"]),
    ("meetings", ["id"]),
    ("messaging_bridge_channels", ["id"]),
    ("messaging_bridge_users", ["id"]),
    ("mockup_components", ["id"]),
    ("mockup_pages", ["id"]),
    ("mockup_scenarios", ["id"]),
    ("mockup_versions", ["id"]),
    ("notification_settings", ["id"]),
    ("notifications", ["id"]),
    ("org_subscriptions", ["id"]),
    ("permission_audit_logs", ["id"]),
    ("policy_documents", ["id"]),
    ("project_settings", ["project_id"]),
    ("retro_actions", ["id"]),
    ("retro_items", ["id"]),
    ("retro_sessions", ["id"]),
    ("retro_votes", ["id"]),
    ("reward_ledger", ["id"]),
    ("sprints", ["id"]),
    ("standup_entries", ["id"]),
    ("standup_feedback", ["id"]),
    ("story_activities", ["id"]),
    ("story_comments", ["id"]),
    ("tasks", ["id"]),
    ("usage_meters", ["id"]),
    ("webhook_configs", ["id"]),
    ("workflow_versions", ["id"]),
]


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    for table, pk_cols in TABLES_MISSING_PK:
        if table not in existing:
            # 방어: 대상 테이블이 없으면 건너뛴다(환경 편차 — 본 마이그는 추가만, 생성 안 함).
            continue
        cols_sql = ", ".join(f'"{c}"' for c in pk_cols)
        # PK 부재 시에만 추가(idempotent). 컬럼은 ADD PRIMARY KEY가 NOT NULL을 자동 부여.
        op.execute(
            f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.{table}'::regclass AND contype = 'p'
                ) THEN
                    ALTER TABLE public.{table}
                        ADD CONSTRAINT {table}_pkey PRIMARY KEY ({cols_sql});
                END IF;
            END $$;
            """
        )


def downgrade() -> None:
    # 드리프트 교정이므로 되돌리지 않는다 — PK를 drop하면 원래 결함(ORM↔DB 불일치)을 재현한다.
    # (0107 docs_pkey / 0113 epics_pkey step0와 동일 정책.)
    pass
