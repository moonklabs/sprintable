#!/bin/sh
# story bda4beac 후속: dev/ee DB가 과거 리니어 체인(0145->0146->0147->0148->0149+)을 이미
# 물리 실행했는지 정확히 판별해(0148이 만드는 uq_org_subscriptions_org_id 제약 존재 여부로
# 판정 — 까심 MUST-FIX: pricing_versions 테이블 존재만으론 부정확할 수 있어 이 제약 자체를
# 직접 확인) stamp 필요 여부를 분기한다.
#
# 존재(이미 물리 적용됨) -> `alembic stamp heads`로 그래프 분기(ee_pricing 0147을 별도 head로)
#   먼저 알려준 뒤 `alembic upgrade heads`(no-op 확인).
# 부재(한 번도 그 체인을 안 돈 DB) -> stamp 불필요, `alembic upgrade heads`만 바로 실행
#   (일반 증분 캐치업 — ee_pricing 브랜치까지 정상 적용됨).
#
# 환경 변수: ALEMBIC_DATABASE_URL (Private-IP psycopg2 URL) 필수 — migrate.sh와 동일.
set -eu

if [ -z "${ALEMBIC_DATABASE_URL:-}" ]; then
  echo "ERROR: ALEMBIC_DATABASE_URL is not set." >&2
  echo "Set it to a Private-IP psycopg2 URL: postgresql+psycopg2://user:pass@IP/db" >&2
  exit 1
fi

cd /app

echo "[precheck] checking uq_org_subscriptions_org_id constraint existence..."
EXISTS=$(python3 <<'PYEOF'
import os
from sqlalchemy import create_engine, text

engine = create_engine(os.environ["ALEMBIC_DATABASE_URL"])
with engine.connect() as conn:
    row = conn.execute(
        text("SELECT 1 FROM pg_constraint WHERE conname = 'uq_org_subscriptions_org_id'")
    ).scalar()
print(1 if row else 0)
PYEOF
)

echo "[precheck] uq_org_subscriptions_org_id exists=${EXISTS}"

if [ "${EXISTS}" = "1" ]; then
  echo "[precheck] constraint already present — this DB physically ran the old linear"
  echo "chain (0145->0146->0147->0148->0149+) before the graph split. Stamping both"
  echo "heads so the split graph matches physical reality, then confirming no-op."
  alembic current
  alembic heads
  alembic stamp heads
  alembic current
  echo "Running: alembic upgrade heads (expect no-op)"
  alembic upgrade heads
else
  echo "[precheck] constraint absent — this DB never ran the old chain. Safe to"
  echo "upgrade directly, no stamp needed."
  echo "Running: alembic upgrade heads"
  alembic upgrade heads
fi
