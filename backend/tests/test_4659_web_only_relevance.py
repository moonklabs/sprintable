"""story 4659 (PO 07:10Z) — 웹만 바뀐 PR은 파괴적 샤드를 깨우지 않는다.

PR 5040 실측: 바뀐 파일이 apps/web뿐인데 파괴적 샤드 12개(약 180분)가 돌았다. 원인은 test_3815가 웹 메시지 파일을
읽는 것 — 그 테스트가 파괴적 샤드에 있어서 메시지 파일이 destructive-fe-deps 목록에 들어 있었다. 테스트를 비파괴
레인으로 옮기고 목록에서 뺐다(test_4659_youtube_quota_copy_parity.py).

이 파일은 임시 git repo에서 판정 스크립트 두 개를 돌려 세 칸을 고정한다:
  ① apps/web 컴포넌트만 바뀜 → 파괴적 · 백엔드 둘 다 무관(exit 1)
  ② 메시지 파일만 바뀜 → 파괴적은 무관(exit 1), 백엔드는 관련(exit 0 — 비파괴 테스트가 그 파일을 읽는다)
  ③ infra/destructive-fe-deps.txt에 메시지 파일이 다시 들어가면 웹 메시지 변경 → 파괴적 관련(exit 0)
"""
from __future__ import annotations

import os
import shutil
import subprocess

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
_DECISION_SCRIPT = os.path.join(_SCRIPTS_DIR, "check_backend_relevant_diff.sh")
_EXTRACT_SCRIPT = os.path.join(_SCRIPTS_DIR, "extract_fe_paths_referenced_by_backend_tests.py")
_REAL_DESTRUCTIVE_LIST = os.path.join(os.path.dirname(__file__), "..", "..", "infra", "destructive-fe-deps.txt")


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
    for script in (_EXTRACT_SCRIPT, _DECISION_SCRIPT):
        dest = repo / "backend" / "scripts" / os.path.basename(script)
        dest.write_text(open(script).read())
        dest.chmod(0o755)
    # the real destructive list, as CI reads it
    (repo / "infra").mkdir(parents=True, exist_ok=True)
    shutil.copy(_REAL_DESTRUCTIVE_LIST, repo / "infra" / "destructive-fe-deps.txt")

    _write(repo, "apps/web/messages/ko.json", '{"a": "b"}\n')
    _write(repo, "apps/web/messages/en.json", '{"a": "b"}\n')
    _write(repo, "apps/web/src/components/unrelated.tsx", "export const X = 1\n")
    _write(repo, "backend/app/routers/other.py", "x = 1\n")
    # a non-destructive test that reads the ko message file (as the copy check now does)
    _write(
        repo, "backend/tests/test_fake_copy_parity.py",
        'from pathlib import Path\n'
        'REPO_ROOT = Path(__file__).resolve().parents[2]\n'
        'def test_parity():\n'
        '    fe_ko = (REPO_ROOT / "apps/web/messages/ko.json").read_text()\n',
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    return repo, _git(repo, "rev-parse", "HEAD").stdout.strip()


def _decide(repo, base, *, destructive: bool):
    env = {**os.environ}
    if destructive:
        env["FE_DEPS_FILE"] = "infra/destructive-fe-deps.txt"
    return subprocess.run(
        ["bash", "backend/scripts/check_backend_relevant_diff.sh", base, "HEAD"],
        cwd=str(repo), capture_output=True, text=True, env=env,
    ).returncode


def test_web_component_only_change_is_relevant_to_neither_axis(tmp_path):
    repo, base = _init_repo(tmp_path)
    _write(repo, "apps/web/src/components/unrelated.tsx", "export const X = 2\n")
    _git(repo, "commit", "-q", "-am", "web only")
    assert _decide(repo, base, destructive=True) == 1
    assert _decide(repo, base, destructive=False) == 1


def test_message_file_change_skips_destructive_but_still_runs_the_non_destructive_copy_check(tmp_path):
    repo, base = _init_repo(tmp_path)
    _write(repo, "apps/web/messages/ko.json", '{"a": "c"}\n')
    _git(repo, "commit", "-q", "-am", "copy only")
    assert _decide(repo, base, destructive=True) == 1, "the destructive shards must not start for a copy-only change"
    assert _decide(repo, base, destructive=False) == 0, "the non-destructive copy check reads ko.json — it must run"


def test_message_file_in_destructive_list_brings_the_shards_back(tmp_path):
    repo, base = _init_repo(tmp_path)
    listing = repo / "infra" / "destructive-fe-deps.txt"
    listing.write_text(listing.read_text() + "apps/web/messages/ko.json\n")
    _write(repo, "apps/web/messages/ko.json", '{"a": "c"}\n')
    _git(repo, "commit", "-q", "-am", "copy with the file listed")
    assert _decide(repo, base, destructive=True) == 0
