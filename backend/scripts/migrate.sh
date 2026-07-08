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
#
# story 21ade1fa 후속(2026-07-07 dev 파이프라인 장애 근본수정): 원래 "0147" not in heads라는
# **리터럴 문자열 매칭**이었다 — 0162(ee_pricing 0147 + core 0161 merge node) 적용 후 current가
# "0162" 하나로 합쳐지면(0147을 정확히 승계했음에도) "0147"이라는 문자열이 alembic_version에
# 더는 안 보여 매번 오탐 재발했다(실측: 04:43 정상 0162 도달 → 04:53 재실행에서 오탐으로 다시
# `alembic stamp 0147` 실행 → 0148-0161 재실행 → role_templates DuplicateTable). 리터럴 매칭을
# **그래프 조상관계(ancestry) 검증**으로 교체 — "0147"이 현재 head(들)의 실제 조상인지
# ScriptDirectory로 walk해서 판단하므로, 0162 이후 어떤 미래 리비전이 추가돼도 영구히 안전하다.
#
# 승격(2026-07-08, PR #1977) 후속 근본수정: main은 story bda4beac 이후 0146/0147/0162
# **파일 자체가 없다**(ee_pricing 영구 제외) — 그런데 위 ancestry 검증은 "0147"이 현재 head의
# 조상인지를 ScriptDirectory로 walk해서 판단하므로, 0147이 애초에 등록된 리비전이 아닌 main
# 환경에서는 그 어떤 head에 대해서도 **영원히** False가 나온다(0148이 0147 대신 0145를 직접
# 가리키게 reparent됐으므로 그래프가 아예 0147을 지나지 않는다). 즉 uq 제약만 있으면(0148 이후
# 모든 DB가 다 그렇다) 매번 EE_STAMP_NEEDED=1이 뜨고, `alembic stamp 0147`이 등록되지 않은
# 리비전이라 "Can't locate revision identified by '0147'"로 죽는다(prod migrate job 2026-07-08
# 실패 재현). 애초에 0147이 파일로 없는 환경에선 `alembic upgrade heads`가 그 DDL을 재실행할
# 길 자체가 없어(파일이 없으니 실행할 코드가 없다) 이 precheck가 막으려는 DuplicateTable
# 시나리오가 구조적으로 불가능하다 — precheck 자체가 통째로 no-op이어야 정확하다. "0147"이
# ScriptDirectory에 등록된 리비전인지부터 먼저 확인해, 없으면(main/prod) uq 제약 존재 여부와
# 무관하게 즉시 0(스탬프 불필요)으로 판정한다.
echo "[migrate] EE-stamp precheck: checking uq_org_subscriptions_org_id..."
EE_STAMP_NEEDED=$(python3 <<'PYEOF'
import os
from sqlalchemy import create_engine, text
from alembic.config import Config
from alembic.script import ScriptDirectory

cfg = Config("alembic.ini")
script = ScriptDirectory.from_config(cfg)
try:
    script.get_revision("0147")
    revision_0147_known = True
except Exception:
    revision_0147_known = False

if not revision_0147_known:
    # main/prod: 0146/0147/0162 파일 자체가 없다 — 이 precheck이 막으려는 "0147 DDL 재실행"
    # 시나리오가 구조적으로 불가능(파일이 없으니 alembic이 그 revision을 실행할 방법이 없다).
    print(0)
else:
    engine = create_engine(os.environ["ALEMBIC_DATABASE_URL"])
    with engine.connect() as conn:
        constraint_exists = conn.execute(
            text("SELECT 1 FROM pg_constraint WHERE conname = 'uq_org_subscriptions_org_id'")
        ).scalar()
        if not constraint_exists:
            print(0)
        else:
            try:
                heads = [row[0] for row in conn.execute(text("SELECT version_num FROM alembic_version"))]
            except Exception:
                heads = []
            if not heads:
                # alembic이 이 DB를 전혀 트래킹한 적 없는데 제약은 물리적으로 존재 — 진짜 구 체인 케이스.
                print(1)
            else:
                try:
                    already_applied = any(
                        rev is not None and rev.revision == "0147"
                        for rev in script.iterate_revisions(heads, "base")
                    )
                    print(0 if already_applied else 1)
                except Exception:
                    # 그래프 walk 실패 시 안전한 쪽(스탬프 안 함)으로 fail — 잘못된 재스탬프로
                    # 이미 정상인 alembic_version을 파괴하는 것보다, 다음 실행에서 재판단하는 게 낫다.
                    print(0)
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
