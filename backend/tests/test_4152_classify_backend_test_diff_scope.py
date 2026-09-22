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


def test_no_base_sha_push_context_returns_all():
    """push 이벤트 등 diff 정보 없음 — 안전측 폴백."""
    proc = subprocess.run(
        ["bash", _SCRIPT], capture_output=True, text=True, cwd=os.path.dirname(_SCRIPTS_DIR),
    )
    assert proc.returncode == 0
    assert proc.stdout.strip() == "__ALL__"


def test_app_only_change_returns_all(tmp_path):
    """⭐CHANGES-1 핵심 — backend/app 코드만 바꾸면(테스트 파일 diff 0) 전부 RED
    후보. 이게 없으면 코드 변경이 만든 진짜 회귀가 WARN으로 숨는다."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/app/routers/other.py", "x = 2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "app change")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "__ALL__"


def test_tests_only_change_returns_narrowed_list(tmp_path):
    """backend/tests/*.py만 바뀌면 그 목록으로 좁힌다(diff-scoping 적용 대상)."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/tests/test_fake_new.py", "def test_x():\n    assert True\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "test-only change")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "tests/test_fake_new.py"


def test_fe_only_change_returns_empty_narrowed_list(tmp_path):
    """FE-only PR(backend/ 변경 0건, 오늘 PR#4351 실사고와 동형) — backend/tests
    diff도 당연히 0건이라 빈 문자열(diff-scoping 적용, 전부 changed_files 밖)."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "apps/web/src/components/unrelated.tsx", "export const X = 2\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "fe-only change")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == ""


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
    assert proc.stdout.strip() == "__ALL__"


def test_alembic_migration_change_returns_all(tmp_path):
    """backend/alembic/versions/*.py도 «테스트 파일 아님»이라 __ALL__ — pyproject.toml
    등 backend/ 밑 그 외 의존성 변경도 같은 경로 패턴으로 자동 커버된다."""
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/alembic/versions/0999_fake.py", "# migration\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "migration change")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "__ALL__"


def test_multiple_test_files_joined_with_space(tmp_path):
    repo, base_sha = _init_repo(tmp_path)
    _write(repo, "backend/tests/test_fake_a.py", "def test_a():\n    assert True\n")
    _write(repo, "backend/tests/test_fake_b.py", "def test_b():\n    assert True\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "two new tests")
    proc = _run(repo, base_sha)
    assert proc.returncode == 0, proc.stderr
    files = set(proc.stdout.strip().split())
    assert files == {"tests/test_fake_a.py", "tests/test_fake_b.py"}
