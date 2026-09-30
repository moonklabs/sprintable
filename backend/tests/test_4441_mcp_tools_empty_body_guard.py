"""story #4441 — the shared MCP client answers a success with no body (204, or an empty 200) with ``None`` (story #4430 ·
PR 4853). A tool that then reads a field of that result straight away breaks on ``None``, and since every handler ends in
``except Exception as exc: return err(exc)``, the break never escapes: it comes back as ``Error: UNKNOWN: 'NoneType' …`` — a
call that succeeded, reported as a failure.

This guard runs **every** tool the server registers (``server._TOOL_DEFS``, collected here, so a new tool is covered without
editing this file) against a client whose every call succeeds with no body, and fails naming each tool that turns that
into a ``NoneType`` error (or lets any exception out). Nothing reaches the network: the one request method all client
calls go through is replaced.
"""
from __future__ import annotations

import datetime as dt
import enum
import json
import sys
import types
import typing
import uuid
from typing import Any

import pytest
from pydantic import BaseModel

from sprintable_mcp import api_client, server
from sprintable_mcp.api_client import as_list, as_mapping
from sprintable_mcp.tools import channel_posts, content_rules, projects


def _filler(ann: Any) -> Any:
    """A plausible value for a field's annotation, so the tool gets past its own checks to the client call."""
    origin = typing.get_origin(ann)
    args = typing.get_args(ann)
    if origin in (typing.Union, types.UnionType):
        inner = [a for a in args if a is not type(None)]
        return _filler(inner[0]) if inner else None
    if origin is typing.Literal:
        return args[0]
    if origin is typing.Annotated:
        return _filler(args[0])
    if origin in (list, set, frozenset, tuple) or ann in (list, set, tuple):
        return []
    if origin is dict or ann is dict:
        return {}
    if isinstance(ann, type):
        if issubclass(ann, bool):
            return False
        if issubclass(ann, enum.Enum):
            return next(iter(ann))
        if issubclass(ann, int):
            return 1
        if issubclass(ann, float):
            return 1.0
        if issubclass(ann, str):
            return "x"
        if issubclass(ann, uuid.UUID):
            return uuid.UUID(int=1)
        if issubclass(ann, dt.datetime):
            return dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
        if issubclass(ann, dt.date):
            return dt.date(2026, 1, 1)
        if issubclass(ann, BaseModel):
            return _build(ann)
    return None


def _build(cls: type[BaseModel]) -> BaseModel:
    """Every field filled (defaults kept), without the model's validators — the point is to reach the client call."""
    hints = typing.get_type_hints(cls, include_extras=True)
    values = {}
    for name, field in cls.model_fields.items():
        values[name] = _filler(hints.get(name, field.annotation))
    return cls.model_construct(**values)


# The few tools whose own input rules refuse the filler before any call (each refusal is deliberate, so the input is made
# valid here instead): one image source only · no «type» filter (the server has none) · no «mark unread» (not supported).
_OVERRIDES: dict[str, dict[str, Any]] = {
    "sprintable_import_image_artifact": {"image_path": None, "image_base64": "iVBORw0KGgo=", "content_type": "image/png"},
    "sprintable_mark_all_notifications_read": {"type": None},
    "sprintable_mark_notification_read": {"is_read": True},
}


def _tool_ids() -> list[str]:
    return [d[0] for d in server._TOOL_DEFS]


@pytest.fixture
def empty_body_client(monkeypatch):
    """Every client call succeeds with no body: None, or (None, headers) where the caller asked for headers."""
    calls: list[tuple[str, str]] = []

    async def request(method, path, *, json=None, params=None, unwrap=True, return_headers=False):
        calls.append((method, path))
        return (None, {}) if return_headers else None

    monkeypatch.setattr(api_client.client, "request", request)
    # the context a real agent key resolves at boot (auth/me) — without it most tools stop before their call
    for attr, value in (("_member_id", str(uuid.UUID(int=2))), ("_org_id", str(uuid.UUID(int=3))), ("_project_id", str(uuid.UUID(int=4)))):
        monkeypatch.setattr(api_client.client, attr, value)
    return calls


