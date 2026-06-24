#!/usr/bin/env bash
# E-MCP-HTTP prod 승격: prod Cloud Run 호스팅 — sprintable-mcp-prod 배포.
#
# deploy_mcp_dev.sh 의 prod 짝(동일 backend 이미지를 command override 로 MCP HTTP 서버 구동·별 빌드 0).
# ⚠️ gcloud 배포 실행은 **PO 전담**(인프라 lane). 이 스크립트는 PR 리뷰 대상·실행은 승인 후 PO.
#
# dev 와 차이(prod 값):
#   - service: sprintable-mcp-prod (host=sprintable-mcp-prod-787818285179.<region>.run.app)
#   - SPRINTABLE_API_URL: prod 백엔드
#   - MCP_ALLOWED_HOSTS: prod 게이트웨이 host **exact**(DNS-rebinding 보호 ON·dev 는 비워 OFF였음).
#       run.app(오리진) + mcp.sprintable.ai(고객 facing CF 도메인) additive·comma 값은 ^##^ escape.
#       allowed_origins 는 server.py 가 `https://{host}` 로 파생(브라우저 Origin). 커스텀 도메인 추가 시
#       comma 로 그 host 도 넣어야(서브도메인 와일드카드 미지원·exact).
#   - AGENT_API_KEY: Secret Manager 참조(--set-secrets). http 모드는 per-request bearer 가 실인증이라
#       이 값은 never-hit fallback이지만, prod 는 값 노출 0 위해 Secret 참조로 둔다(AGENT_API_KEY_SECRET
#       미지정 시 dev 와 동일한 per-request-bearer placeholder 로 폴백).
#
# 사용:
#   COMMIT_SHA=<prod-deployed-sha> AGENT_API_KEY_SECRET=<secret-name> ./scripts/deploy_mcp_prod.sh
#   (COMMIT_SHA 미지정 시 latest-prod·AGENT_API_KEY_SECRET 미지정 시 placeholder 폴백)
set -euo pipefail

REGION="asia-northeast3"
PROJECT="sprintable-494803"
AR="${REGION}-docker.pkg.dev/${PROJECT}/sprintable/backend"
SHA="${COMMIT_SHA:-latest-prod}"
PROD_BACKEND_URL="https://sprintable-backend-prod-787818285179.${REGION}.run.app"
# prod 게이트웨이 호스트 화이트리스트(exact·DNS-rebinding 보호 ON·comma).
#   - run.app: Cloud Run 직접/CF 오리진 Host(현행).
#   - mcp.sprintable.ai: 고객 facing 깔끔 도메인(CF route/Worker proxy). CF 가 원본 Host(mcp.sprintable.ai)
#     를 오리진에 전달하면 이게 없을 시 S2 transport_security 가 421 거부 → additive 로 함께 화이트리스트.
#     server.py 가 allowed_origins=https://{host} 파생(브라우저 Origin=https://mcp.sprintable.ai 도 커버).
PROD_MCP_HOSTS="sprintable-mcp-prod-787818285179.${REGION}.run.app,mcp.sprintable.ai"
# Secret Manager 참조(권장). 미지정 시 http 모드 never-hit fallback placeholder(dev 패턴 동일).
AGENT_API_KEY_SECRET="${AGENT_API_KEY_SECRET:-}"

echo ">>> deploy sprintable-mcp-prod (image=backend:${SHA})"
# non-secret env(단일 --set-env-vars·중복 지정 시 덮어쓰기되므로 하나로 조립).
# ⚠️ gcloud --set-env-vars 는 기본 comma 로 항목 구분 → MCP_ALLOWED_HOSTS 값에 comma(다중 호스트)가
#   들어가면 오파싱된다. 커스텀 구분자(`^##^` prefix=구분자를 ## 로) 사용(gcloud 표준 이스케이프).
ENV_VARS="^##^MCP_TRANSPORT=http##SPRINTABLE_API_URL=${PROD_BACKEND_URL}##MCP_ALLOWED_HOSTS=${PROD_MCP_HOSTS}"
COMMON_ARGS=(
  --image="${AR}:${SHA}"
  --region="${REGION}"
  --command="python"
  --args="-m,sprintable_mcp"
  --allow-unauthenticated
  --min-instances=0
  --max-instances=2
  --port=8080
  --quiet
)
if [[ -n "${AGENT_API_KEY_SECRET}" ]]; then
  # Secret Manager 참조(값 노출 0). never-hit fallback이지만 prod 는 secret 로 둔다.
  gcloud run deploy sprintable-mcp-prod "${COMMON_ARGS[@]}" \
    --set-env-vars="${ENV_VARS}" \
    --set-secrets="AGENT_API_KEY=${AGENT_API_KEY_SECRET}:latest"
else
  # 폴백: http 모드 per-request bearer 가 실인증(dev 동일). placeholder 안전.
  gcloud run deploy sprintable-mcp-prod "${COMMON_ARGS[@]}" \
    --set-env-vars="${ENV_VARS}##AGENT_API_KEY=_http_per_request_bearer_only_"
fi

echo ">>> health 확認"
URL="$(gcloud run services describe sprintable-mcp-prod --region="${REGION}" --format='value(status.url)')"
echo "service URL: ${URL}  (MCP: ${URL}/mcp)"
curl -fsS "${URL}/health" && echo "  ✓ /health 200"
echo ">>> 401(키無) 확認: $(curl -s -o /dev/null -w '%{http_code}' -X POST "${URL}/mcp")  (401 기대)"
