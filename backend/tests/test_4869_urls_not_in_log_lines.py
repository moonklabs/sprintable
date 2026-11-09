"""story 4869 (lens) — a URL is a credential here (the path of a Discord webhook IS its secret; query strings carry tokens): a log line names the HOST.

1. the helper (`app/core/log_safe.py`);
2. the four places that used to print a webhook URL in a warning — each driven into its failure with a canary inside the URL: the log carries the host and no canary;
3. a scan of every `logger.*(…)` call in `backend/app` whose message has `url=`: it must pass the URL through `url_host(...)` — so a fifth place cannot come back unnoticed.
"""
from __future__ import annotations

import ast
import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.core.log_safe import redact_urls, url_host

_APP = Path(__file__).resolve().parents[1] / "app"
PATH_CANARY = "CANARY-WEBHOOK-PATH-TOKEN-5d1e"
QUERY_CANARY = "CANARY-QUERY-TOKEN-88ab"
URL = f"https://hooks.example.test:8443/api/webhooks/123456/{PATH_CANARY}?token={QUERY_CANARY}"


# ───────────────────────── the helper ─────────────────────────

def test_url_host_keeps_host_and_port_only() -> None:
    assert url_host(URL) == "hooks.example.test:8443"
    assert url_host("https://user:pass@example.test/a/b?c=d#e") == "example.test"
    assert url_host("HTTP://Example.Test/x") == "example.test"


@pytest.mark.parametrize("bad", ["", "not a url", "https://", "http://[::1", None, 42])
def test_anything_that_is_not_a_url_with_a_host_reads_unparseable(bad) -> None:
    assert url_host(bad) == "(unparseable-url)"


def test_redact_urls_replaces_every_url_inside_a_text() -> None:
    text = f"Client error '404 Not Found' for url '{URL}' and also {URL}.\nFor more information check: https://developer.mozilla.org/docs"
    out = redact_urls(text)
    assert PATH_CANARY not in out and QUERY_CANARY not in out
    assert "https://hooks.example.test:8443/…" in out and out.count("hooks.example.test:8443") == 2
    assert "https://developer.mozilla.org/…" in out and "Client error '404 Not Found'" in out


# ───────────────────────── the four places ─────────────────────────

def _no_canary(caplog) -> str:
    text = "\n".join(f"{r.getMessage()} {r.exc_text or ''}" for r in caplog.records)
    assert PATH_CANARY not in text and QUERY_CANARY not in text, text
    return text


async def _no_sleep(*_a, **_k) -> None:
    return None


@pytest.mark.asyncio
async def test_dispatch_router_names_the_host_when_every_retry_failed(monkeypatch, caplog) -> None:
    from app.services import dispatch_router

    class _Boom:
        def __init__(self, *a, **k) -> None: ...
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, *a, **k): raise httpx.ConnectError("all connection attempts failed")

    monkeypatch.setattr(dispatch_router.httpx, "AsyncClient", _Boom)
    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    caplog.set_level(logging.WARNING)
    assert await dispatch_router._post_with_retry(URL, {"a": 1}, None, "member-1") is False
    text = _no_canary(caplog)
    assert "hooks.example.test:8443" in text and "all retries exhausted" in text


def test_workflow_report_names_the_host_when_the_reply_webhook_fails(monkeypatch, caplog) -> None:
    from app.routers import workflow_report

    def _boom(*a, **k):
        raise httpx.ConnectError("no route")

    monkeypatch.setattr(workflow_report.httpx, "post", _boom)
    caplog.set_level(logging.WARNING)
    workflow_report._fire_webhook(URL, "done", "title", "", "")
    text = _no_canary(caplog)
    assert "hooks.example.test:8443" in text and "reply webhook fire failed" in text


