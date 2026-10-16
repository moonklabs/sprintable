"""story 4710 — narrowing an agent key's scope to a role's scope WITHOUT ever widening it.

`ApiKeyRepository.sync_active_scope` ASSIGNS a scope (`SET scope = …`): fine when the new scope is the narrowing one, but a key that was
narrower than the role (`["docs"]` against a role of `[stories, tasks, chat, docs]`) would be WIDENED to the role's scope with the same
plaintext. A key-less hire (`issue_key=False`) must not do that, so it asks this module for the scope to store: what the key may do
today ∩ what the role may do.

How a scope list is read (`mcp_toolset.is_tool_allowed` · `_check_api_key_scope`):
- group names (`ALL_GROUPS`, plus `admin`) → exactly those groups; none of them (an empty list, or only `read`/`write`) → EVERY group,
  non-destructive;
- `admin` / `destructive` → destructive tools too (`admin` is also a group name);
- `read` / `write` → the coarse method gate of `_check_api_key_scope` (a key holding only `read` cannot write).
An empty list therefore means «everything non-destructive», never «nothing» — the intersection of two disjoint group sets cannot be written
as a list at all, so it is reported (`None`) and the caller refuses instead of storing a list that would widen.
"""
from __future__ import annotations

from app.services.mcp_toolset import ALL_GROUPS, _DESTRUCTIVE_SCOPES, _LEGACY_SCOPES


def _read(scope: list[str] | None) -> tuple[frozenset[str] | None, bool, list[str], list[str]]:
    """(groups or None = every group, destructive?, the key's coarse `read` / `write` tokens AS WRITTEN, its tokens as written).

    Group and destructive tokens are read lower-cased and stripped, as `is_tool_allowed` / `resolve_policy` read them. The coarse `read` /
    `write` tokens are NOT: `_check_api_key_scope` compares them exactly (`set(scope) & _LEGACY_SCOPES`, `required not in scope`), so
    `["read", "WRITE"]` is a read-only key there — normalising it to `["read", "write"]` would let it write (found by codex on 5127)."""
    raw = [s for s in (scope or []) if isinstance(s, str)]
    tokens = [s.strip().lower() for s in raw if s.strip()]
    present = set(tokens)
    explicit = (present & set(ALL_GROUPS)) | (present & {"admin"})
    return (
        frozenset(explicit) if explicit else None,
        bool(present & _DESTRUCTIVE_SCOPES),
        [s for s in raw if s in _LEGACY_SCOPES],
        raw,
    )


def narrowed_scope(current: list[str] | None, role: list[str] | None) -> list[str] | None:
    """The scope to store for a key that holds `current` when its agent now has the role scope `role`: the intersection, which can never
    allow anything either of the two does not. `None` = the two share no group (nothing representable) — the caller must not store anything."""
    # a role's scope is its `default_tool_groups`: `ALL_GROUPS` names only (`validate_tool_groups`). Anything else — the coarse `read` / `write`,
    # `admin` / `destructive`, an unknown name — is outside what this maths understands (a role's coarse `read` gate is not an intersection of
    # groups, and `read ∪ write` would WIDEN a read-only key): refuse it instead of answering a contract it cannot keep.
    stray = sorted({s.strip().lower() for s in (role or []) if s and s.strip()} - set(ALL_GROUPS))
    if stray:
        raise ValueError(f"role scope holds tokens that are not tool groups: {stray}")
    g_cur, d_cur, legacy_cur, raw_cur = _read(current)
    g_role, d_role, _legacy_role, _tokens_role = _read(role)
    destructive = d_cur and d_role

    if g_cur is None and g_role is None:
        # both «every group, non-destructive»: the key keeps its tokens exactly as written, minus a destructive grant the role does not have
        if destructive == d_cur:
            return list(raw_cur)
        return [t for t in raw_cur if t.strip().lower() not in _DESTRUCTIVE_SCOPES]

    groups = g_role if g_cur is None else g_cur if g_role is None else g_cur & g_role
    assert groups is not None
    if "admin" in groups and not destructive:
        groups = groups - {"admin"}  # `admin` as a token grants destructive tools as well — without the grant the group goes
    if not groups:
        return None
    tokens = sorted(groups) + sorted(set(legacy_cur))
    if destructive and "admin" not in groups:
        tokens.append("destructive")
    return tokens
