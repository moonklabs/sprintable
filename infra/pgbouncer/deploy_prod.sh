#!/usr/bin/env bash
# infra/pgbouncer/deploy_prod.sh   ⚠️DRAFT — 리뷰 + dev 부하테스트(#2446) 통과 «後» 실행.
# 인프라 Phase 1 (story #2445, 승인문서 doc:3dc965f4, 방향 B) — prod 중앙 PgBouncer (HA).
#
# dev(deploy_dev.sh, 단일 VM·검증 완료)와의 차이 = «HA»:
#   - 단일 VM → Regional MIG(≥2, 존 분산)
#   - VM 직결 → Internal TCP passthrough LB(:6432, VIP) 앞단
#   - 헬스체크 기반 auto-healing
# ⚠️이 스크립트는 «idle 인프라」만 만든다 — backend-prod 전환(DB_PGBOUNCER=true)은 별건이고,
#   dev+prod 부하테스트 통과가 그 gate. 즉 이걸 돌려도 prod 트래픽엔 무영향(아무도 안 가리킴).
#
# 풀 사이징(핵심): transaction mode 라 «클라이언트 다수 ↔ 서버 소수».
#   Cloud SQL prod max_connections=200. PgBouncer 인스턴스 2 × default_pool_size 80 = 160 서버커넥션
#   (≤200·20% 헤드룸). max_client_conn 은 크게(backend Cloud Run 인스턴스들이 클라이언트).
#   ⇒ backend 가 여러 인스턴스로 늘어도 Cloud SQL 은 160 안에서 유지 = #2442 사고의 근본 해소.
set -euo pipefail

PROJECT=sprintable-494803
REGION=asia-northeast3
NETWORK=default
SUBNET=default
CLOUDSQL_PROD_IP=10.110.0.5
CLOUDSQL_PROD_REPLICA_IP=10.110.0.16  # Phase3(#2451·§6): read replica sprintable-prod-replica(private·RUNNABLE)
DB_NAME=sprintable
DB_USER=postgres
SECRET_NAME=DATABASE_URL_PROD       # VM SA 가 런타임에 읽어 비번 파싱
MACHINE=e2-medium                    # prod: dev(e2-small)보다 여유
MIG_SIZE=2                           # HA(≥2·존 분산)
LISTEN_PORT=6432
POOL_MODE=transaction
DEFAULT_POOL_SIZE=80                 # ×2 인스턴스 = 160 서버커넥션(≤200)
MAX_CLIENT_CONN=1000

TMPL=pgbouncer-prod-tmpl
MIG=pgbouncer-prod-mig
HC=pgbouncer-prod-hc
BES=pgbouncer-prod-bes
FR=pgbouncer-prod-fr
SA_NAME=pgbouncer-prod-sa
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
TAG=pgbouncer-prod

echo ">>> [1/7] 서비스계정 + 시크릿(DATABASE_URL_PROD) 최소권한 accessor"
gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" --display-name="PgBouncer prod MIG (reads DATABASE_URL_PROD)"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor" >/dev/null

echo ">>> [2/7] Cloud NAT (dev 에서 이미 생성됨 — 없으면 생성; region 공용)"
gcloud compute routers describe pgbouncer-nat-router --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute routers create pgbouncer-nat-router --network="$NETWORK" --region="$REGION" --project "$PROJECT"
gcloud compute routers nats describe pgbouncer-nat --router=pgbouncer-nat-router --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute routers nats create pgbouncer-nat --router=pgbouncer-nat-router --region="$REGION" --project "$PROJECT" \
    --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges

echo ">>> [3/7] 방화벽 — (a)헬스체크 범위→:${LISTEN_PORT} (b)백엔드 egress 대역→:${LISTEN_PORT}"
# GCP 내부 LB 헬스체크 범위: 130.211.0.0/22, 35.191.0.0/16
gcloud compute firewall-rules describe allow-hc-pgbouncer-prod --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create allow-hc-pgbouncer-prod --project "$PROJECT" --network="$NETWORK" \
    --direction=INGRESS --action=ALLOW --rules="tcp:${LISTEN_PORT}" \
    --source-ranges="130.211.0.0/22,35.191.0.0/16" --target-tags="$TAG" \
    --description="Phase1 #2445: LB health check → PgBouncer prod"
gcloud compute firewall-rules describe allow-pgbouncer-prod --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create allow-pgbouncer-prod --project "$PROJECT" --network="$NETWORK" \
    --direction=INGRESS --action=ALLOW --rules="tcp:${LISTEN_PORT}" \
    --source-ranges="10.178.0.0/20" --target-tags="$TAG" \
    --description="Phase1 #2445: VPC(backend egress) → PgBouncer prod :${LISTEN_PORT}"

