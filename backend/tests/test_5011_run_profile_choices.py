"""story 5011 (5008 audit) — the run profile's model · effort lists live IN the runtime registry, so enabling a runtime can never be a 500.

Before: `agent_run_profile.check()` let a runtime in when it was in the ENABLED table (`DESKTOP_RUNTIME_TYPES`) and then read `MODEL_NAMES[runtime]` / `CATALOG[runtime]` —
two static dicts of the first two runtimes: a «newer» runtime saved with a model or an effort was a KeyError → 500 (not a 422). Now each registry row carries its own lists
(`choices`, an empty one allowed): a name outside the list is a 422, a runtime with empty lists is saved as «not named» only, and claude · codex are exactly what they were.

Red when: an enabled row has no `choices` (a runtime turned on and its lists forgotten), a model or an effort for a runtime that names none is not a 422 (or is a 500),
claude · codex's lists / patterns / options() drift from the pinned file (the fixture is the pre-change dump), or a runtime with nothing to name appears in options().
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.services import agent_run_profile as rp
from app.services import agent_runtime as ar

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "run_profile_choices_5011.json").read_text(encoding="utf-8"))


def _code(exc: pytest.ExceptionInfo[HTTPException]) -> tuple[int, str]:
    return exc.value.status_code, exc.value.detail["code"]


@pytest.fixture
def newer_runtime(monkeypatch):
    """A «newer» runtime the registry does not know, put in the enabled tables the way the existing tests do (5008)."""
    monkeypatch.setitem(ar.DESKTOP_RUNTIME_TYPES, "newer", "newer-type")
    monkeypatch.setitem(rp.DESKTOP_RUNTIMES, "newer-type", "newer")
    return "newer-type"


# ── AC1 · AC2: a runtime with nothing to name ────────────────────────────────────────────
def test_a_model_or_an_effort_for_a_runtime_that_names_none_is_a_422_never_a_500(newer_runtime):
    with pytest.raises(HTTPException) as m:
        rp.check(newer_runtime, "some-model", None)
    assert _code(m) == (422, "invalid_model")
    with pytest.raises(HTTPException) as e:
        rp.check(newer_runtime, None, "high")
    assert _code(e) == (422, "invalid_effort")
    with pytest.raises(HTTPException) as both:
        rp.check(newer_runtime, "some-model", "high")
    assert _code(both)[0] == 422


def test_such_a_runtime_is_saved_with_no_model_and_no_effort(newer_runtime):
    rp.check(newer_runtime, None, None)  # does not raise


def test_a_registry_row_with_empty_choices_behaves_the_same_once_enabled(monkeypatch):
    """OpenCode as it is in the registry now (disabled, NO_CHOICES): switched on, a model or effort is still a 422."""
    monkeypatch.setitem(ar.DESKTOP_RUNTIME_TYPES, "opencode", "opencode")
    monkeypatch.setitem(rp.DESKTOP_RUNTIMES, "opencode", "opencode")
    rp.check("opencode", None, None)
    for model, effort, code in (("x", None, "invalid_model"), (None, "low", "invalid_effort")):
        with pytest.raises(HTTPException) as exc:
            rp.check("opencode", model, effort)
        assert _code(exc) == (422, code)
    assert rp.allowed_efforts("opencode", None) == () and rp.allowed_efforts("opencode", "x") == ()


def test_a_runtime_that_is_not_a_desktop_one_is_still_runtime_not_desktop():
    with pytest.raises(HTTPException) as exc:
        rp.check("hermes", None, None)
    assert _code(exc) == (422, "runtime_not_desktop")


# ── AC3: turning a runtime on and forgetting its lists is red ────────────────────────────
def test_every_enabled_registry_row_has_its_model_and_effort_entry():
    for r in ar.DESKTOP_RUNTIME_REGISTRY:
        assert isinstance(r.choices, ar.RunProfileChoices), f"{r.id}: no `choices` (a row says NO_CHOICES on purpose when it names nothing)"
    for r in ar.DESKTOP_RUNTIME_REGISTRY:
        if r.enabled:
            assert r.choices is not None
    # an empty entry is said on purpose, and it carries no half-list: models without a pattern (or the other way round) would be a profile no check accepts
    for r in ar.DESKTOP_RUNTIME_REGISTRY:
        c = r.choices
        assert (c.model_pattern is None) == (not c.models and not c.custom_efforts) or c.model_pattern is not None, r.id


def test_the_guard_sees_a_row_that_forgot_its_lists():
    """positive control: a row built without `choices` reads as «none» in the lookup (never a KeyError) and the guard above would be red for it"""
    forgot = ar.DesktopRuntime("zzz", "zzz-type", True, None, "Zzz")
    assert forgot.choices is None
    assert not isinstance(forgot.choices, ar.RunProfileChoices)


# ── claude · codex: no change ────────────────────────────────────────────────────────────
def test_claude_and_codex_lists_patterns_and_options_are_what_they_were():
    assert rp.options() == FIXTURE["options"]
    got = {k: {"models": {n: list(e) for n, e in v["models"].items()}, "custom": list(v["custom"])} for k, v in rp.CATALOG.items()}
    assert got == FIXTURE["catalog"]
    assert {k: p.pattern for k, p in rp.MODEL_NAMES.items()} == FIXTURE["patterns"]
    assert {k: v for k, v in rp.DESKTOP_RUNTIMES.items() if k in FIXTURE["desktop_runtimes"]} == FIXTURE["desktop_runtimes"]  # claude · codex as they were (opencode joined in story 5009)
    assert list(FIXTURE["catalog"]) == ["claude-code", "codex"]  # the order the web shows


def test_claude_and_codex_checks_are_unchanged():
    rp.check("claude-code", "opus", "max")
    rp.check("claude-code", "claude-opus-5-5[1m]", "high")  # the [1m] tail: Claude only
    rp.check("codex", "gpt-6-sol", "ultra")
    rp.check("codex", "typed-in-name", "high")
    for runtime, model, effort, code in (
        ("codex", "claude-opus-5-5[1m]", None, "invalid_model"),
        ("codex", "gpt-6-luna", "ultra", "invalid_effort"),
        ("claude-code", "bad name", None, "invalid_model"),
        ("claude-code", None, "ultra", "invalid_effort"),
        ("codex", "typed-in-name", "max", "invalid_effort"),
    ):
        with pytest.raises(HTTPException) as exc:
            rp.check(runtime, model, effort)
        assert _code(exc) == (422, code), (runtime, model, effort)


def test_options_lists_only_runtimes_that_have_something_to_pick(monkeypatch):
    import dataclasses

    # OpenCode switched ON in the registry the real way (the row's flag), still naming nothing
    rows = tuple(dataclasses.replace(r, enabled=True) if r.id == "opencode" else r for r in ar.DESKTOP_RUNTIME_REGISTRY)
    monkeypatch.setattr(rp, "DESKTOP_RUNTIME_REGISTRY", rows)
    assert any(r.id == "opencode" and r.enabled for r in rp.DESKTOP_RUNTIME_REGISTRY)
    assert [r["runtime"] for r in rp.options()["runtimes"]] == ["claude-code", "codex"]
    assert re.compile(rp.options()["model_pattern"])  # the one strict pattern is still there for a client that reads only it
