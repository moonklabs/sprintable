"""story 4851 — in the HTTP MCP one process serves many keys, so a key's default project must be THAT key's state and nothing process-wide.

Measured on 2026-11-07 (real backend code, a throw-away DB, the real HTTP MCP server): after key A called `set_default_project(P1)`, every other key's no-argument call in the same process went to P1 —
a key without access to P1 (same organization or another one) was answered 403 for as long as the process lived, and keys that share P1 wrote into P1: a key with no default of its own (it should have been
told to choose), and a key whose own default was stored on the server (P2).

What these tests hold:
  · a request that brings its own key resolves project / org / member from THAT key's context only — a process-wide value (what the stdio startup check writes) can never answer for it;
  · `set_default_project` over HTTP writes that key's cache entry and nothing process-wide: «the key that wrote last cannot change another key» and «a key that has its own default keeps it»;
  · over stdio (one process = one key, no per-request key) the process-wide value is still the key's state: nothing changes there;
  · the same through a real tool (`list_stories`), which is where the wrong project id left the process.
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
from unittest.mock import AsyncMock, patch

import pytest

from sprintable_mcp import api_client as ac
from sprintable_mcp.api_client import SprintableApiError, client
from sprintable_mcp.tools import projects as pr

P1, P2, P3, GLOBAL = "p1-aaaa", "p2-bbbb", "p3-cccc", "p-GLOBAL-process-wide"


@pytest.fixture
def anyio_backend():
    return "asyncio"


_MODULE_STATE = ("_auth_ctx_cache", "_auth_checked_at", "_inflight_checks", "_recheck_after_401")


@contextlib.contextmanager
def _isolated_state():
    """the client and the per-key state are module-wide singletons shared with every other test of the process: take a copy of ALL of it, give the code inside a blank state of its own
    (it assumes nothing about what an earlier test left), and put the copy back afterwards — nothing is «cleared» for the next test, nothing leaks to it"""
    saved_client = copy.copy(client.__dict__)
    saved_module = {name: copy.copy(getattr(ac, name)) for name in _MODULE_STATE}
    saved_invalidated = set(ac._invalidated_checks)
    client._project_id = client._org_id = client._member_id = ""
    client._project_id_ambiguous, client._accessible_project_ids, client._auth_resolved = False, [], False
    client._api_key = ""
    for name in _MODULE_STATE:
        getattr(ac, name).clear()
    ac._invalidated_checks.clear()
    try:
        yield
    finally:
        client.__dict__.clear()
        client.__dict__.update(saved_client)
        for name, saved in saved_module.items():
            getattr(ac, name).clear()
            getattr(ac, name).update(saved)
        ac._invalidated_checks.clear()
        ac._invalidated_checks.update(saved_invalidated)


@pytest.fixture(autouse=True)
def _clean_state():
    with _isolated_state():
        yield


def _ctx(project: str, *, accessible: list[str], org: str = "org", member: str = "m") -> dict:
    return {"project_id": project, "org_id": org, "member_id": member, "is_project_ambiguous": not project, "accessible_project_ids": accessible}


def _as(key: str):
    """run the following code «as the request of this key» (what the HTTP door does with the bearer)"""
    return ac.set_api_key_override(key)


# ───────────────────────── resolution: a key answers from its own context ─────────────────────────

def test_a_request_with_its_own_key_never_answers_from_the_process_wide_value():
    ac._auth_ctx_cache["kA"] = _ctx(P1, accessible=[P1, P2], org="orgA", member="mA")
    ac._auth_ctx_cache["kB"] = _ctx(P3, accessible=[P3], org="orgB", member="mB")
    client._project_id, client._org_id, client._member_id = GLOBAL, "org-GLOBAL", "m-GLOBAL"   # what a stdio startup check would have left
    for key, project, org, member in (("kA", P1, "orgA", "mA"), ("kB", P3, "orgB", "mB")):
        tok = _as(key)
        try:
            assert (client.project_id, client.org_id, client.member_id) == (project, org, member), key
        finally:
            ac.reset_api_key_override(tok)


def test_a_key_without_a_default_is_told_to_choose_and_never_gets_the_process_wide_project():
    ac._auth_ctx_cache["kC"] = _ctx("", accessible=[P1, P2])          # two projects, none chosen
    client._project_id, client._accessible_project_ids = GLOBAL, ["x", "y", "z"]
    tok = _as("kC")
    try:
        assert client.project_id == ""
        with pytest.raises(SprintableApiError) as ei:
            client.require_project_id()
    finally:
        ac.reset_api_key_override(tok)
    assert "set_default_project" in str(ei.value) and ei.value.body["accessible_project_ids"] == [P1, P2]   # ITS list, not the process-wide one


def test_a_key_whose_projects_were_never_looked_up_is_not_answered_from_the_process_wide_fields():
    """HTTP, the key has no context yet (the check failed or never ran) while a stdio-style process-wide state says «resolved, several projects»: the key is told it was not checked, not that list"""
    client._auth_resolved, client._project_id_ambiguous, client._accessible_project_ids = True, True, ["x", "y"]
    tok = _as("kNew")
    try:
        with pytest.raises(SprintableApiError) as ei:
            client.require_project_id()
    finally:
        ac.reset_api_key_override(tok)
    assert ei.value.code == "KEY_NOT_CHECKED"


def test_an_explicit_project_still_wins_over_everything():
    ac._auth_ctx_cache["kA"] = _ctx(P1, accessible=[P1, P2])
    client._project_id = GLOBAL
    tok, ptok = _as("kA"), ac.set_project_override(P2)
    try:
        assert client.project_id == P2
    finally:
        ac.reset_project_override(ptok)
        ac.reset_api_key_override(tok)


def test_stdio_is_unchanged_the_process_wide_value_is_the_keys_state():
    client._project_id = P1            # no per-request key: stdio
    assert client.project_id == P1
    client._project_id = ""
    client._accessible_project_ids = [P1, P2]
    client._auth_resolved = True
    with pytest.raises(SprintableApiError) as ei:
        client.require_project_id()
    assert ei.value.body["accessible_project_ids"] == [P1, P2]


# ───────────────────────── set_default_project: one key's state, not the process's ─────────────────────────

async def _choose(key: str, project: str) -> None:
    """what a request of `key` does when its agent calls set_default_project(project) — the server answers with the resolved default"""
    tok = _as(key)
    try:
        with patch.object(pr.client, "patch", new=AsyncMock(return_value={"resolved_default_project_id": project})):
            await pr.set_default_project(pr.SetDefaultProjectInput(project_id=project))
    finally:
        ac.reset_api_key_override(tok)


@pytest.mark.anyio
async def test_the_key_that_chose_last_cannot_change_another_key():
    ac._auth_ctx_cache["kA"] = _ctx("", accessible=[P1, P2])
    ac._auth_ctx_cache["kB"] = _ctx("", accessible=[P1, P2])
    await _choose("kA", P1)
    await _choose("kB", P2)
    await _choose("kA", P1)
    for key, want in (("kA", P1), ("kB", P2)):
        tok = _as(key)
        try:
            assert client.project_id == want, key
        finally:
            ac.reset_api_key_override(tok)
    assert client._project_id == "" and client._project_id_ambiguous is False   # nothing process-wide was written


@pytest.mark.anyio
async def test_a_key_that_has_its_own_default_keeps_it_when_another_key_chooses():
    ac._auth_ctx_cache["kA"] = _ctx("", accessible=[P1, P2])
    ac._auth_ctx_cache["kB3"] = _ctx(P2, accessible=[P1, P2])           # B3's default P2 is stored on the server
    ac._auth_ctx_cache["kOther"] = _ctx(P3, accessible=[P3], org="org2")
    await _choose("kA", P1)
    for key, want in (("kB3", P2), ("kOther", P3)):
        tok = _as(key)
        try:
            assert client.project_id == want, key
        finally:
            ac.reset_api_key_override(tok)


@pytest.mark.anyio
async def test_two_keys_choosing_at_the_same_time_each_keep_their_own():
    ac._auth_ctx_cache["kA"] = _ctx("", accessible=[P1, P2])
    ac._auth_ctx_cache["kB"] = _ctx("", accessible=[P1, P2])
    seen: dict[str, str] = {}
    wants = {"kA": P1, "kB": P2}
    patch_before = client.__dict__.get("patch", "absent")   # whatever an earlier test of the process left there; this test must leave it exactly as it found it

    async def slow_patch(*a, **k):
        await asyncio.sleep(0.01)                 # the other request runs while this one waits for the server
        return {"resolved_default_project_id": wants[ac._api_key_override.get()]}   # the server answers for the key of THIS request

    async def request(key: str) -> None:
        tok = _as(key)
        try:
            await pr.set_default_project(pr.SetDefaultProjectInput(project_id=wants[key]))
            await asyncio.sleep(0.01)
            seen[key] = client.project_id
        finally:
            ac.reset_api_key_override(tok)

    with patch.object(pr.client, "patch", new=AsyncMock(side_effect=slow_patch)):   # ONE patch around both requests: overlapping patch.object of one attribute leaves a fake behind
        await asyncio.gather(request("kA"), request("kB"))
    assert seen == {"kA": P1, "kB": P2}
    assert client._project_id == ""
    assert client.__dict__.get("patch", "absent") is patch_before   # nothing was left on the shared client by this test


@pytest.mark.anyio
async def test_over_stdio_choosing_still_sets_the_process_wide_default():
    client._api_key = "env-key"
    ac._auth_ctx_cache["env-key"] = _ctx("", accessible=[P1, P2])
    with patch.object(pr.client, "patch", new=AsyncMock(return_value={"resolved_default_project_id": P2})):
        await pr.set_default_project(pr.SetDefaultProjectInput(project_id=P2))   # no per-request key: stdio
    assert client._project_id == P2 and client._project_id_ambiguous is False
    assert client.project_id == P2 and ac._auth_ctx_cache["env-key"]["project_id"] == P2


# ───────────────────────── through a real tool: where the wrong project id used to leave the process ─────────────────────────

@pytest.mark.anyio
async def test_a_real_tool_call_of_another_key_sends_its_own_project_after_a_key_chose():
    from sprintable_mcp.tools.stories import ListStoriesInput, list_stories

    ac._auth_ctx_cache["kA"] = _ctx("", accessible=[P1, P2])
    ac._auth_ctx_cache["kB"] = _ctx(P3, accessible=[P3])
    await _choose("kA", P1)
    sent: list[dict] = []

    async def fake_get(path, *, params=None):
        sent.append(dict(params or {}))
        return [], {}

    tok = _as("kB")
    try:
        with patch.object(client, "get_with_headers", new=AsyncMock(side_effect=fake_get)):
            await list_stories(ListStoriesInput())
    finally:
        ac.reset_api_key_override(tok)
    assert sent and sent[0]["project_id"] == P3      # B's own project, not the one A chose


# ───────────────────────── the same process: nothing leaks in, nothing leaks out (the property, not a run of other files) ─────────────────────────

def _fill_with_foreign_state() -> dict:
    """what some other test of the process may have left behind: values that differ from a blank state in every shared place"""
    client._project_id, client._org_id, client._member_id = "DEFAULT", "org-left", "m-left"
    client._project_id_ambiguous, client._accessible_project_ids, client._auth_resolved = True, ["z"], True
    client._api_key = "left-key"
    client.__dict__["patch"] = "a fake left on the client"
    ac._auth_ctx_cache["left"] = _ctx("DEFAULT", accessible=["z"])
    ac._auth_checked_at["left"] = 123.0
    ac._inflight_checks["left"] = {object()}
    ac._recheck_after_401["left"] = (456.0, True)
    ac._invalidated_checks.add(object())
    return {
        "client": copy.copy(client.__dict__),
        "module": {name: copy.copy(getattr(ac, name)) for name in _MODULE_STATE},
        "invalidated": set(ac._invalidated_checks),
    }


def test_the_isolation_puts_back_exactly_the_shared_state_it_found():
    found = _fill_with_foreign_state()
    with _isolated_state():
        client._project_id = "changed-inside"                 # the code inside changes and adds everything it likes
        client.__dict__["another"] = 1
        client.__dict__.pop("patch", None)
        for name in _MODULE_STATE:
            getattr(ac, name).clear()
        ac._auth_ctx_cache["inside"] = _ctx(P1, accessible=[P1])
        ac._invalidated_checks.clear()
    assert client.__dict__ == found["client"]
    for name in _MODULE_STATE:
        assert getattr(ac, name) == found["module"][name], name
    assert ac._invalidated_checks == found["invalidated"]


@pytest.mark.anyio
async def test_the_core_tests_hold_whatever_the_shared_state_held_before():
    """the two tests that matter most for isolation run with every shared place already filled with foreign values: they build their own state and still hold"""
    _fill_with_foreign_state()
    with _isolated_state():
        assert client._project_id == "" and client._api_key == "" and ac._auth_ctx_cache == {} and ac._recheck_after_401 == {}   # a blank state of its own
        await test_the_key_that_chose_last_cannot_change_another_key()
    with _isolated_state():
        await test_two_keys_choosing_at_the_same_time_each_keep_their_own()
        await test_a_key_that_has_its_own_default_keeps_it_when_another_key_chooses()
