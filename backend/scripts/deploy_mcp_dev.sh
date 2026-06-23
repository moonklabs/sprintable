#!/usr/bin/env bash
# E-MCP-HTTP S2: dev Cloud Run 호스팅 — sprintable-mcp-dev 배포(dev-only·prod 승격 별도 승인).
#
# ⭐동일 backend 이미지를 command override 로 MCP HTTP 서버로 구동(Dockerfile 이 sprintable_mcp/ 동봉·
#   backend pyproject 가 mcp>=1.8.0+uvicorn 보유). 별 빌드 0.
#
# 흐름: 이 BE PR 머지 → CB 가 dev backend 이미지 갱신(:latest-dev 또는 :<SHA>) → 이 스크립트로 배포.
# 인증: per-connection bearer(미들웨어). --allow-unauthenticated = Cloud Run IAM public(키 게이트는
#   앱 레이어). #1655 패턴(명시 설정·403 사전봉쇄).
#
# 사용: COMMIT_SHA=<sha> ./scripts/deploy_mcp_dev.sh    (미지정 시 latest-dev)
set -euo pipefail

REGION="asia-northeast3"
PROJECT="sprintable-494803"
AR="${REGION}-docker.pkg.dev/${PROJECT}/sprintable/backend"
SHA="${COMMIT_SHA:-latest-dev}"
DEV_BACKEND_URL="https://sprintable-backend-dev-787818285179.${REGION}.run.app"
# AGENT_API_KEY 는 http 모드 never-hit fallback(per-request bearer 가 실키)·placeholder 안전.
ENV_KEY="${AGENT_API_KEY:-_http_per_request_bearer_only_}"

echo ">>> deploy sprintable-mcp-dev (image=backend:${SHA})"
gcloud run deploy sprintable-mcp-dev \
  --image="${AR}:${SHA}" \
  --region="${REGION}" \
  --command="python" \
  --args="-m,sprintable_mcp" \
  --set-env-vars="MCP_TRANSPORT=http,SPRINTABLE_API_URL=${DEV_BACKEND_URL},AGENT_API_KEY=${ENV_KEY}" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --port=8080 \
  --quiet

echo ">>> health 확認"
URL="$(gcloud run services describe sprintable-mcp-dev --region="${REGION}" --format='value(status.url)')"
echo "service URL: ${URL}  (MCP: ${URL}/mcp)"
curl -fsS "${URL}/health" && echo "  ✓ /health 200"
echo ">>> 401(키無) 확認: $(curl -s -o /dev/null -w '%{http_code}' -X POST "${URL}/mcp")  (401 기대)"
