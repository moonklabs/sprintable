#!/usr/bin/env bash
# story #2426 (2026-08-02) — 「파이프라인이 배포하는 서비스」와 「실제 존재하는 Cloud Run
# 서비스」가 갈리면 빨간불.
#
# ⛔왜 이 가드가 필요한가: cloudbuild.yaml 에 mcp 를 «더하는» 것만으로는 같은 일이 다시 난다.
#   다음에 서비스가 하나 더 생기면 또 목록 밖에 남는다 — 그리고 그것을 아무도 안 본다.
#   실제로 sprintable-mcp-{dev,prod} 가 그렇게 4일·449커밋 뒤처져 있었다.
#
# ⚠️이 가드가 «못 보는 것»(선언):
#   - 배포는 되는데 «환경변수»가 파이프라인 밖인 것은 안 본다(mcp 가 지금 그 상태다).
#   - 서비스가 «최신 이미지인지»는 안 본다 — 그건 각 deploy 스텝의 검산 몫이다.
#   - 이 가드는 「목록에 있는가」만 본다.
set -euo pipefail

REGION="${AR_REGION:-asia-northeast3}"
PROJECT="${GCP_PROJECT:-sprintable-494803}"
CB="${CLOUDBUILD_PATH:-cloudbuild.yaml}"

# 이 레포의 파이프라인이 배포하지 «않는» 서비스 — «왜»를 반드시 적는다.
# ⚠️같은 GCP 프로젝트에 «다른 레포»의 서비스가 함께 산다. 그것들을 「누락」으로 세면
#   이 가드가 잡은 것을 전부 고쳐도 사고가 안 줄어든다(= 틀린 것을 세는 자가 된다).
#   그래서 «이 레포 밖»임을 이유로 명시해 뺀다 — 이름만 보고 빼지 않는다.
INTENTIONALLY_UNMANAGED=(
  "sprintable-admin-web"       # moonklabs/sprintable-admin 레포 소유 — 이 파이프라인 밖
  "sprintable-admin-web-dev"   # 위와 같음
  "sprintable-internal-api"    # moonklabs/sprintable-admin 레포 소유 — 배포 자동화가 아예 없다
  "sprintable-internal-api-dev" # 위와 같음 (수동 gcloud run deploy)
)

echo "== cloudbuild.yaml 이 배포하는 서비스 =="
# `gcloud run deploy <name>` · `gcloud run services update <name>` 둘 다 센다.
# ⚠️호출 형태가 스텝마다 다르다 — deploy-frontend 는 YAML args 배열, deploy-backend/realtime 은
# bash 한 줄, deploy-mcp 는 `services update`. 그래서 «명령 형태»가 아니라 «서비스 이름 자체»를
# 찾는다. 주석 줄과 인라인 주석은 걷어낸다(설명문에도 같은 이름이 나온다).
# ⚠️mapfile 은 bash 4+ 라 macOS 기본 bash(3.2)에서 안 돈다 — 「CI 에서만 돌아가는 가드」가
# 되지 않게 이식 가능한 형태로 읽는다.
#
# ⛔story #2812(미르코군 발견, 2026-08-19) — 이 regex가 «sprintable-» 접두어를 하드코딩해서
#   그 접두어를 안 쓰는 서비스(office-converter, story #2771/PR #3230)가 늘 때마다 위양성이
#   재발하는 클래스였다. 접두어 무관 패턴으로 넓힌다.
#
# ⚠️이 넓힌 패턴이 «못 보는 것/과다포획하는 것»(선언, 실측 확認 — cloudbuild.yaml a7648b65d):
#   - `cloudrun-runtime-${_DEPLOY_ENV}` (IAM 서비스어카운트 이름 조각) · `latest-${_DEPLOY_ENV}`
#     (이미지 태그) · `mcp-${_DEPLOY_ENV}`(echo 메시지 문자열 안의 축약 표기, sprintable-mcp
#     와 별개 매치)도 declared 목록에 잡힌다 — 전부 실제 Cloud Run 서비스 이름과 우연히도
#     안 겹쳐(어떤 actual 서비스의 `-(dev|prod)$` 제거 base도 이 문자열이 아님) 「틀린 커버로
#     세는」 오탐(=실제로 안 배포되는 서비스를 배포된다고 오판)은 안 일으킨다 — 다만 declared
#     목록 출력이 지저분해지는 건 알려진 잔여 비용이다. 더 좁히려면 `gcloud run deploy`/
#     `services update` 커맨드 컨텍스트에 앵커링해야 하는데, 그러면 위 ⚠️(YAML args 배열 형태인
#     deploy-frontend/run-migrate-job)를 다시 놓친다 — 그래서 이 트레이드오프를 그대로 유지한다.
declared=()
while IFS= read -r line; do declared+=("$line"); done < <(
  sed -E 's/#.*//' "$CB" \
    | grep -oE '[a-z][a-z-]*-\$\{_DEPLOY_ENV\}' \
    | sed -E 's/\$\{_DEPLOY_ENV\}//' | sort -u
)
printf '  %s{dev,prod}\n' "${declared[@]}"

