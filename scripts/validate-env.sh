#!/bin/sh
# AC7: 필수 환경변수 검증 — 누락 시 시작 차단 + 명확한 에러

REQUIRED_VARS="NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_APP_URL"
MISSING=""

for var in $REQUIRED_VARS; do
  eval val=\$$var
  if [ -z "$val" ]; then
    MISSING="$MISSING $var"
  fi
done

if [ -n "$MISSING" ]; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  ERROR: Missing required environment variables              ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  for var in $MISSING; do
    echo "║  ❌  $var"
  done
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  Copy .env.example → .env and fill in the values.          ║"
  echo "║  See docs/self-hosting.md for details.                     ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  exit 1
fi

echo "✅ Environment validation passed."