@pytest.mark.parametrize("tool", _tool_ids())
async def test_a_success_with_no_body_is_never_a_none_error(tool, empty_body_client, monkeypatch):
    _, _, cls, fn = next(d for d in server._TOOL_DEFS if d[0] == tool)
    module = sys.modules[fn.__module__]
    caught: list[BaseException] = []
    real_err = module.err

    def spy(exc):
        if isinstance(exc, BaseException):
            caught.append(exc)
        return real_err(exc)

    monkeypatch.setattr(module, "err", spy)
    args = _build(cls)
    for field, value in _OVERRIDES.get(tool, {}).items():
        setattr(args, field, value)
    try:
        out = await fn(args)
    except Exception as exc:  # noqa: BLE001 — anything that escapes the handler is the failure itself
        pytest.fail(f"{tool}: {type(exc).__name__} escaped on an empty body: {exc}")
    none_errors = [e for e in caught if "NoneType" in str(e)]
    assert not none_errors, f"{tool}: a success with no body came back as an error — {type(none_errors[0]).__name__}: {none_errors[0]}"
    assert isinstance(out, list), f"{tool}: returned {type(out).__name__}"
    # a tool that stopped before its call would pass this guard without being tested: every tool must reach the client
    # (a new tool that refuses the filler gets an entry in _OVERRIDES)
    assert empty_body_client, f"{tool}: never reached the client (stopped at: {caught[0] if caught else 'nothing'}) — add it to _OVERRIDES"


def test_the_helpers_change_only_an_empty_body():
    body, items = {"a": 1}, [1]
    assert as_mapping(body) is body and as_list(items) is items   # the very same object: nothing else changes
    assert as_mapping(None) == {} and as_list(None) == []


# A response with a body is unchanged byte for byte (AC2): the tools fixed here, given realistic bodies, answer exactly
# what they answered before the change (recorded on develop c1eae9842 — tests/fixtures/story_4441_body_outputs.json).
_BODIES: dict[str, Any] = {
    "/content-rules": {"rules": {"tone": "차분하게", "banned_terms": ["x"]}, "version": 3, "updated_at": "2026-09-30T00:00:00Z"},
    "/generation-budget": {"monthly_limit": 100, "used": 7, "exhausted": False},
    "/drafts/": {"id": "d-1", "publication_id": "pub-1", "status": "published"},
    "/insights": [
        {"offset_label": "1d", "status": "captured", "metrics": {"views": 10, "likes": 1, "shares": None}},
        {"offset_label": "7d", "status": "captured", "metrics": {"views": 40, "likes": 3, "shares": None}},
        {"offset_label": None, "status": "captured", "metrics": {"views": 5}},
    ],
    "/default-project": {"resolved_default_project_id": str(uuid.UUID(int=9)), "default_project_id": str(uuid.UUID(int=9))},
}
_GOLDEN = json.loads((__import__("pathlib").Path(__file__).parent / "fixtures" / "story_4441_body_outputs.json").read_text(encoding="utf-8"))


async def test_a_response_with_a_body_is_answered_byte_for_byte_as_before(empty_body_client, monkeypatch):
    async def request(method, path, *, json=None, params=None, unwrap=True, return_headers=False):
        body = next(v for k, v in _BODIES.items() if k in path)
        return (body, {}) if return_headers else body

    monkeypatch.setattr(api_client.client, "request", request)
    got = {
        "get_content_rules": (await content_rules.get_content_rules(content_rules.GetContentRulesInput()))[0].text,
        "get_publication_insights": (await channel_posts.get_publication_insights(channel_posts.GetPublicationInsightsInput(draft_id="d-1")))[0].text,
        "set_default_project": (await projects.set_default_project(projects.SetDefaultProjectInput(project_id=str(uuid.UUID(int=9)))))[0].text,
    }
    assert got == _GOLDEN["outputs"]
    assert api_client.client._project_id == _GOLDEN["cache_project_after_set_default"]   # the cache still follows the answer
