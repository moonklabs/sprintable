"""story #4825 — the embedded-only switch must never reach a hosted deployment, pinned three ways (no DB needed):
① the hosted deployment sources of truth — the Cloud Run build (cloudbuild.yaml), the VM build (cloudbuild-vm.yaml) and everything under deploy/vm
  that declares an environment — name neither `SPRINTABLE_EMBEDDED` nor `LOCAL_BOOTSTRAP_SECRET` (only the VM renderer's FORBIDDEN list may);
② `settings.is_embedded` is True only for switch on + a 32+ char secret + not Cloud Run; ③ the startup guard refuses a half-configured or
Cloud Run process, and passes a clean hosted one.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
NAMES = ("SPRINTABLE_EMBEDDED", "LOCAL_BOOTSTRAP_SECRET")


def _hosted_sources() -> list[Path]:
    files = [ROOT / "cloudbuild.yaml", ROOT / "cloudbuild-vm.yaml"]
    vm = ROOT / "deploy" / "vm"
    files += sorted(p for p in vm.rglob("*") if p.is_file() and p.suffix in {".yaml", ".yml", ".txt", ".env", ""} and "bin" not in p.relative_to(vm).parts)
    return files


def _code(text: str) -> str:
    return re.sub(r"(?m)#.*$", "", text)


def test_the_hosted_deployment_sources_carry_neither_name() -> None:
    sources = _hosted_sources()
    assert len(sources) >= 6, sources  # the walk really found the files (cloudbuild × 2, compose, env yaml × 2, live-names × 2)
    offenders = [f"{p.relative_to(ROOT)}: {n}" for p in sources for n in NAMES if n in _code(p.read_text(encoding="utf-8", errors="replace"))]
    assert offenders == []


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
