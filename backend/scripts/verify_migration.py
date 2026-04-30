#!/usr/bin/env python3
"""C-S9: Supabase → Cloud SQL 데이터 정합성 검증 스크립트.

사용법:
    SUPABASE_DB_PASSWORD=... CLOUD_SQL_HOST=... CLOUD_SQL_PASSWORD=... \\
    python backend/scripts/verify_migration.py
"""
from __future__ import annotations

import os
import sys

try:
    import psycopg2
except ImportError:
    print("psycopg2 required: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)

# 0002 migration과 동일한 테이블 목록
TABLES = [
    "agent_api_keys",
    "agent_audit_logs",
    "agent_deployments",
    "agent_hitl_policies",
    "agent_hitl_requests",
    "agent_personas",
    "agent_routing_rules",
    "agent_runs",
    "agent_sessions",
    "docs",
    "epics",
    "inbox_items",
    "invitations",
    "meetings",
    "memo_assignees",
    "memo_doc_links",
    "memo_mentions",
    "memo_reads",
    "memo_replies",
    "memos",
    "messaging_bridge_channels",
    "messaging_bridge_users",
    "mockup_components",
    "mockup_pages",
    "mockup_scenarios",
    "mockup_versions",
    "notification_settings",
    "notifications",
    "org_members",
    "org_subscriptions",
    "organizations",
    "permission_audit_logs",
    "policy_documents",
    "project_settings",
    "projects",
    "retro_actions",
    "retro_items",
    "retro_sessions",
    "retro_votes",
    "reward_ledger",
    "sprints",
    "standup_entries",
    "standup_feedback",
    "stories",
    "tasks",
    "team_members",
    "usage_meters",
    "webhook_configs",
    "workflow_versions",
]


def _conn(host: str, port: int, db: str, user: str, password: str):
    return psycopg2.connect(host=host, port=port, dbname=db, user=user, password=password)


def _row_counts(conn) -> dict[str, int]:
    counts: dict[str, int] = {}
    with conn.cursor() as cur:
        for table in TABLES:
            cur.execute(f"SELECT COUNT(*) FROM public.{table}")  # noqa: S608
            row = cur.fetchone()
            counts[table] = row[0] if row else 0
    return counts


def _fk_violations(conn) -> list[dict]:
    """FK constraint 검증 — 참조 무결성 위반 행 탐지."""
    violations: list[dict] = []
    fk_query = """
        SELECT
            kcu.table_name      AS child_table,
            kcu.column_name     AS child_col,
            ccu.table_name      AS parent_table,
            ccu.column_name     AS parent_col,
            tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'public'
        ORDER BY child_table, constraint_name
    """
    with conn.cursor() as cur:
        cur.execute(fk_query)
        fk_rows = cur.fetchall()

    with conn.cursor() as cur:
        for child_table, child_col, parent_table, parent_col, constraint_name in fk_rows:
            cur.execute(f"""
                SELECT COUNT(*) FROM public.{child_table} c
                WHERE c.{child_col} IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM public.{parent_table} p
                      WHERE p.{parent_col} = c.{child_col}
                  )
            """)  # noqa: S608
            row = cur.fetchone()
            count = row[0] if row else 0
            if count > 0:
                violations.append({
                    "constraint": constraint_name,
                    "child": f"{child_table}.{child_col}",
                    "parent": f"{parent_table}.{parent_col}",
                    "violating_rows": count,
                })
    return violations


def main() -> int:
    src_cfg = {
        "host": os.environ.get("SUPABASE_DB_HOST", "db.hcweddmbfyfjgbqcondh.supabase.co"),
        "port": int(os.environ.get("SUPABASE_DB_PORT", "5432")),
        "db": os.environ.get("SUPABASE_DB_NAME", "postgres"),
        "user": os.environ.get("SUPABASE_DB_USER", "postgres"),
        "password": os.environ["SUPABASE_DB_PASSWORD"],
    }
    dst_cfg = {
        "host": os.environ["CLOUD_SQL_HOST"],
        "port": int(os.environ.get("CLOUD_SQL_PORT", "5432")),
        "db": os.environ.get("CLOUD_SQL_DB", "sprintable"),
        "user": os.environ.get("CLOUD_SQL_USER", "sprintable"),
        "password": os.environ["CLOUD_SQL_PASSWORD"],
    }

    print("Connecting to Supabase source...")
    src = _conn(**src_cfg)
    print("Connecting to Cloud SQL target...")
    dst = _conn(**dst_cfg)

    print("\n=== Row Count Comparison ===")
    src_counts = _row_counts(src)
    dst_counts = _row_counts(dst)

    failed = False
    for table in TABLES:
        s = src_counts.get(table, 0)
        d = dst_counts.get(table, 0)
        status = "✅" if s == d else "❌"
        if s != d:
            failed = True
        print(f"  {status} {table:<35} src={s:>8}  dst={d:>8}")

    print("\n=== FK Constraint Validation (target) ===")
    violations = _fk_violations(dst)
    if violations:
        failed = True
        for v in violations:
            print(f"  ❌ {v['constraint']}: {v['child']} → {v['parent']}  ({v['violating_rows']} rows)")
    else:
        print("  ✅ No FK violations detected")

    src.close()
    dst.close()

    if failed:
        print("\n❌ Verification FAILED — data mismatch or FK violations detected")
        return 1

    print("\n✅ Verification PASSED — row counts match, no FK violations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
