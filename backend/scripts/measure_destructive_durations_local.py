#!/usr/bin/env python3
"""story #3383 — 로컬 사전점검용 재측정 도구. 템플릿 DB(sprintable_test_tpl, 미리
`build_destructive_schema_template.py`로 만들어져 있어야 한다)에서 매 destructive_schema
파일을 클론해 돌리고 실 소요를 재 `infra/destructive-schema-shard-weights.json`에 쓴다.

⚠️ 이 로컬 절대시간은 CI 절대시간이 아니다(로컬이 CI보다 ~6배 빠르다, story #3383 실측 —
GH Actions 공유 러너 특성) — **PR 머지 전 최종 커밋 스냅샷은 항상 실 CI 로그(각 샤드
job의 파일별 elapsed 출력)로 다시 검증해야 한다**(AC2 재측정 규칙, ci.yml 워크플로
주석 참고). 이 스크립트는 "새 destructive 파일을 추가한 뒤 극단적으로 느린 것부터
잡아내는" 빠른 사전점검 용도로 쓴다 — 파일 간 *상대* 비중은 로컬에서도 LPT 배분에
바로 쓸 수 있을 만큼 유효하다(실측 확認).

사용법:
    psql -c 'CREATE DATABASE sprintable_test_tpl'
    psql -d sprintable_test_tpl -c 'CREATE EXTENSION IF NOT EXISTS vector;'
    DATABASE_URL=postgresql+asyncpg://sprintable:sprintable@localhost:5432/sprintable_test_tpl \\
      uv run python scripts/build_destructive_schema_template.py
    uv run python scripts/measure_destructive_durations_local.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
WEIGHTS_PATH = REPO_ROOT / "infra" / "destructive-schema-shard-weights.json"

sys.path.insert(0, str(BACKEND_DIR / "scripts"))
from shard_destructive_tests import discover_files


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def main() -> int:
    files = discover_files(BACKEND_DIR)
    print(f"측정 대상: {len(files)}개 파일", file=sys.stderr)
    results: list[dict[str, object]] = []
    for i, f in enumerate(files):
        run(["dropdb", "-h", "localhost", "-U", "sprintable", "--if-exists", "sprintable_test_iso_bench"])
        run(["createdb", "-h", "localhost", "-U", "sprintable", "-T", "sprintable_test_tpl", "sprintable_test_iso_bench"])
        env = {
            "ALEMBIC_DATABASE_URL": "postgresql+psycopg2://sprintable:sprintable@localhost:5432/sprintable_test_iso_bench",
            "PARITY_TEST_DATABASE_URL": "postgresql+psycopg2://sprintable:sprintable@localhost:5432/sprintable_test_iso_bench",
            "DATABASE_URL": "postgresql+asyncpg://sprintable:sprintable@localhost:5432/sprintable_test_iso_bench",
            "PGPASSWORD": "sprintable",
        }
        full_env = {**os.environ, **env}
        t0 = time.monotonic()
        proc = subprocess.run(
            ["uv", "run", "pytest", "-q", f], cwd=BACKEND_DIR, env=full_env,
            capture_output=True, text=True, check=False,
        )
        elapsed = time.monotonic() - t0
        ok = proc.returncode == 0
        results.append({"file": f, "sec": round(elapsed, 2)})
        print(f"[{i+1}/{len(files)}] {elapsed:6.2f}s {'OK' if ok else 'FAIL'} {f}", file=sys.stderr)
        if not ok:
            print(proc.stdout[-2000:], file=sys.stderr)
            print(proc.stderr[-2000:], file=sys.stderr)

    total_sec = sum(r["sec"] for r in results)
    payload = {
        "_snapshot_policy": (
            "story #3383(2026-09-03) — 로컬 재측정(템플릿 DB 적용 후). 로컬 절대시간은 CI의 "
            "~1/6이지만(실측), 파일 간 상대 비중은 LPT 배분에 유효하다. 재측정 기준은 이전과 "
            "동일: (a) discover 파일 수가 이 스냅샷 대비 +20% 이상, (b) 샤드 간 CI 벽시계가 "
            "1.5배 이상 벌어짐, (c) 25분 천장 대비 여유가 다시 좁아짐."
        ),
        "source_run": "local-post-template-optimization",
        "measured_at": "2026-09-03",
        "total_files": len(results),
        "total_sec": round(total_sec, 1),
        "files": sorted(results, key=lambda r: -r["sec"]),
    }
    WEIGHTS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    print(f"OK: {WEIGHTS_PATH} 갱신 완료 — {len(results)}개 파일, 합계 {total_sec:.1f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
