"""story 5008 (A1) — the desktop runtimes are ONE registry; everything else is derived from it, and a name this server (or an older app) does not know yet breaks nothing.

Plan 796e269f · branch ①. The list «claude | codex» stood in ~65 places; the server's places now read `agent_runtime.DESKTOP_RUNTIME_REGISTRY`:
the id → member-type table, the names the three relay tables allow (migration 0497), the capability words a setup code may carry, the request-body validator,
the funnel's runtime sets, and the pinned shell-meta contract. A later agent is a row there (enabled=False first), not another hunt.

Red when: a registry name is added without the migration/contract following (the drift guards), a request-body runtime stops being limited to ENABLED names,
an answer model starts refusing a runtime name it did not know (the 500 this story exists to prevent), an older app (no capability word) is offered a runtime that
needs one, or the migration's allowed names stop being the registry's.
"""
from __future__ import annotations

import importlib.util
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.models import desktop_relay
from app.models.agent_permission import AgentPermissionRequest
from app.routers import desktop_setup as router
from app.services import agent_runtime as ar
from app.services import desktop_setup as ds
from app.services import onboarding_funnel as funnel
from app.services.agent_permissions import PermissionRequestReport
from app.services.desktop_relay import SessionReport

ROOT = Path(__file__).resolve().parents[1]


def _migration_0497():
    spec = importlib.util.spec_from_file_location("m0497", ROOT / "alembic/versions/0497_desktop_runtime_names.py")
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ── the registry and what is derived from it ─────────────────────────────────────────────
def test_the_registry_is_the_one_list_and_claude_codex_and_opencode_are_enabled():
    assert ar.DESKTOP_RUNTIME_IDS == ("claude", "codex", "opencode", "gemini", "cursor")
    assert ar.DESKTOP_RUNTIME_TYPES == {"claude": "claude-code", "codex": "codex", "opencode": "opencode"}  # story 5009 (A2): OpenCode switched on (offered only to an app that says rt-opencode)
    assert {r.id for r in ar.DESKTOP_RUNTIME_REGISTRY if not r.enabled} == {"gemini", "cursor"}
    assert len(set(ar.DESKTOP_RUNTIME_IDS)) == len(ar.DESKTOP_RUNTIME_IDS)
    for r in ar.DESKTOP_RUNTIME_REGISTRY:  # every member type is one the product already knows
        assert r.member_type in {t.value for t in ar.RuntimeType}


def test_every_registry_row_has_a_name_for_a_new_agent_so_switching_one_on_cannot_raise_a_key_error():
    assert ds.SOLO_AGENT_NAMES == {"claude": "Claude Code", "codex": "Codex", "opencode": "OpenCode", "gemini": "Gemini CLI", "cursor": "Cursor"}
    assert all(r.agent_name for r in ar.DESKTOP_RUNTIME_REGISTRY)


def test_the_relay_tables_and_the_funnel_and_the_migration_use_the_registrys_names():
    assert desktop_relay.SESSION_RUNTIMES == ar.DESKTOP_RUNTIME_IDS
    assert funnel.BLOCKED_RUNTIMES == frozenset(ar.DESKTOP_RUNTIME_IDS) == funnel.AGENT_RUNTIMES
    m = _migration_0497()
    assert m._NEW == ar.DESKTOP_RUNTIME_IDS  # drift guard: a registry name without a migration turns this red
    assert m._OLD == ("claude", "codex")
    # the three constraints the model declares carry exactly those names, and the migration touches exactly those three
    declared = {
        c.name: str(c.sqltext)
        for tbl in (desktop_relay.DesktopSession.__table__, desktop_relay.DesktopUsage.__table__, AgentPermissionRequest.__table__)
        for c in tbl.constraints
        if c.name and c.name.endswith("_runtime")
    }
    assert set(declared) == {name for _t, name in m._CHECKS}
    for sql in declared.values():
        for rid in ar.DESKTOP_RUNTIME_IDS:
            assert f"'{rid}'" in sql