echo ">>> [4/7] startup-script 렌더 (prod Cloud SQL·prod 풀 사이징)"
# ⚠️prod 인증: dev 와 동일 plain+userlist(VPC 내부·잠금 VM·시크릿 런타임 fetch). SCRAM/auth_query
#   하드닝은 follow-up(별건) — 첫 cutover 는 VPC-internal plain 으로 가고, 그 뒤 강화.
STARTUP=$(cat <<STARTUP_EOF
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y pgbouncer postgresql-client jq
TOKEN=\$(curl -s -H "Metadata-Flavor: Google" "http://metadata/computeMetadata/v1/instance/service-accounts/default/token" | jq -r .access_token)
DBURL=\$(curl -s -H "Authorization: Bearer \$TOKEN" "https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET_NAME}/versions/latest:access" | jq -r .payload.data | base64 -d)
export DBURL
DBUSER=\$(python3 -c 'import urllib.parse,os;print(urllib.parse.urlparse(os.environ["DBURL"]).username or "")')
DBPASS=\$(python3 -c 'import urllib.parse,os;print(urllib.parse.urlparse(os.environ["DBURL"]).password or "")')
cat > /etc/pgbouncer/pgbouncer.ini <<INI
[databases]
${DB_NAME} = host=${CLOUDSQL_PROD_IP} port=5432 dbname=${DB_NAME}
# Phase3(#2451): read replica 풀 — 클라이언트가 dbname=${DB_NAME}_read 로 붙으면 replica 로 라우팅.
# get_read_db(lag-tolerant 읽기)만 이 풀을 탄다. 풀당 default_pool_size(80)×MIG2 = 160 서버커넥션 → replica
# max_connections(master 상속·200 가정, cutover 前 SHOW 로 確認) 안. primary 풀은 그대로(무영향·additive).
${DB_NAME}_read = host=${CLOUDSQL_PROD_REPLICA_IP} port=5432 dbname=${DB_NAME}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${LISTEN_PORT}
auth_type = plain
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = ${POOL_MODE}
max_client_conn = ${MAX_CLIENT_CONN}
default_pool_size = ${DEFAULT_POOL_SIZE}
ignore_startup_parameters = extra_float_digits
server_tls_sslmode = require
admin_users = \$DBUSER
INI
printf '"%s" "%s"\n' "\$DBUSER" "\$DBPASS" > /etc/pgbouncer/userlist.txt
chown postgres:postgres /etc/pgbouncer/userlist.txt
chmod 600 /etc/pgbouncer/userlist.txt
systemctl enable pgbouncer
systemctl restart pgbouncer
echo "pgbouncer-prod startup done: :${LISTEN_PORT} → Cloud SQL ${CLOUDSQL_PROD_IP} (pool ${DEFAULT_POOL_SIZE})"
STARTUP_EOF
)
# --metadata-from-file: gcloud --metadata=K=V splits on ',' and '=', which the startup script
# contains (e.g. `import urllib.parse,os`, INI `key = val`). A file sidesteps that parsing entirely.
STARTUP_FILE=$(mktemp /tmp/pgb-prod-startup.XXXXXX)
printf '%s' "$STARTUP" > "$STARTUP_FILE"

echo ">>> [5/7] 인스턴스 템플릿"
gcloud compute instance-templates describe "$TMPL" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute instance-templates create "$TMPL" --project "$PROJECT" \
    --machine-type="$MACHINE" --network="$NETWORK" --subnet="projects/${PROJECT}/regions/${REGION}/subnetworks/${SUBNET}" --no-address \
    --service-account="$SA_EMAIL" --scopes="https://www.googleapis.com/auth/cloud-platform" \
    --tags="$TAG" --image-family=debian-12 --image-project=debian-cloud \
    --metadata-from-file=startup-script="$STARTUP_FILE"

echo ">>> [6/7] Regional MIG(≥${MIG_SIZE}·존 분산) + 헬스체크 auto-healing"
# Internal passthrough LB requires a REGIONAL health check (global HC rejected by regional backend-service).
gcloud compute health-checks describe "$HC" --region="$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute health-checks create tcp "$HC" --region="$REGION" --project "$PROJECT" --port="$LISTEN_PORT" \
    --check-interval=10s --timeout=5s --healthy-threshold=2 --unhealthy-threshold=3
gcloud compute instance-groups managed describe "$MIG" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute instance-groups managed create "$MIG" --project "$PROJECT" --region="$REGION" \
    --template="$TMPL" --size="$MIG_SIZE" \
    --health-check="projects/${PROJECT}/regions/${REGION}/healthChecks/${HC}" --initial-delay=120

echo ">>> [7/7] Internal TCP passthrough LB (:${LISTEN_PORT} VIP)"
gcloud compute backend-services describe "$BES" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute backend-services create "$BES" --project "$PROJECT" --region="$REGION" \
    --load-balancing-scheme=INTERNAL --protocol=TCP --health-checks="$HC" --health-checks-region="$REGION"
gcloud compute backend-services add-backend "$BES" --project "$PROJECT" --region="$REGION" \
  --instance-group="$MIG" --instance-group-region="$REGION" 2>/dev/null || true
gcloud compute forwarding-rules describe "$FR" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute forwarding-rules create "$FR" --project "$PROJECT" --region="$REGION" \
    --load-balancing-scheme=INTERNAL --network="$NETWORK" --subnet="projects/${PROJECT}/regions/${REGION}/subnetworks/${SUBNET}" \
    --ip-protocol=TCP --ports="$LISTEN_PORT" --backend-service="$BES" --backend-service-region="$REGION"

echo ">>> 완료. Internal LB VIP(=backend-prod 가 가리킬 주소):"
gcloud compute forwarding-rules describe "$FR" --region "$REGION" --project "$PROJECT" --format="value(IPAddress)"
echo "다음(gate: dev+prod 부하테스트 통과 後): DATABASE_URL_PROD_PGBOUNCER 시크릿(=VIP:6432) 생성 →"
echo "     cloudbuild prod 분기 DB_PGBOUNCER=true + --update-secrets(prod) 배선(디디) → backend-prod 전환."
