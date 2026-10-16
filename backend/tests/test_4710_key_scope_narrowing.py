"""story 4710 — `key_scope.narrowed_scope`: a key-less hire narrows an existing key to (what it may do) ∩ (the role's scope), never widens it —
and `RecruitRequest.issue_key` is a strict bool.

No database: the scope maths is pure. The property test reads every scope through the SAME functions the server enforces with
(`mcp_toolset.is_tool_allowed` · `path_allowed_for_scope`) over a sample of tool names from every group, so a rule that drifts from the
enforcement fails here: for every pair (key today, role) the stored scope allows nothing either of them does not — and nothing that both allow
is lost."""
from __future__ import annotations

import itertools

import pytest
from pydantic import ValidationError

from app.schemas.recruit import RecruitRequest
from app.services.key_scope import narrowed_scope
from fastapi import HTTPException

from app.dependencies.auth import _check_api_key_scope
from app.services.mcp_toolset import _ALWAYS_ALLOWED, _GROUP_KEYWORDS, ALL_GROUPS, is_tool_allowed, tool_group

SCOPES: list[list[str]] = [
    [], ["read"], ["write"], ["read", "write"],
    ["docs"], ["docs", "webhooks"], ["stories", "tasks", "chat", "docs"], list(ALL_GROUPS),
    ["admin"], ["destructive"], ["docs", "destructive"], ["docs", "admin"], ["stories", "read"], ["core"],
    ["docs", "no-such-group"],
    # tokens as written: the coarse gate compares `read` / `write` exactly, the group reading lower-cases (codex 5127)
    ["read", "WRITE"], ["READ", "write"], ["Read"], ["WRITE"], [" read "], ["Docs", "read", "WRITE"], ["DESTRUCTIVE", "docs"],
]


def _tools() -> list[str]:
    names: list[str] = []
    for group, keywords in _GROUP_KEYWORDS:
        for kw in keywords:
            names.append(f"sprintable_{kw}_x")
            names.append(f"sprintable_delete_{kw}")
    return [n for n in dict.fromkeys(names) if n not in _ALWAYS_ALLOWED]


# a role's scope is its `default_tool_groups`, which `validate_tool_groups` holds to `ALL_GROUPS` names — never `admin` / `destructive` / read / write
ROLE_SCOPES: list[list[str]] = [[], ["docs"], ["docs", "webhooks"], ["stories", "tasks", "chat", "docs"], list(ALL_GROUPS), ["core"]]

TOOLS = _tools()


def _allowed(scope: list[str]) -> set[str]:
    return {t for t in TOOLS if is_tool_allowed(t, scope)}


@pytest.mark.parametrize("current,role", list(itertools.product(range(len(SCOPES)), range(len(ROLE_SCOPES)))))
def test_the_stored_scope_never_allows_what_the_key_or_the_role_does_not(current, role):
    cur, rol = SCOPES[current], ROLE_SCOPES[role]
    out = narrowed_scope(cur, rol)
    both = _allowed(cur) & _allowed(rol)
    # the one thing a list cannot say: the token `admin` is BOTH the admin tool group and the destructive grant. A role never holds the grant,
    # so a key's `admin` goes — and the admin group's (non-destructive) tools with it. That is a narrowing, the safe side, and the only loss allowed.
    admin_group = {t for t in TOOLS if tool_group(t) == "admin"}
    if out is None:
        # nothing representable: the two share no tool at all (an empty list would mean «every group» — it must not be stored)
        assert both <= admin_group, f"{cur} ∩ {rol} still shares tools but no scope was offered: {sorted(both - admin_group)[:5]}"
        return
    got = _allowed(out)
    assert got <= _allowed(cur), f"{cur} ∩ {rol} → {out} WIDENS the key by {sorted(got - _allowed(cur))[:5]}"
    assert got <= _allowed(rol), f"{cur} ∩ {rol} → {out} goes past the role by {sorted(got - _allowed(rol))[:5]}"
    assert both - got <= admin_group, f"{cur} ∩ {rol} → {out} loses {sorted((both - got) - admin_group)[:5]}"


class _Auth:
    def __init__(self, scope: list[str]) -> None:
        self.claims = {"app_metadata": {"api_key_id": "k", "scope": scope}}