def test_the_pinned_shell_meta_contract_lists_the_registrys_names_in_all_four_runtime_fields():
    shapes = funnel.DESKTOP_SHELL_META_SHAPES
    for event in ("desktop_setup_blocked", "desktop_agent_ended_early", "desktop_agent_start_failed", "desktop_agent_needs_sign_in"):
        assert shapes[event]["runtime"]["enum"] == sorted(ar.DESKTOP_RUNTIME_IDS)


def test_the_web_keeps_the_same_names_in_its_one_module():
    text = (ROOT.parent / "apps/web/src/lib/desktop-runtimes.ts").read_text(encoding="utf-8")
    m = re.search(r"DESKTOP_RUNTIME_IDS\s*=\s*\[([^\]]*)\]", text)
    assert m, "apps/web/src/lib/desktop-runtimes.ts must declare DESKTOP_RUNTIME_IDS"
    assert tuple(re.findall(r"'([a-z]+)'", m.group(1))) == ar.DESKTOP_RUNTIME_IDS


# ── an app says what it can drive; the server offers only that ───────────────────────────
def test_runtime_capability_words_are_known_to_setup_codes_and_unknown_words_are_dropped():
    assert set(ar.RUNTIME_CAPABILITIES) == {"rt-opencode", "rt-gemini", "rt-cursor"}
    for word in ar.RUNTIME_CAPABILITIES:
        assert word in ds.KNOWN_CAPABILITIES
    assert ds.KNOWN_CAPABILITIES[:2] == ("move", "solo")
    assert len(ds.KNOWN_CAPABILITIES) <= 8  # the request body takes at most 8 words (routers/desktop_setup.py)
    kept = [c for c in ds.KNOWN_CAPABILITIES if c in ["move", "rt-opencode", "a-word-from-a-newer-app"]]
    assert kept == ["move", "rt-opencode"]  # what create_setup_code stores: the unknown word is no error, it is just not kept


def test_an_enabled_runtime_that_needs_a_word_is_offered_only_to_an_app_that_said_it(monkeypatch):
    monkeypatch.setitem(ar.DESKTOP_RUNTIME_TYPES, "opencode", "opencode")  # «newer server»: opencode switched on
    assert ar.runtime_offered_to("claude", None) and ar.runtime_offered_to("codex", [])  # every app can drive the first two
    assert not ar.runtime_offered_to("opencode", None)  # an older app: no word
    assert not ar.runtime_offered_to("opencode", ["move", "solo"])
    assert ar.runtime_offered_to("opencode", ["solo", "rt-opencode"])  # a newer app
    assert not ar.runtime_offered_to("gemini", ["rt-gemini"])  # known name, not switched on
    assert not ar.runtime_offered_to("nonsense", ["rt-opencode"])


def test_an_older_server_that_does_not_have_it_switched_on_offers_a_newer_app_nothing_new(monkeypatch):
    monkeypatch.delitem(ar.DESKTOP_RUNTIME_TYPES, "opencode")  # «an older server»: not enabled there (the word is dropped by it, the name is not enabled)
    assert not ar.runtime_offered_to("opencode", ["move", "solo", "rt-opencode"])


def test_opencode_is_offered_to_an_app_that_said_rt_opencode_and_to_no_other():
    assert ar.runtime_offered_to("opencode", ["solo", "rt-opencode"])
    for caps in (None, [], ["move", "solo"], ["rt-gemini"]):
        assert not ar.runtime_offered_to("opencode", caps), caps  # an app from before the runtime
    assert ar.runtime_offered_to("claude", None) and ar.runtime_offered_to("codex", [])  # claude · codex: every app


# ── request bodies: only an enabled name; one closed word otherwise ──────────────────────
def _usage_entry(runtime: str):
    from app.services.desktop_usage import UsageEntry

    return UsageEntry(runtime=runtime, account="a" * 8, seen_at=datetime.now(timezone.utc), state="unavailable", why="not_read")


def test_request_bodies_take_enabled_names_and_say_one_closed_word_for_anything_else():
    _usage_entry("claude")
    _usage_entry("codex")
    _usage_entry("opencode")  # story 5009: enabled now
    for bad in ("gemini", "cursor", "nonsense", ""):
        with pytest.raises(ValidationError) as e:
            _usage_entry(bad)
        assert "runtime_unsupported" in str(e.value)
        assert "claude" not in str(e.value).replace("runtime_unsupported", "")  # it does not list the names we do have


