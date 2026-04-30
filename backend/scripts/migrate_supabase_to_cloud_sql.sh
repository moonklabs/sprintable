#!/usr/bin/env bash
# C-S9: Supabase → Cloud SQL 데이터 마이그레이션 스크립트
#
# 사용법:
#   SUPABASE_DB_PASSWORD=... CLOUD_SQL_HOST=... CLOUD_SQL_PASSWORD=... \
#   bash backend/scripts/migrate_supabase_to_cloud_sql.sh
#
# 환경변수:
#   SUPABASE_DB_HOST      (기본: db.hcweddmbfyfjgbqcondh.supabase.co)
#   SUPABASE_DB_PORT      (기본: 5432)
#   SUPABASE_DB_NAME      (기본: postgres)
#   SUPABASE_DB_USER      (기본: postgres)
#   SUPABASE_DB_PASSWORD  [필수]
#   CLOUD_SQL_HOST        [필수]
#   CLOUD_SQL_PORT        (기본: 5432)
#   CLOUD_SQL_DB          (기본: sprintable)
#   CLOUD_SQL_USER        (기본: sprintable)
#   CLOUD_SQL_PASSWORD    [필수]
#   DUMP_DIR              (기본: /tmp)

set -euo pipefail

SUPABASE_HOST="${SUPABASE_DB_HOST:-db.hcweddmbfyfjgbqcondh.supabase.co}"
SUPABASE_PORT="${SUPABASE_DB_PORT:-5432}"
SUPABASE_DB="${SUPABASE_DB_NAME:-postgres}"
SUPABASE_USER="${SUPABASE_DB_USER:-postgres}"
SUPABASE_PASSWORD="${SUPABASE_DB_PASSWORD:?SUPABASE_DB_PASSWORD is required}"

CLOUD_SQL_HOST="${CLOUD_SQL_HOST:?CLOUD_SQL_HOST is required}"
CLOUD_SQL_PORT="${CLOUD_SQL_PORT:-5432}"
CLOUD_SQL_DB="${CLOUD_SQL_DB:-sprintable}"
CLOUD_SQL_USER="${CLOUD_SQL_USER:-sprintable}"
CLOUD_SQL_PASSWORD="${CLOUD_SQL_PASSWORD:?CLOUD_SQL_PASSWORD is required}"

DUMP_DIR="${DUMP_DIR:-/tmp}"
DUMP_FILE="${DUMP_DIR}/supabase_dump_$(date +%Y%m%d_%H%M%S).dump"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "=== C-S9: Supabase → Cloud SQL Migration ==="
log "Source: ${SUPABASE_HOST}:${SUPABASE_PORT}/${SUPABASE_DB}"
log "Target: ${CLOUD_SQL_HOST}:${CLOUD_SQL_PORT}/${CLOUD_SQL_DB}"
log "Dump:   ${DUMP_FILE}"

# ─── Phase 1: pg_dump from Supabase ──────────────────────────────────────────
log "Phase 1: pg_dump from Supabase..."
PGPASSWORD="${SUPABASE_PASSWORD}" pg_dump \
    -h "${SUPABASE_HOST}" \
    -p "${SUPABASE_PORT}" \
    -U "${SUPABASE_USER}" \
    -d "${SUPABASE_DB}" \
    --schema=public \
    --no-owner \
    --no-acl \
    --format=custom \
    --file="${DUMP_FILE}"

DUMP_SIZE=$(du -sh "${DUMP_FILE}" | cut -f1)
log "Dump complete: ${DUMP_FILE} (${DUMP_SIZE})"

# ─── Phase 2: pg_restore to Cloud SQL ────────────────────────────────────────
log "Phase 2: pg_restore to Cloud SQL..."
PGPASSWORD="${CLOUD_SQL_PASSWORD}" pg_restore \
    -h "${CLOUD_SQL_HOST}" \
    -p "${CLOUD_SQL_PORT}" \
    -U "${CLOUD_SQL_USER}" \
    -d "${CLOUD_SQL_DB}" \
    --schema=public \
    --no-owner \
    --no-acl \
    --exit-on-error \
    "${DUMP_FILE}"

log "=== Migration complete. Run verify_migration.py to validate. ==="
log "Dump file retained at: ${DUMP_FILE}"
