#!/bin/sh
# AC5: Supabase 마이그레이션 자동 실행
# Usage: ./scripts/run-migrations.sh <DATABASE_URL>
#
# Example:
#   ./scripts/run-migrations.sh "postgresql://postgres:password@localhost:5432/sprintable"
#
# story #3219(2026-08-30, 카디르 3618 QA 4라운드 실측) — 예전엔
# `psql ... | grep -v "^$" | head -5` 뒤 `$?`를 봤는데, 파이프의 마지막 명령은
# `head`(거의 항상 성공)라 psql 자신의 실패 종료코드가 그 자리에서 이미 사라진 뒤였다
# (grep -v "^$" 도 매치 없으면 1을 내는 별개 함정). 게다가 걸렸어도 "⚠️ Warning" 한 줄
# 찍고 다음 파일로 넘어갈 뿐 — 마이그 하나가 깨져도 컨테이너는 계속 뜬다(조용한 부분
# 적용). self-host 사용자에게 스키마가 "일부만 반영된 채" 정상처럼 보이는 신뢰 결함.
#
# 처방: 파이프를 없애 종료코드가 살아있는 상태로 직접 psql을 조건문에 건다(set -e도
# 파이프 안에서는 안 걸리므로 애초에 파이프 자체를 없애는 게 정공법). `-v
# ON_ERROR_STOP=1`로 psql이 한 파일 안에서도 첫 에러에서 즉시 멈추게 하고(기존엔 에러
# 줄만 찍고 다음 문장으로 계속 갔다), 실패 시 그 파일에서 즉시 exit 1 — ENTRYPOINT의
# `&&` 체인이 뒤의 `node apps/web/server.js`를 아예 안 돈다(fail-closed, 부분 적용
# 상태로는 앱이 안 뜬다). `set -eu`만 쓰고 `pipefail`은 안 쓴다 — 이 스크립트가 돌아가는
# 실 런타임(Dockerfile의 node:22-alpine, ENTRYPOINT가 `/bin/sh -c`로 호출)은 busybox
# ash라 POSIX에 없는 `pipefail`을 모른다(bash 확장) — 그리고 애초에 파이프를 없앴으니
# 필요도 없다.

set -eu

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
  name="$(basename "$file")"
  echo "  → $name"
  if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$file"; then
    echo "  ✅ OK: $name"
  else
    echo "  ❌ FAILED: $name — fail-closed 기동 중단"
    exit 1
  fi
done

echo "✅ Migrations complete."
