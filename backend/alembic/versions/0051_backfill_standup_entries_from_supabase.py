"""BF-4: Supabase standup_entries → FastAPI PostgreSQL 백필

Revision ID: 0051
Revises: 0050
Create Date: 2026-05-23

Supabase → Cloud SQL 마이그레이션(C-S9, 2026-05-02 전후) 당시 standup_entries가
pg_dump/pg_restore 대상에서 누락되어 신규 DB에 빈 배열로 보이는 버그(BF-4) 수정.

실행 조건:
  SUPABASE_DB_PASSWORD 환경변수가 없으면 no-op 경고 출력 후 통과.
  재실행 안전: ON CONFLICT (project_id, author_id, date) DO NOTHING

Supabase 접속 정보:
  Host: db.hcweddmbfyfjgbqcondh.supabase.co (migrate_supabase_to_cloud_sql.sh 기준)
  Port: 5432 / DB: postgres / User: postgres
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import date, datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "0051"
down_revision = "0050"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

SUPABASE_HOST = os.environ.get("SUPABASE_DB_HOST", "db.hcweddmbfyfjgbqcondh.supabase.co")
SUPABASE_PORT = int(os.environ.get("SUPABASE_DB_PORT", "5432"))
SUPABASE_DB = os.environ.get("SUPABASE_DB_NAME", "postgres")
SUPABASE_USER = os.environ.get("SUPABASE_DB_USER", "postgres")


def _fetch_supabase_entries(password: str) -> list[dict]:
    """Supabase PostgreSQL에서 standup_entries 전량 조회."""
    import psycopg2
    import psycopg2.extras

    conn = psycopg2.connect(
        host=SUPABASE_HOST,
        port=SUPABASE_PORT,
        dbname=SUPABASE_DB,
        user=SUPABASE_USER,
        password=password,
        connect_timeout=10,
    )
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    id, org_id, project_id, sprint_id, author_id,
                    date, done, plan, blockers,
                    COALESCE(plan_story_ids, '{}') AS plan_story_ids,
                    created_at, updated_at
                FROM public.standup_entries
                ORDER BY date
                """
            )
            return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()


def upgrade() -> None:
    password = os.environ.get("SUPABASE_DB_PASSWORD", "")
    if not password:
        log.warning(
            "BF-4 backfill skipped: SUPABASE_DB_PASSWORD not set. "
            "Re-run with the env var to execute the backfill."
        )
        return

    log.info("BF-4: Supabase standup_entries 백필 시작...")

    try:
        rows = _fetch_supabase_entries(password)
    except Exception as exc:
        log.error("BF-4: Supabase 연결 실패 — %s. 백필 건너뜀.", exc)
        return

    log.info("BF-4: Supabase에서 %d건 조회됨.", len(rows))
    if not rows:
        log.info("BF-4: 백필할 데이터 없음. 완료.")
        return

    conn = op.get_bind()

    inserted = 0
    skipped = 0
    for row in rows:
        plan_story_ids = row["plan_story_ids"] or []
        # psycopg2 RealDictRow → Python 기본 타입 변환
        story_ids_str = "{" + ",".join(str(sid) for sid in plan_story_ids) + "}"

        result = conn.execute(
            sa.text(
                """
                INSERT INTO standup_entries
                    (id, org_id, project_id, sprint_id, author_id,
                     date, done, plan, blockers, plan_story_ids,
                     created_at, updated_at)
                SELECT
                    :id, :org_id, :project_id, :sprint_id, :author_id,
                    :date, :done, :plan, :blockers, :plan_story_ids::uuid[],
                    :created_at, :updated_at
                WHERE
                    EXISTS (SELECT 1 FROM organizations   WHERE id = :org_id)
                    AND EXISTS (SELECT 1 FROM projects    WHERE id = :project_id)
                    AND EXISTS (SELECT 1 FROM team_members WHERE id = :author_id)
                ON CONFLICT (project_id, author_id, date) DO NOTHING
                """
            ),
            {
                "id":             str(row["id"]),
                "org_id":         str(row["org_id"]),
                "project_id":     str(row["project_id"]),
                "sprint_id":      str(row["sprint_id"]) if row["sprint_id"] else None,
                "author_id":      str(row["author_id"]),
                "date":           row["date"],
                "done":           row["done"],
                "plan":           row["plan"],
                "blockers":       row["blockers"],
                "plan_story_ids": story_ids_str,
                "created_at":     row["created_at"],
                "updated_at":     row["updated_at"],
            },
        )
        if result.rowcount:
            inserted += 1
        else:
            skipped += 1

    log.info("BF-4: 백필 완료 — 삽입 %d건 / 스킵(중복 또는 FK 없음) %d건.", inserted, skipped)


def downgrade() -> None:
    # 백필 데이터는 기존 데이터와 구분 불가 — 수동 롤백 필요
    pass
