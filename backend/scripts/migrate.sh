#!/bin/sh
# Cloud Run 마이그레이션 잡 진입점.
# CWD를 /app으로 명시해 alembic.ini script_location 해소.
# 환경 변수: ALEMBIC_DATABASE_URL (Private-IP psycopg2 URL) 필수.
set -eu

if [ -z "${ALEMBIC_DATABASE_URL:-}" ]; then
  echo "ERROR: ALEMBIC_DATABASE_URL is not set." >&2
  echo "Set it to a Private-IP psycopg2 URL: postgresql+psycopg2://user:pass@IP/db" >&2
  exit 1
fi

# story bda4beac: pricing(ee) 마이그(0146/0147)가 core 체인(0145→0148→0149+)과 분기된
# 별도 head라 이미지에 그 파일이 없는 환경(main/prod)에선 head가 1개, 있는 환경(develop/ee
# 빌드)에선 2개다 — `heads`(복수)는 두 경우 모두 안전(단일-head 환경에서도 그대로 동작).
cd /app

# story dbda0baf(E-RECRUIT S13) — #1886 EE-stamp 정합 게이트: bda4beac가 0146/0147을 별도
# head(ee_pricing)로 분기하기 전, 이미 그 구 리니어 체인(0145→0146→0147→0148→...)을 물리
# 실행한 DB는 alembic_version에 ee_pricing head(0147)가 기록돼 있지 않다 — `upgrade heads`가
# 0147을 미적용으로 오인해 0146/0147 DDL을 재실행하려다 DuplicateTable로 죽는다(2026-07-05
# dev 재현). uq_org_subscriptions_org_id(0148이 만드는 제약)는 이 구 체인을 이미 탔다는 정확한
# 물리 신호(#1886 dev_ee_stamp_precheck.sh 에서 확립된 기준 — pricing_versions 테이블 존재만
# 보는 것보다 정밀). 매 실행 시 자동 검사해 필요하면 self-heal stamp 하므로 더 이상 수동
# override 스크립트를 기억해뒀다 돌릴 필요가 없다(이 파일이 canonical 진입점이라 드리프트 재발 불가).
echo "[migrate] EE-stamp precheck: checking uq_org_subscriptions_org_id..."
EE_STAMP_NEEDED=$(python3 <<'PYEOF'
import os
from sqlalchemy import create_engine, text

engine = create_engine(os.environ["ALEMBIC_DATABASE_URL"])
with engine.connect() as conn:
    constraint_exists = conn.execute(
        text("SELECT 1 FROM pg_constraint WHERE conname = 'uq_org_subscriptions_org_id'")
    ).scalar()
    if not constraint_exists:
        print(0)
    else:
        try:
            heads = {row[0] for row in conn.execute(text("SELECT version_num FROM alembic_version"))}
        except Exception:
            heads = set()
        print(1 if "0147" not in heads else 0)
PYEOF
)

if [ "${EE_STAMP_NEEDED}" = "1" ]; then
  echo "[migrate] precheck: old-chain constraint present + 0147 not stamped — stamping 0147 (add, preserves other heads)."
  alembic stamp 0147
else
  echo "[migrate] precheck: no action needed."
fi

echo "Running: alembic upgrade heads"
exec alembic upgrade heads
