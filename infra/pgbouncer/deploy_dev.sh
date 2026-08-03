#!/usr/bin/env bash
# infra/pgbouncer/deploy_dev.sh
# 인프라 Phase 1 (story #2445, 승인문서 doc:3dc965f4, 방향 B) — dev 검증용 중앙 PgBouncer.
#
# 목적: backend-dev → PgBouncer(:6432, transaction mode) → Cloud SQL dev 경로를 세워,
#       앱의 statement_cache_size=0 / LISTEN 직결 bypass / prepared stmt / VM failover 를
#       «라이브»로 검증한다(prod 전환 前 게이트).
#
# 규율:
#  - AC5: 손 gcloud 값 금지 → 이 스크립트가 SSOT. 값 바꿀 땐 여기서.
#  - 시크릿: VM 서비스계정이 런타임에 Secret Manager(DATABASE_URL_DEV)에서 비번을 읽는다.
#    스크립트/메타데이터에 «평문 비번을 굽지 않는다».
#  - dev 는 단일 VM(검증용). prod 는 MIG≥2 + Internal TCP LB(별 스크립트 deploy_prod.sh).
#  - 롤백: backend-dev 의 DB_PGBOUNCER=false 로 즉시 직결 복귀(앱 flag). 이 VM 은 남겨도 무해.
#
# 토폴로지(2026-08-03 실측):
#  - default VPC / default subnet(10.178.0.0/20, asia-northeast3)
#  - Cloud SQL dev private IP = 10.110.0.3:5432 (user=postgres, db=sprintable)
#  - backend-dev = Direct VPC egress(default/default) → VM 의 private IP 로 :6432 도달 가능
set -euo pipefail

PROJECT=sprintable-494803
REGION=asia-northeast3
ZONE=asia-northeast3-a
NETWORK=default
SUBNET=default
VM=pgbouncer-dev
MACHINE=e2-small
CLOUDSQL_DEV_IP=10.110.0.3
DB_NAME=sprintable
DB_USER=postgres
SECRET_NAME=DATABASE_URL_DEV     # VM SA 가 런타임에 읽어 비번 파싱

# PgBouncer 풀 사이징(dev 검증용·보수적). transaction mode 라 클라이언트 다수↔서버 소수.
POOL_MODE=transaction
DEFAULT_POOL_SIZE=20             # PgBouncer→Cloud SQL 서버 커넥션(인스턴스 1개 기준)
MAX_CLIENT_CONN=200             # 앱→PgBouncer 클라이언트 커넥션 상한
LISTEN_PORT=6432

# ── VM 서비스계정 (Secret 접근 최소권한) ──────────────────────────────────────
SA_NAME=pgbouncer-dev-sa
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

echo ">>> [1/5] 서비스계정 + 시크릿 접근 권한"
gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" \
    --display-name="PgBouncer dev VM (reads DATABASE_URL_DEV)"
# 이 시크릿 «하나»에만 accessor (최소권한)
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor" >/dev/null

echo ">>> [2/5] Cloud NAT (사설 VM egress — apt 설치용; default 망에 라우터/NAT 부재 실측)"
# no-address VM 은 인터넷이 없어 Debian apt repo(구글 API 아님 → Private Google Access 미커버)에
# 못 닿는다. Cloud NAT 로 egress 를 준다(기존 외부IP VM·Cloud Run 에 무영향·additive). prod 도 동일 필요.
NAT_ROUTER=pgbouncer-nat-router
gcloud compute routers describe "$NAT_ROUTER" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute routers create "$NAT_ROUTER" --network="$NETWORK" --region="$REGION" --project "$PROJECT"
gcloud compute routers nats describe pgbouncer-nat --router="$NAT_ROUTER" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute routers nats create pgbouncer-nat --router="$NAT_ROUTER" --region="$REGION" --project "$PROJECT" \
    --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges

