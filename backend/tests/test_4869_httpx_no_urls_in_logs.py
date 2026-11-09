"""story 4869 (lens) — an outgoing HTTP request must not put its URL into a log line.

httpx logs every request at INFO with the full URL; the URLs of the Meta / Instagram / Facebook / Google calls carry access tokens, an OAuth client_secret or a webhook secret in the query or the path.
`configure_logging()` (the backend's own logging set-up, JSON on stdout) sets `httpx` and `httpcore` to WARNING. The test runs a real httpx client over a mock transport, with canaries in the
query and in the path, under the backend's real logging configuration, and reads what reaches stdout.
"""
from __future__ import annotations

import io
import logging
import sys

import httpx
import pytest

from app.core.logging_config import configure_logging

QUERY_CANARY = "CANARY-QUERY-ACCESS-TOKEN-7f3a"
PATH_CANARY = "CANARY-PATH-WEBHOOK-SECRET-91c2"


class _Out:
    """what the backend's own handler wrote: the handler is made by `configure_logging()` on whatever `sys.stdout` is at that moment, so it is a StringIO we own (not pytest's capture, which closes between tests)"""

    def __init__(self, buf: io.StringIO) -> None:
        self._buf = buf

    def text(self) -> str:
        return self._buf.getvalue()


@pytest.fixture()
def configured(monkeypatch):
    buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buf)
    root = logging.getLogger()
    saved = (list(root.handlers), root.level, {n: logging.getLogger(n).level for n in ("httpx", "httpcore")})
    configure_logging(json_logs=True)
    try:
        yield _Out(buf)
    finally:
        root.handlers[:] = saved[0]
        root.setLevel(saved[1])
        for n, lvl in saved[2].items():
            logging.getLogger(n).setLevel(lvl)


def _call(client_cls, *, status: int = 200) -> None:
    handler = lambda request: httpx.Response(status, json={"ok": True})  # noqa: E731
    url = f"https://graph.example.test/v19.0/{PATH_CANARY}/media?access_token={QUERY_CANARY}"
    with client_cls(transport=httpx.MockTransport(handler)) as c:
        c.get(url)


def test_no_log_line_of_a_sync_request_carries_the_url(configured) -> None:
    logging.getLogger("app.probe").warning("the handler is alive")
    _call(httpx.Client)
    assert "the handler is alive" in configured.text(), "the backend handler writes to our buffer: an absent canary below means something"
    out = configured.text()
    assert QUERY_CANARY not in out and PATH_CANARY not in out


@pytest.mark.asyncio
async def test_no_log_line_of_an_async_request_carries_the_url(configured) -> None:
    handler = lambda request: httpx.Response(200, json={"ok": True})  # noqa: E731
    url = f"https://graph.example.test/v19.0/{PATH_CANARY}/media?access_token={QUERY_CANARY}"
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        await c.get(url)
    out = configured.text()
    assert QUERY_CANARY not in out and PATH_CANARY not in out


def test_the_two_loggers_are_at_warning_and_a_warning_would_still_be_written(configured) -> None:
    for name in ("httpx", "httpcore"):
        assert logging.getLogger(name).level == logging.WARNING, name
    logging.getLogger("httpx").warning("a failure is still visible")
    assert "a failure is still visible" in configured.text()


def test_without_the_setting_the_url_would_be_logged_so_the_canary_test_is_not_vacuous(configured) -> None:
    logging.getLogger("httpx").setLevel(logging.INFO)
    _call(httpx.Client)
    assert QUERY_CANARY in configured.text(), "the same request at INFO does log the URL: the tests above prove the setting, not an absent log"