def _request_ok(scope: list[str], method: str, path: str) -> bool:
    """The server's request-time gate itself (`_check_api_key_scope`: the coarse read/write gate + the path→group gate)."""
    try:
        _check_api_key_scope(_Auth(scope), method, path)  # type: ignore[arg-type]
        return True
    except HTTPException:
        return False


REQUESTS = [(m, p) for m in ("GET", "POST", "DELETE") for p in ("/api/v2/rewards", "/api/v2/conversations", "/api/v2/docs", "/api/v2/webhooks", "/api/v2/notifications")]


@pytest.mark.parametrize("current,role", list(itertools.product(range(len(SCOPES)), range(len(ROLE_SCOPES)))))
def test_no_request_the_key_was_refused_is_allowed_after_narrowing(current, role):
    """Request-time view (the coarse read/write gate included): whatever `_check_api_key_scope` refused for the key before, it still refuses
    after — a key is never widened, whichever way its tokens were spelled."""
    cur, rol = SCOPES[current], ROLE_SCOPES[role]
    out = narrowed_scope(cur, rol)
    if out is None:
        return
    for method, path in REQUESTS:
        if not _request_ok(cur, method, path):
            assert not _request_ok(out, method, path), f"{cur} → {out} now allows {method} {path}"


def test_a_key_written_with_odd_case_read_write_is_not_made_a_writer():
    """Codex on 5127: `["read", "WRITE"]` is read-only to the coarse gate (exact compare); normalising it to `["read", "write"]` let it write."""
    out = narrowed_scope(["read", "WRITE"], [])
    assert out == ["read", "WRITE"]
    assert not _request_ok(out, "POST", "/api/v2/conversations")
    assert narrowed_scope(["READ", "write"], ["docs"]) == ["docs", "write"]
    assert not _request_ok(narrowed_scope(["READ", "write"], ["docs"]), "GET", "/api/v2/docs")


@pytest.mark.parametrize(
    "current,role,expected",
    [
        # the PO's rule (10:31Z)
        ([], ["docs", "webhooks"], ["docs", "webhooks"]),       # a key with no list (= every non-destructive group) narrows to the role
        (["docs"], [], ["docs"]),                                # a role with no list (= every non-destructive group) leaves a narrower key as it is
        (["docs"], ["stories", "tasks", "chat", "docs"], ["docs"]),   # the case that «narrowing» used to WIDEN
        ([], [], []),                                            # both «everything non-destructive»: untouched
        (["docs"], ["stories"], None),                           # disjoint: nothing representable → refuse
        (["read"], ["docs"], ["docs", "read"]),                  # a read-only key stays read-only (the coarse gate is kept)
        (["docs", "destructive"], ["docs"], ["docs"]),           # a destructive grant the role lacks is dropped
    ],
)
def test_the_named_cases(current, role, expected):
    assert narrowed_scope(current, role) == expected


@pytest.mark.parametrize("role", [["read"], ["write"], ["read", "write"], ["admin"], ["destructive"], ["docs", "read"], ["no-such-group"], ["Docs", "read"]])
def test_a_role_scope_that_is_not_only_tool_groups_is_refused(role):
    """Didi's codex (5127): `narrowed_scope(["tasks"], ["read"])` used to answer ["tasks"], which lets POST /tasks through although the role's coarse
    read gate refuses it. A real role cannot hold these tokens (`validate_tool_groups`), so the maths refuses them (the recruit route maps ValueError
    to 400) instead of promising «only what both allow» where it cannot keep it."""
    with pytest.raises(ValueError):
        narrowed_scope(["tasks"], role)


def test_a_key_with_only_admin_and_a_role_without_destructive_is_revoked_not_kept():
    """The documented over-revocation: `admin` is the admin tool group AND the destructive grant. With no grant on the role nothing of the key
    is representable, so the key goes — even though the admin group's non-destructive tools (emit_event …) were allowed by both."""
    assert narrowed_scope(["admin"], []) is None


@pytest.mark.parametrize("value", ["false", "true", "False", 0, 1, "no", None])
def test_issue_key_is_a_strict_bool(value):
    with pytest.raises(ValidationError):
        RecruitRequest(role_template_slug="backend", issue_key=value)


def test_issue_key_default_is_true_and_the_bools_pass():
    assert RecruitRequest(role_template_slug="backend").issue_key is True
    assert RecruitRequest(role_template_slug="backend", issue_key=False).issue_key is False
    assert RecruitRequest(role_template_slug="backend", issue_key=True).issue_key is True
