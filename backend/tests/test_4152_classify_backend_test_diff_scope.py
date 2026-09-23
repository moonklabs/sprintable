"""story #4152(CI·결정성, 페드루 PO CHANGES-1) —
classify_backend_test_diff_scope.sh 회귀가드.

detect-changed-scope가 shard_destructive_tests.py --check-elapsed --changed-files에
넘길 값을 정하는 판정 전체를 독립 스크립트로 뽑아(check_backend_relevant_diff.sh와
같은 이유로) 임시 git repo만으로 단위 검증한다.

핵심 방어선: backend/app·alembic·pyproject 같은 **코드/의존성** 변경이 기존 테스트를
진짜로 2.5배 느리게 만드는 회귀도, 그 테스트 파일 자신은 diff에 없다는 이유로 WARN
(diff-scoping)으로 숨으면 가드 목적 자체가 깨진다 — 좁히기(narrowed 목록)는 backend/
변경이 테스트 파일뿐이거나 0건인 PR(FE-only 등)에만 적용돼야 한다."""
from __future__ import annotations

import os
import subprocess

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
_SCRIPT = os.path.join(_SCRIPTS_DIR, "classify_backend_test_diff_scope.sh")


def _git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t.com",
             "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t.com"},
    )


def _write(repo, rel, content="v1\n"):
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def _init_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    (repo / "backend" / "scripts").mkdir(parents=True, exist_ok=True)
    dest = repo / "backend" / "scripts" / os.path.basename(_SCRIPT)
    dest.write_text(open(_SCRIPT).read())
    dest.chmod(0o755)
    _write(repo, "apps/web/src/components/unrelated.tsx", "export const X = 1\n")
    _write(repo, "backend/app/routers/other.py", "x = 1\n")
    _write(repo, "backend/tests/test_fake_existing.py", "def test_noop():\n    assert True\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    base_sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    return repo, base_sha


def _run(repo, base_sha, head_sha="HEAD"):
    return subprocess.run(
        ["bash", "backend/scripts/classify_backend_test_diff_scope.sh", base_sha, head_sha],
        cwd=str(repo), capture_output=True, text=True,
    )


def _line1(proc) -> str:
    """story #4163 — 줄1(기존 __ALL__/좁힌 테스트 목록 계약)만 뽑는다. 줄2 신설(변경
    app 모듈 목록) 뒤에도 기존 단언이 그대로 유효하도록 `.strip()` 단일값 비교를
    이걸로 교체."""
    lines = proc.stdout.splitlines()
    return lines[0] if lines else ""


def _line2(proc) -> str:
    """story #4163 신규 — 변경된 backend/app/**.py 모듈 목록 줄(공백 구분, 0건이면 빈 문자열)."""
    lines = proc.stdout.splitlines()
    return lines[1] if len(lines) > 1 else ""


def _line3(proc) -> str:
    """story #4163 신규 — __ALL__ 사유와 함께 변경된 backend/tests/*.py(혼합 변경 축)."""
    lines = proc.stdout.splitlines()
    return lines[2] if len(lines) > 2 else ""


def test_no_base_sha_push_context_returns_all():
    """push 이벤트 등 diff 정보 없음 — 안전측 폴백."""
    proc = subprocess.run(
        ["bash", _SCRIPT], capture_output=True, text=True, cwd=os.path.dirname(_SCRIPTS_DIR),
    )
    assert proc.returncode == 0
    assert _line1(proc) == "__ALL__"
    assert _line2(proc) == ""  # story #4163 — diff 정보 자체가 없어 app 목록도 판단 불가


def test_app_only_change_returns_all(tmp_path):
    """⭐CHANGES-1 핵심 — backend/app 코드만 바꾸면(테스트 파일 diff 0) 전부 RED
    후보. 이게 없으면 코드 변경이 만든 진짜 회귀가 WARN으로 숨는다."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/app/routers/other.py", "x = 2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "app change")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert _line1(proc) == "__ALL__"
    # story #4163 — 줄2에 변경 app 모듈이 실린다(narrowing이 먹을 재료).
    assert _line2(proc) == "app/routers/other.py"
    assert _line3(proc) == ""  # 같이 바뀐 테스트 파일 없음(순수 app-only)


def test_tests_only_change_returns_narrowed_list(tmp_path):
    """backend/tests/*.py만 바뀌면 그 목록으로 좁힌다(diff-scoping 적용 대상)."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/tests/test_fake_new.py", "def test_x():\n    assert True\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "test-only change")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert _line1(proc) == "tests/test_fake_new.py"
    assert _line2(proc) == ""  # __ALL__ 아닐 땐 줄2 의미 없음(빈 값)


def test_fe_only_change_returns_empty_narrowed_list(tmp_path):
    """FE-only PR(backend/ 변경 0건, 오늘 PR#4351 실사고와 동형) — backend/tests
    diff도 당연히 0건이라 빈 문자열(diff-scoping 적용, 전부 changed_files 밖)."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "apps/web/src/components/unrelated.tsx", "export const X = 2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "fe-only change")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert _line1(proc) == ""


def test_mixed_app_and_test_change_returns_all(tmp_path):
    """backend/app·backend/tests 둘 다 바뀌면(테스트 파일뿐 아님) 여전히 __ALL__ —
    «테스트 파일뿐이거나 0건»이 아닌 한 좁히기 적용 안 함."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/app/routers/other.py", "x = 3\n")
    _write(repo, "backend/tests/test_fake_new.py", "def test_x():\n    assert True\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "mixed change")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert _line1(proc) == "__ALL__"
    assert _line2(proc) == "app/routers/other.py"
    # story #4163 — 줄3: 같은 PR이 직접 건드린 테스트 파일도 실려야 narrowing이
    # "이 PR이 신설한 테스트 자신"을 WARN으로 흘려보내지 않는다(AC1).
    assert _line3(proc) == "tests/test_fake_new.py"


def test_alembic_migration_change_returns_all(tmp_path):
    """backend/alembic/versions/*.py도 «테스트 파일 아님»이라 __ALL__ — pyproject.toml
    등 backend/ 밑 그 외 의존성 변경도 같은 경로 패턴으로 자동 커버된다."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/alembic/versions/0999_fake.py", "# migration\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "migration change")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert _line1(proc) == "__ALL__"
    # story #4163 — alembic은 app/**.py 밖이라 줄2엔 안 실린다(import-그래프 narrowing
    # 대상이 아님 — 테스트가 마이그레이션 파일을 import하지 않는다).
    assert _line2(proc) == ""


def test_multiple_test_files_joined_with_space(tmp_path):
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/tests/test_fake_a.py", "def test_a():\n    assert True\n")
    _write(repo, "backend/tests/test_fake_b.py", "def test_b():\n    assert True\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "two new tests")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    files = set(_line1(proc).split())
    assert files == {"tests/test_fake_a.py", "tests/test_fake_b.py"}


# ── story #4163 — 줄2(변경 app 모듈 목록) 회귀가드 ──────────────────────────────
def test_multiple_app_files_changed_joined_with_space_on_line2(tmp_path):
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/app/routers/other.py", "x = 4\n")
    _write(repo, "backend/app/services/new_service.py", "y = 1\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "two app files changed")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert _line1(proc) == "__ALL__"
    modules = set(_line2(proc).split())
    assert modules == {"app/routers/other.py", "app/services/new_service.py"}


def test_app_file_deleted_counts_as_changed_on_line2(tmp_path):
    """삭제도 «app 모듈 변경»이다(그 모듈을 import하던 테스트가 여전히 영향권 —
    git diff --name-only는 삭제도 잡는다, add/delete 구분 없이 경로만 본다)."""
    repo, base_sha = _init_repo(tmp_path)
    (repo / "backend" / "app" / "routers" / "other.py").unlink()
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "delete app file")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert _line1(proc) == "__ALL__"
    assert _line2(proc) == "app/routers/other.py"


def test_4206_push_range_classifies_only_that_push(tmp_path):
    """story #4206 — develop push는 이제 push 범위(before..after)로 판정한다. 앞 머지가 app 코드를 바꿨어도
    이번 push(FE만)의 범위만 보면 빈 목록(좁힘) — 예전엔 push마다 __ALL__(diff 정보 없음)이었다."""
    repo, _base = _init_repo(tmp_path)
    _write(repo, "backend/app/routers/other.py", "x = 2\n")
    _git(repo, "commit", "-q", "-am", "merge 1: app change")
    before = _git(repo, "rev-parse", "HEAD").stdout.strip()
    _write(repo, "apps/web/src/components/unrelated.tsx", "export const X = 2\n")
    _git(repo, "commit", "-q", "-am", "merge 2: FE only")

    proc = _run(repo, before, "HEAD")
    assert proc.returncode == 0, proc.stderr
    assert _line1(proc) == ""


def test_4206_ci_push_branch_uses_push_range_with_fallback():
    """ci.yml detect-changed-scope의 push 분기가 push 범위로 classify를 부르고, before가 없거나 0000…이면 예전
    __ALL__ 폴백을 유지한다(정적 대조 — 이 배선이 빠지면 develop push가 다시 전 파일 RED 후보)."""
    ci = open(os.path.join(os.path.dirname(__file__), "..", "..", ".github", "workflows", "ci.yml")).read()
    assert "PUSH_BEFORE_SHA: ${{ github.event.before }}" in ci
    assert 'classify_backend_test_diff_scope.sh "${PUSH_BEFORE_SHA}" "${PUSH_AFTER_SHA}"' in ci
    assert "grep -qE '^0+$'" in ci
