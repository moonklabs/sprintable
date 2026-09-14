#!/bin/sh
# AC7: 필수 환경변수 검증 — 누락 시 시작 차단 + 명확한 에러

REQUIRED_VARS="NEXT_PUBLIC_APP_URL"
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

# KMS_PROVIDER=local(기본)일 때 LOCAL_KMS_MASTER_KEY 가 없으면 BYOM 자격증명 저장이
# "LOCAL_KMS_MASTER_KEY is required when KMS_PROVIDER=local" 로 실패한다
# (apps/web/src/lib/kms/provider.ts). BYOM 을 아직 안 쓰는 설치는 기동을 막지 않도록
# 차단하지 않고 경고만 한다 — 첫 BYOM 저장 시점에 실패하는 편이 낫다.
if [ -z "$LOCAL_KMS_MASTER_KEY" ] && [ "${KMS_PROVIDER:-local}" = "local" ]; then
  echo "⚠️  LOCAL_KMS_MASTER_KEY is not set (KMS_PROVIDER=local)."
  echo "    BYOM 자격증명 저장이 실패합니다. .env 에 아래를 추가하세요:"
  echo "      LOCAL_KMS_MASTER_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "    기존 .env 를 쓰던 설치는 이 줄이 없습니다(.env.example 갱신 이후 추가됨)."
fi

echo "✅ Environment validation passed."
