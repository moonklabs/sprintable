"""story #2386 — `scripts/jobs/` 안에서 DB에 붙는 스크립트가 `DATABASE_URL`을 직접 읽고
`_db_env.resolve_database_url()`(#2769)을 안 거치면 CI가 잡는다.

배경: `sprintable-verify-oneoff`(dev Cloud Run Job)의 환경은 `DATABASE_URL`이 아니라
`ALEMBIC_URL`만 준다. 이 폴백 없이 이동/작성된 스크립트는 로컬(항상 DATABASE_URL 있음)에선
멀쩡히 돌다가 그 잡에서만 "DATABASE_URL 미설정"으로 죽는다 — 이미 세 번 반복됐다:
  2026-07-31  오르테가, backfill_reference_semantic_candidates.py에 인라인으로 처음 붙임
  2026-08-01  카디르군 REQUEST_CHANGES, story #2384가 옮긴 두 스크립트에 누락된 것을 잡음
  2026-08-01  이 스토리 — 옮기기 전부터 있던 다섯(아래 AC3 참고)이 같은 구멍으로 남아 있었다
매번 "그때그때 손으로 고친다"였지 재발을 막는 자리가 없었다 — 이 lint가 그 자리다.

## AC5 — 판별은 allowlist가 아니라 «파생»이다
#2769의 `test_2384_scripts_root_image_exclusion_lint.py`는 손으로 유지하는 allowlist를 쓰지만,
여기서는 그 방식을 안 따른다 — "DB에 안 붙는 스크립트는 대상 아님"을 실제 import(
`app.core.database`)로 판별한다. 지금 `scripts/jobs/`의 유일한 비-DB 파일(`_db_env.py` 자신)이
이 조건 하나로 이미 정확히 빠진다(아래 test로 실측) — 손 allowlist를 하나 더 만들면 그 자체가
#2387이 잡으려는 "손 스냅샷" 병의 다섯 번째 사례가 된다. `resolve_database_url`을 실제로
호출하는지까지는 안 본다(문자열 존재만) — AC6 참고.

## AC6 — 이 lint가 못 잡는 것
  ㉠`resolve_database_url` 문자열이 있어도 실제로 **호출**하지 않거나(예: 그냥 import만),
    호출 위치가 `app.core.database` import보다 **뒤**면(늦은 폴백) 정적으로 못 잡는다 —
    `test_2384_scripts_jobs_alembic_url_fallback.py`가 그 세 스크립트에 한해 그 순서를
    실행으로 확認하지만, 이 lint는 문자열 존재만 보는 더 얕은 축이다.
  ㉡`app.core.database`를 안 거치고 다른 방식(raw psycopg2 등)으로 DB에 붙으면 `_touches_db`가
    False라 스코프 밖으로 빠진다 — 지금 레포에 그런 스크립트는 없다(실측, 아래 classify 참고).
  ㉢`scripts/jobs/` 밖(예: `backend/scripts/` 루트 — 그건 #2384의 다른 lint 담당)은 안 본다.
"""
from __future__ import annotations

import re
from pathlib import Path

_SCRIPTS_JOBS_ROOT = Path(__file__).resolve().parent.parent / "scripts" / "jobs"

_APP_CORE_DATABASE_IMPORT_RE = re.compile(r"from\s+app\.core\.database\s+import|^\s*import\s+app\.core\.database", re.MULTILINE)
_RESOLVE_HELPER_RE = re.compile(r"resolve_database_url")

# _db_env.py 자신은 스캔 대상이 아니다 — 헬퍼 구현 자체라 app.core.database를 안 거치고
# (touches_db=False, 실측 확認) resolve_database_url을 "정의"할 뿐 "호출해 안전해질" 스크립트가
# 아니다. 별도 근거 문서화 없이도 아래 _touches_db 조건 하나로 이미 자동 제외된다.


def _touches_db(content: str) -> bool:
    return bool(_APP_CORE_DATABASE_IMPORT_RE.search(content))


def _uses_fallback_helper(content: str) -> bool:
    return bool(_RESOLVE_HELPER_RE.search(content))


def find_violations(root: Path) -> list[str]:
    """DB에 붙는데(app.core.database import) resolve_database_url 폴백을 안 쓰는 스크립트 이름."""
    violations = []
    for f in sorted(root.glob("*.py")):
        if f.name == "_db_env.py":
            continue
        content = f.read_text(encoding="utf-8")
        if _touches_db(content) and not _uses_fallback_helper(content):
            violations.append(f.name)
    return violations


# ── AC2 — 실제로 무는지: 폴백 없는 파일을 심어 빨개지는 것 + 정상 파일은 안 걸리는 것 ──

def test_flags_a_script_that_touches_db_without_the_fallback_helper(tmp_path):
    (tmp_path / "bad_script.py").write_text(
        "import os\nfrom app.core.database import async_session_factory\n"
        "if not os.environ.get('DATABASE_URL'):\n    raise SystemExit(2)\n",
        encoding="utf-8",
    )
    assert find_violations(tmp_path) == ["bad_script.py"]


def test_does_not_flag_a_script_using_the_fallback_helper(tmp_path):
    (tmp_path / "good_script.py").write_text(
        "from scripts.jobs._db_env import resolve_database_url\n"
        "_db_url_summary = resolve_database_url()\n"
        "from app.core.database import async_session_factory\n",
        encoding="utf-8",
    )
    assert find_violations(tmp_path) == []


def test_does_not_flag_a_script_that_never_touches_the_db(tmp_path):
    (tmp_path / "no_db_script.py").write_text(
        "import os\nprint('does not need DATABASE_URL at all')\n",
        encoding="utf-8",
    )
    assert find_violations(tmp_path) == []


# ── AC1/AC3 — 실제 저장소 ──────────────────────────────────────────────────

def test_scripts_jobs_use_resolve_database_url_fallback():
    violations = find_violations(_SCRIPTS_JOBS_ROOT)
    assert not violations, (
        f"scripts/jobs/에 DB에 붙는데 resolve_database_url() 폴백이 없는 스크립트: {violations}. "
        "sprintable-verify-oneoff(dev Cloud Run Job)는 DATABASE_URL이 아니라 ALEMBIC_URL만 줘서 "
        "이 스크립트들은 로컬에서만 멀쩡하고 그 잡에서는 죽는다. scripts/jobs/_db_env.py의 "
        "resolve_database_url()을 app.core.database import보다 먼저 호출하라 — "
        "backfill_reference_semantic_candidates.py를 참고."
    )


def test_db_env_helper_itself_is_excluded_because_it_does_not_touch_the_db():
    """_db_env.py가 스캔 대상에서 빠지는 이유가 하드코딩 allowlist가 아니라 실제 import 부재
    (touches_db=False)임을 실측으로 고정 — AC5가 파생이라고 주장하는 것의 증거."""
    content = (_SCRIPTS_JOBS_ROOT / "_db_env.py").read_text(encoding="utf-8")
    assert not _touches_db(content)
