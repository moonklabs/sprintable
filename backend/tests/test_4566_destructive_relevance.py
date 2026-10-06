"""story 4566 — the destructive-schema shards' own relevance (FE_DEPS_FILE) and the exact list of FE files destructive tests read.

check_backend_relevant_diff.sh with FE_DEPS_FILE=infra/destructive-fe-deps.txt: an FE-only change starts the 12 shards only when
it touches a listed file; any change outside the FE allowlist (migrations · models · tests · CI files · other backend) still
does; a missing list is relevant (fail-closed); a push range (before..after) is judged the same way. lint_destructive_fe_deps
_listed.py keeps the list exact: a destructive test reading an unlisted FE path — or a listed path nobody reads — fails.
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
_DECISION_SCRIPT = _SCRIPTS_DIR / "check_backend_relevant_diff.sh"
_EXTRACT_SCRIPT = _SCRIPTS_DIR / "extract_fe_paths_referenced_by_backend_tests.py"
_LINT_SCRIPT = _SCRIPTS_DIR / "lint_destructive_fe_deps_listed.py"
_LIST = "infra/destructive-fe-deps.txt"


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
        dest = repo / "backend" / "scripts" / script.name
        dest.write_text(script.read_text())
        dest.chmod(0o755)
    _write(repo, "apps/web/messages/ko.json", '{"a": "b"}\n')
    _write(repo, "apps/web/src/lib/wide.ts", "export const W = 1\n")
    _write(repo, "backend/alembic/versions/0001_x.py", "x = 1\n")
    # a non-destructive backend test reading the whole web src (the wide list backend-test keeps)
    _write(repo, "backend/tests/test_wide.py", 'P = "apps/web/src"\n')
    _write(repo, _LIST, "# the destructive tests' FE files\napps/web/messages/ko.json\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    return repo, _git(repo, "rev-parse", "HEAD").stdout.strip()


def _commit(repo, rel, content="v2\n"):
    _write(repo, rel, content)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", f"change {rel}")
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def _decide(repo, base, head="HEAD", deps_file: str | None = _LIST):
    env = {k: v for k, v in os.environ.items() if k != "FE_DEPS_FILE"}
    if deps_file is not None:
        env["FE_DEPS_FILE"] = deps_file
    return subprocess.run(["bash", "backend/scripts/check_backend_relevant_diff.sh", base, head],
                          cwd=str(repo), capture_output=True, text=True, env=env).returncode


def test_fe_only_change_outside_the_list_skips_the_shards_but_still_runs_backend_test(tmp_path):
    repo, base = _init_repo(tmp_path)
    _commit(repo, "apps/web/src/lib/wide.ts")
    assert _decide(repo, base) == 1  # destructive: not relevant
    assert _decide(repo, base, deps_file=None) == 0  # backend-test's own list (apps/web/src) still relevant


def test_fe_only_change_to_a_listed_file_runs_the_shards(tmp_path):
    repo, base = _init_repo(tmp_path)
    _commit(repo, "apps/web/messages/ko.json", '{"a": "c"}\n')
    assert _decide(repo, base) == 0


def test_a_migration_change_runs_the_shards(tmp_path):
    repo, base = _init_repo(tmp_path)
    _commit(repo, "backend/alembic/versions/0002_y.py")
    assert _decide(repo, base) == 0


def test_a_missing_list_is_relevant_fail_closed(tmp_path):
    repo, base = _init_repo(tmp_path)
    _commit(repo, "apps/web/src/lib/wide.ts")
    assert _decide(repo, base, deps_file="infra/no-such-list.txt") == 0


def test_a_list_with_only_comments_is_relevant_fail_closed(tmp_path):
    repo, base = _init_repo(tmp_path)
    _write(repo, _LIST, "# nothing listed\n")
    _commit(repo, "apps/web/src/lib/wide.ts")
    assert _decide(repo, base) == 0


def test_a_push_range_is_judged_the_same_way(tmp_path):
    repo, base = _init_repo(tmp_path)
    _commit(repo, "apps/web/src/lib/wide.ts")
    after = _commit(repo, "docs/x.md", "# x\n")
    assert _decide(repo, base, after) == 1  # two FE/docs commits pushed together: not relevant
    after2 = _commit(repo, "backend/alembic/versions/0003_z.py")
    assert _decide(repo, base, after2) == 0  # one of them a migration: relevant


# ── lint_destructive_fe_deps_listed.py ──────────────────────────────────────


def _lint_module():
    spec = importlib.util.spec_from_file_location("lint_destructive_fe_deps_listed", _LINT_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_the_real_list_is_exact():
    proc = subprocess.run(["python3", str(_LINT_SCRIPT)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def _fake_tree(tmp_path, body: str):
    weights = tmp_path / "weights"
    tests = tmp_path / "tests"
    weights.mkdir()
    tests.mkdir()
    (weights / "test_d.py.json").write_text("{}")
    (tests / "test_d.py").write_text(body)
    (tests / "test_plain.py").write_text('P = "apps/web/src/not-destructive.ts"\n')  # not registered → not counted
    return weights, tests


def test_a_destructive_test_reading_an_unlisted_fe_path_is_found(tmp_path):
    mod = _lint_module()
    weights, tests = _fake_tree(tmp_path, 'P = "apps/web/src/new-read.ts"\n')
    got, unknown = mod.read_by_destructive(weights, tests)
    assert got == {"apps/web/src/new-read.ts"} and unknown == []


def test_main_fails_on_an_unlisted_read_and_on_a_stale_entry(tmp_path, monkeypatch, capsys):
    mod = _lint_module()
    weights, tests = _fake_tree(tmp_path, 'P = "apps/web/src/new-read.ts"\n')
    monkeypatch.setattr(mod, "WEIGHTS", weights)
    monkeypatch.setattr(mod, "TESTS", tests)
    lst = tmp_path / "list.txt"
    monkeypatch.setattr(mod, "LIST", lst)
    lst.write_text("apps/web/src/new-read.ts\n")
    assert mod.main() == 0
    lst.write_text("")  # the read is not listed
    assert mod.main() == 1
    assert "not in infra/destructive-fe-deps.txt: apps/web/src/new-read.ts" in capsys.readouterr().out
    lst.write_text("apps/web/src/new-read.ts\napps/web/src/gone.ts\n")  # a listed path nobody reads
    assert mod.main() == 1
    assert "no destructive test reads it: apps/web/src/gone.ts" in capsys.readouterr().out


def test_an_fe_mention_in_an_unknown_form_fails_closed(tmp_path, monkeypatch):
    mod = _lint_module()
    weights, tests = _fake_tree(tmp_path, 'P = "apps" + "/web/x.ts"\n')
    monkeypatch.setattr(mod, "WEIGHTS", weights)
    monkeypatch.setattr(mod, "TESTS", tests)
    lst = tmp_path / "list.txt"
    lst.write_text("")
    monkeypatch.setattr(mod, "LIST", lst)
    assert mod.main() == 1
