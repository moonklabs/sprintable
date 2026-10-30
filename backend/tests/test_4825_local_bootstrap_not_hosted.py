"""story #4825 — the embedded-only switch must never reach a hosted deployment, pinned three ways (no DB needed):
① NO file in the repository outside a short allow-list (the code that reads the two variables, the VM renderer that forbids them, these tests) names
  `SPRINTABLE_EMBEDDED` or `LOCAL_BOOTSTRAP_SECRET` — every deployment file is covered without a list of them to maintain (Cloud Run build, VM build,
  `backend/scripts/deploy_*.sh`, Dockerfiles, workflows, compose, env yaml …); ② `settings.is_embedded` is True only for switch on + a 32+ char secret
  + not Cloud Run; ③ the startup guard refuses a half-configured or Cloud Run process, and passes a clean hosted one.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
NAMES = ("SPRINTABLE_EMBEDDED", "LOCAL_BOOTSTRAP_SECRET")


#: the ONLY files that may name either variable: the code that reads them, the VM renderer that forbids them, and these tests. A deployment
#: file anywhere in the repository (Cloud Run build, VM build, `backend/scripts/deploy_*.sh`, Dockerfiles, workflows, compose, env yaml …) that
#: names one fails here — no list of "hosted deploy files" to keep up to date, so a new deploy path cannot slip past the scan.
ALLOWED = {
    "backend/app/core/config.py",
    "backend/app/main.py",
    "backend/app/routers/local_auth.py",
    "backend/tests/test_4796_vm_env.py",
    "backend/tests/test_4825_local_bootstrap_not_hosted.py",
    "backend/tests/test_4825_local_bootstrap_realdb.py",
    "deploy/vm/bin/render_env.py",
}
_SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".pytest_cache", ".mypy_cache"}


def _repo_files() -> list[Path]:
    import subprocess

    try:
        out = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True, check=True).stdout
        names = [n for n in out.decode("utf-8", errors="replace").split("\0") if n]
        files = [ROOT / n for n in names]
    except Exception:  # no git (a source export): walk the tree
        files = []
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
            files += [Path(dirpath) / f for f in filenames]
    return [f for f in files if f.is_file()]


def _code(text: str) -> str:
    return re.sub(r"(?m)#.*$", "", text)


def _namers(files: list[Path]) -> set[str]:
    found: set[str] = set()
    for p in files:
        try:
            if p.stat().st_size > 2_000_000:
                continue
            raw = p.read_bytes()
        except OSError:
            continue
        if b"\0" in raw[:4096]:  # binary
            continue
        if any(n.encode() in raw for n in NAMES):
            found.add(str(p.relative_to(ROOT)))
    return found


def test_no_file_outside_the_allowed_ones_names_either_variable() -> None:
    files = _repo_files()
    assert len(files) > 500, len(files)  # the scan really covers the repository
    for must in ("cloudbuild.yaml", "cloudbuild-vm.yaml", "backend/scripts/deploy_realtime_gce.sh"):  # the deploy truths are in the scan
        assert (ROOT / must) in set(files), must
    assert _namers(files) - ALLOWED == set()


def test_the_allowed_files_are_the_ones_that_really_name_them() -> None:
    """keeps the allow-list honest: a name in it that nothing uses any more is dropped from it"""
    assert _namers(_repo_files()) == ALLOWED


def test_the_walk_would_catch_a_planted_name(tmp_path: Path) -> None:
    """positive control: the scan used above does find the names when they are there"""
    planted = tmp_path / "x.yaml"
    planted.write_text("env:\n  SPRINTABLE_EMBEDDED: '1'\n")
    assert any(n in _code(planted.read_text()) for n in NAMES)
    commented = tmp_path / "y.yaml"
    commented.write_text("# SPRINTABLE_EMBEDDED is never set here\nenv: {}\n")
    assert not any(n in _code(commented.read_text()) for n in NAMES)


def test_the_vm_renderer_refuses_both_names() -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location("render_env_4825", ROOT / "deploy" / "vm" / "bin" / "render_env.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    assert set(NAMES) <= set(mod.FORBIDDEN_NAMES)


@pytest.mark.parametrize(
    "env, secret, expected",
    [
        ({}, "", False),
        ({}, "s" * 40, False),  # a secret without the switch
        ({"SPRINTABLE_EMBEDDED": "1"}, "", False),
        ({"SPRINTABLE_EMBEDDED": "1"}, "s" * 31, False),  # too short
        ({"SPRINTABLE_EMBEDDED": "0"}, "s" * 40, False),
        ({"SPRINTABLE_EMBEDDED": "1"}, "s" * 32, True),
        ({"SPRINTABLE_EMBEDDED": "true"}, "s" * 40, True),
        ({"SPRINTABLE_EMBEDDED": "1", "K_SERVICE": "backend-prod"}, "s" * 40, False),  # Cloud Run always wins
    ],
)
def test_is_embedded_truth_table(monkeypatch, env, secret, expected) -> None:
    from app.core.config import settings

    for k in ("SPRINTABLE_EMBEDDED", "K_SERVICE"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(settings, "local_bootstrap_secret", secret)
    assert settings.is_embedded is expected


@pytest.mark.parametrize(
    "env, secret, refuses",
    [
        ({}, "", False),  # a clean hosted process starts
        ({}, "s" * 40, True),  # a leftover secret without the switch
        ({"SPRINTABLE_EMBEDDED": "1"}, "", True),
        ({"SPRINTABLE_EMBEDDED": "1"}, "s" * 31, True),
        ({"SPRINTABLE_EMBEDDED": "1", "K_SERVICE": "backend-prod"}, "s" * 40, True),
        ({"SPRINTABLE_EMBEDDED": "1"}, "s" * 32, False),  # a proper embedded install starts
    ],
)
def test_startup_guard(monkeypatch, env, secret, refuses) -> None:
    from app.core.config import settings
    from app.routers.local_auth import assert_local_bootstrap_config

    for k in ("SPRINTABLE_EMBEDDED", "K_SERVICE"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(settings, "local_bootstrap_secret", secret)
    if refuses:
        with pytest.raises(RuntimeError) as e:
            assert_local_bootstrap_config()
        assert secret not in str(e.value) or secret == ""  # the message never carries the value
    else:
        assert_local_bootstrap_config()


def test_main_wires_both_the_route_registration_and_the_host_guard() -> None:
    """the real app calls both (each is a no-op unless the install is embedded); a removed call would silently drop the guard"""
    src = (ROOT / "backend" / "app" / "main.py").read_text(encoding="utf-8")
    assert "_local_auth.register_local_auth_routes(app)" in src
    assert "_local_auth.apply_embedded_host_guard(app)" in src
