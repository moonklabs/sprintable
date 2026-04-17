#!/bin/sh
# AC5: Supabase 마이그레이션 자동 실행
# Usage: ./scripts/run-migrations.sh <DATABASE_URL>
#
# Example:
#   ./scripts/run-migrations.sh "postgresql://postgres:password@localhost:5432/sprintable"

DB_URL="${1:-$DATABASE_URL}"

if [ -z "$DB_URL" ]; then
  echo "❌ Usage: ./scripts/run-migrations.sh <DATABASE_URL>"
  echo "   Or set DATABASE_URL environment variable"
  exit 1
fi

# Docker 내에서는 /migrations, 호스트에서는 packages/db/supabase/migrations
if [ -d "/app/migrations" ]; then
  MIGRATIONS_DIR="/app/migrations"
else
  MIGRATIONS_DIR="packages/db/supabase/migrations"
fi

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "❌ Migrations directory not found: $MIGRATIONS_DIR"
  exit 1
fi

echo "🔄 Running migrations from $MIGRATIONS_DIR..."

for file in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  echo "  → $(basename $file)"
  psql "$DB_URL" -f "$file" 2>&1 | grep -v "^$" | head -5
  if [ $? -ne 0 ]; then
    echo "  ⚠️  Warning: $(basename $file) had issues (may be idempotent)"
  fi
done

echo "✅ Migrations complete."