@pytest.mark.asyncio
async def test_conversation_webhook_names_the_host_and_scrubs_the_status_error_text(monkeypatch, caplog) -> None:
    """the injected-event delivery: the HTTP status error's message holds the whole request URL; the log line gets the host and the text with the URL scrubbed"""
    import uuid

    from app.services import conversation_webhook as cw

    wh = SimpleNamespace(url=URL, secret=None, events=None)

    class _Db:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def execute(self, *_a, **_k):
            return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: [wh]))

    async def _attempt(url, secret, payload):
        req = httpx.Request("POST", url)
        raise httpx.HTTPStatusError(f"Client error '404 Not Found' for url '{url}'", request=req, response=httpx.Response(404, request=req))

    import app.core.database as database

    monkeypatch.setattr(database, "async_session_factory", lambda: _Db())
    monkeypatch.setattr(cw, "_attempt_delivery", _attempt)
    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    caplog.set_level(logging.WARNING)
    await cw.deliver_injected_event_webhook(org_id=uuid.uuid4(), recipient_id=uuid.uuid4(), content="hello", event_type="dispatched")
    text = _no_canary(caplog)
    assert "hooks.example.test:8443" in text and "delivery failed" in text and "Client error '404 Not Found'" in text


@pytest.mark.asyncio
async def test_the_retry_loop_scrubs_the_url_from_the_log_and_from_the_stored_last_error(monkeypatch, caplog) -> None:
    """`_retry_deliver` (the webhook delivery with retries): the HTTP status error's text holds the whole request URL; it goes to the warning, to the permanent-failure error AND into `last_error` that is stored — none of them may carry the URL's secret"""
    import uuid

    from app.services import conversation_webhook as cw

    async def _attempt(url, secret, payload):
        req = httpx.Request("POST", url)
        raise httpx.HTTPStatusError(f"Client error '404 Not Found' for url '{url}'", request=req, response=httpx.Response(404, request=req))

    stored: list[str | None] = []

    async def _status(delivery_id, status, attempt_count=None, last_error=None):
        stored.append(last_error)

    monkeypatch.setattr(cw, "_attempt_delivery", _attempt)
    monkeypatch.setattr(cw, "_update_delivery_status", _status)
    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    caplog.set_level(logging.WARNING)
    await cw._retry_deliver(uuid.uuid4(), URL, None, {})
    text = _no_canary(caplog)
    assert "failed permanently" in text and "attempt 1/" in text and "Client error '404 Not Found'" in text
    last = [s for s in stored if s]
    assert last and all(PATH_CANARY not in s and QUERY_CANARY not in s for s in last), last


def test_url_host_never_raises_on_what_a_log_argument_can_be() -> None:
    """it runs inside `except` blocks: an object whose __str__ raises, or a port that is not a number, reads «(unparseable-url)» instead of replacing the real error"""

    class _Boom:
        def __str__(self) -> str:
            raise RuntimeError("boom")

    assert url_host(_Boom()) == "(unparseable-url)"
    assert url_host("https://host.example:notaport/x") == "(unparseable-url)"


# ───────────────────────── nothing in backend/app prints «url=» without the helper ─────────────────────────

_LOG_METHODS = {"debug", "info", "warning", "error", "exception", "critical", "log"}


def _calls_that_print_a_url():
    for path in sorted(_APP.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in _LOG_METHODS):
                continue
            if not (isinstance(node.func.value, ast.Name) and node.func.value.id in {"logger", "log", "_logger", "LOGGER"}):
                continue
            fmt = next((a for a in node.args if isinstance(a, ast.Constant) and isinstance(a.value, str)), None)
            if fmt is not None and ("url=" in fmt.value or "url:" in fmt.value.lower()):
                yield path, node


def test_every_log_call_with_url_in_its_message_passes_the_url_through_the_helper() -> None:
    offenders = []
    for path, node in _calls_that_print_a_url():
        names = {n.func.id for n in ast.walk(node) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
        if not names & {"url_host", "redact_urls"}:
            offenders.append(f"{path.relative_to(_APP.parent)}:{node.lineno}")
    assert not offenders, f"a log line prints a URL (a credential): use url_host(): {offenders}"


def test_the_scan_finds_the_four_calls_that_were_fixed_so_it_is_not_vacuous() -> None:
    seen = {f"{p.relative_to(_APP)}" for p, _ in _calls_that_print_a_url()}
    assert {"routers/conversations.py", "routers/workflow_report.py", "services/dispatch_router.py"} <= seen