def test_a_runtime_switched_on_later_is_accepted_by_the_same_bodies_without_code(monkeypatch):
    monkeypatch.setitem(ar.DESKTOP_RUNTIME_TYPES, "opencode", "opencode")
    assert _usage_entry("opencode").runtime == "opencode"
    for model in (PermissionRequestReport, SessionReport):  # the other two bodies an app sends with a runtime read the same registry
        runtime_field = model.model_fields["runtime"]
        assert runtime_field.annotation is ar.DesktopRuntimeId or "AfterValidator" in repr(runtime_field.metadata) or "AfterValidator" in repr(runtime_field.annotation)


# ── answers: a name a table holds must never turn an answer into an error ────────────────
def test_answer_models_take_a_runtime_name_this_reader_does_not_know():
    when = datetime.now(timezone.utc)
    assert router.AttachableAgent(id=uuid.uuid4(), name="x", runtime="opencode", live_keys=1, in_project=True).runtime == "opencode"
    assert router.AgentSignIn(member_id=str(uuid.uuid4()), at=when, runtime="gemini").runtime == "gemini"
    assert router.AgentEnded(member_id=str(uuid.uuid4()), at=when, runtime="cursor").runtime == "cursor"
    assert router.AgentStartFailed(member_id=str(uuid.uuid4()), at=when, runtime="a-future-agent").runtime == "a-future-agent"


def test_the_run_profile_table_is_the_registrys_enabled_rows_the_other_way_round():
    from app.services.agent_run_profile import DESKTOP_RUNTIMES

    assert DESKTOP_RUNTIMES == {"claude-code": "claude", "codex": "codex", "opencode": "opencode"}


# ── the capability gate is on EVERY path that picks a runtime for a setup (codex QA round 1: it was on the solo start only) ───────────────────
def test_a_recipe_role_may_name_a_runtime_that_needs_a_word_only_when_the_app_said_it(monkeypatch):
    monkeypatch.setitem(ar.DESKTOP_RUNTIME_TYPES, "opencode", "opencode")  # a «newer server»: opencode switched on
    rows = [{"role": "dev", "kind": "agent"}]
    asked = [ds.RoleChoice(role="dev", runtime="opencode")]
    for caps in (None, [], ["move", "solo"]):  # an app from before: no runtime word
        with pytest.raises(ds.DesktopSetupError) as e:
            ds.bind_setup_roles(rows, asked, caps)
        assert e.value.code == "roles_invalid"
    assert ds.bind_setup_roles(rows, asked, ["solo", "rt-opencode"]).agent_runtimes == {"dev": "opencode"}  # an app that said it
    # claude and codex need no word: every app, old or new
    assert ds.bind_setup_roles(rows, [ds.RoleChoice(role="dev", runtime="codex")], None).agent_runtimes == {"dev": "codex"}


@pytest.mark.anyio
async def test_an_existing_agent_on_a_runtime_that_needs_a_word_is_attachable_only_by_an_app_that_said_it(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock

    monkeypatch.setitem(ar.DESKTOP_RUNTIME_TYPES, "opencode", "opencode")
    monkeypatch.setattr("app.services.project_auth.project_accessible_member_ids", AsyncMock(return_value={uuid.UUID(int=1)}))
    db = MagicMock()
    result = MagicMock()
    result.first.return_value = SimpleNamespace(type="agent", is_active=True, runtime_type="opencode")
    db.execute = AsyncMock(return_value=result)
    kw = dict(org_id=uuid.UUID(int=9), project_id=uuid.UUID(int=8), agent_id=uuid.UUID(int=1))
    for caps in (None, ["move", "solo"]):
        with pytest.raises(ds.DesktopSetupError) as e:
            await ds._attachable_runtime(db, capabilities=caps, **kw)
        assert e.value.code == "agent_not_found"  # reads the same as no agent (the card's rule for a runtime the app cannot run)
    assert await ds._attachable_runtime(db, capabilities=["move", "rt-opencode"], **kw) == "opencode"