if [ "${#declared[@]}" -eq 0 ]; then
  echo "FAIL: cloudbuild.yaml 에서 배포 대상을 하나도 못 찾았다 — 이 스크립트의 패턴이 낡았을 수 있다."
  echo "      (자기 재료를 못 찾으면 초록이 아니라 빨강이어야 한다)"
  exit 1
fi

# 양성대조(story #2812 AC2) — office-converter 는 「sprintable- 접두어 없는」 첫 실사례다.
# 이 접두어 무관 regex가 실제로 그걸 잡는지 스스로 증명한다 — 못 잡으면(예: 누가 다시
# `sprintable-` 접두어를 규칙에 하드코딩하면) 조용히 넘어가지 않고 여기서 즉시 빨간불이어야
# 한다.
_office_converter_covered=0
for d in "${declared[@]}"; do
  [ "$d" = "office-converter-" ] && _office_converter_covered=1 && break
done
if [ "$_office_converter_covered" -ne 1 ]; then
  echo "FAIL: 양성대조 실패 — office-converter-\${_DEPLOY_ENV} 가 declared 목록에 안 잡혔다."
  echo "      (접두어 무관 패턴이 story #2812 이전으로 퇴행했을 수 있다)"
  exit 1
fi

echo
echo "== 실제 Cloud Run 서비스 (${REGION}) =="
actual=()
while IFS= read -r line; do actual+=("$line"); done < <(
  gcloud run services list --region="$REGION" --project="$PROJECT" \
    --format='value(metadata.name)' | sort
)
printf '  %s\n' "${actual[@]}"

echo
echo "== 대조 =="
missing=()
for svc in "${actual[@]}"; do
  base="$(echo "$svc" | sed -E 's/-(dev|prod)$//')-"
  covered=0
  for d in "${declared[@]}"; do
    [ "$d" = "$base" ] && covered=1 && break
  done
  # ⚠️bash 3.2 + `set -u` 에서 «빈 배열» 확장은 unbound variable 로 터진다 — 길이를 먼저 본다.
  if [ "${#INTENTIONALLY_UNMANAGED[@]}" -gt 0 ]; then
    for u in "${INTENTIONALLY_UNMANAGED[@]}"; do
      [ "$u" = "$svc" ] && covered=1 && break
    done
  fi
  [ "$covered" -eq 0 ] && missing+=("$svc")
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "FAIL: 파이프라인이 배포하지 않는 Cloud Run 서비스가 있다:"
  printf '  - %s\n' "${missing[@]}"
  echo
  echo "고칠 길 둘:"
  echo "  ① cloudbuild.yaml 에 배포 스텝을 더한다 (기본)"
  echo "  ② 의도적으로 밖에 두는 것이면 이 스크립트의 INTENTIONALLY_UNMANAGED 에"
  echo "     «이유와 함께» 적는다 — 이유 없이 넣지 말 것"
  exit 1
fi

echo "OK: 실제 서비스 ${#actual[@]}개가 모두 파이프라인 안에 있다."