echo ">>> [3/5] 방화벽 (VPC 내부 → VM:${LISTEN_PORT})"
# 태그 pgbouncer-dev 붙은 VM 의 6432 를 VPC 내부(default subnet + Cloud Run egress)에서 허용.
gcloud compute firewall-rules describe allow-pgbouncer-dev --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create allow-pgbouncer-dev --project "$PROJECT" \
    --network="$NETWORK" --direction=INGRESS --action=ALLOW \
    --rules="tcp:${LISTEN_PORT}" --source-ranges="10.178.0.0/20" \
    --target-tags="pgbouncer-dev" \
    --description="Phase1 #2445: allow VPC internal → PgBouncer dev :${LISTEN_PORT}"

echo ">>> [4/5] startup-script 렌더 (VM 안에서 PgBouncer 설치·설정·기동)"
# ⚠️ 이 startup 은 VM 안에서 실행된다. 비번은 여기서 «메타데이터가 아니라» Secret Manager 에서 읽는다.
STARTUP=$(cat <<STARTUP_EOF
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y pgbouncer postgresql-client jq

# --- 시크릿에서 DATABASE_URL_DEV 읽어 비번 파싱 (VM SA 토큰 사용) ---
TOKEN=\$(curl -s -H "Metadata-Flavor: Google" \
  "http://metadata/computeMetadata/v1/instance/service-accounts/default/token" | jq -r .access_token)
DBURL=\$(curl -s -H "Authorization: Bearer \$TOKEN" \
  "https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET_NAME}/versions/latest:access" \
  | jq -r .payload.data | base64 -d)
# postgresql+asyncpg://USER:PASS@/DB?host=... 에서 PASS 추출
DBPASS=\$(printf '%s' "\$DBURL" | sed -E 's|^[^:]+://[^:]+:([^@]+)@.*|\1|')

# --- pgbouncer.ini (transaction mode·Cloud SQL dev 직접 IP) ---
cat > /etc/pgbouncer/pgbouncer.ini <<INI
[databases]
${DB_NAME} = host=${CLOUDSQL_DEV_IP} port=5432 dbname=${DB_NAME}

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
admin_users = ${DB_USER}
INI

# --- userlist: 클라이언트 인증 + 서버 연결용 (dev 검증: plain·VPC 내부·잠금 VM) ---
# ⚠️ prod 는 SCRAM 검증자/auth_query 로 하드닝(deploy_prod.sh). 여기선 dev 검증 한정.
printf '"%s" "%s"\n' "${DB_USER}" "\$DBPASS" > /etc/pgbouncer/userlist.txt
chown postgres:postgres /etc/pgbouncer/userlist.txt
chmod 600 /etc/pgbouncer/userlist.txt

systemctl enable pgbouncer
systemctl restart pgbouncer
echo "pgbouncer-dev startup done: listening :${LISTEN_PORT} → Cloud SQL ${CLOUDSQL_DEV_IP}"
STARTUP_EOF
)

echo ">>> [5/5] VM 생성 (default subnet·태그 pgbouncer-dev·SA=${SA_EMAIL})"
if gcloud compute instances describe "$VM" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  echo "    VM 이미 존재 — startup 갱신하려면 삭제 후 재실행(또는 deploy 재설계). skip create."
else
  gcloud compute instances create "$VM" --project "$PROJECT" --zone "$ZONE" \
    --machine-type="$MACHINE" \
    --network-interface="subnet=${SUBNET},no-address" \
    --service-account="$SA_EMAIL" \
    --scopes="https://www.googleapis.com/auth/cloud-platform" \
    --tags="pgbouncer-dev" \
    --image-family=debian-12 --image-project=debian-cloud \
    --metadata=startup-script="$STARTUP"
fi

echo ">>> 완료. VM 내부 IP:"
gcloud compute instances describe "$VM" --zone "$ZONE" --project "$PROJECT" \
  --format="value(networkInterfaces[0].networkIP)"
echo "다음: (a) VM 에서 psql 로 Cloud SQL 직결·PgBouncer 경유 둘 다 확認 →"
echo "      (b) DATABASE_URL_DIRECT_DEV 시크릿 생성(직결 URL) + DATABASE_URL_DEV 를 PgBouncer 로 전환 →"
echo "      (c) backend-dev env(DB_PGBOUNCER=true 등) cloudbuild 배선(디디) → 앱 검증."
