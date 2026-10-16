"""PO 2026-10-07 22:51Z (Minh's catch_test_host): the suite's own guard (tests/_no_real_network.py, installed by conftest) refuses a
request to a made-up host or a metadata address before a socket opens and records it — conftest's autouse fixture then fails that
test. Each test here takes what it caught out of the record itself, so only the refusal is under test."""
from __future__ import annotations

import os
import socket
import urllib.request

import httpx
import pytest

from tests import _no_real_network as guard


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _take() -> list[str]:
    caught = [what for _where, what in guard.CAUGHT]
    guard.CAUGHT.clear()
    return caught


def test_the_made_up_rule():
    for h in ("test", "x", "api", "member-1", "foo.test", "testserver", "TEST", "169.254.169.254", "169.254.0.1", "fe80::1",
              "[fd00:ec2::254]", "metadata.google.internal"):
        assert guard.is_made_up(h), h
    for h in ("localhost", "127.0.0.1", "::1", "[::1]", "10.0.0.1", "8.8.8.8", "example.com", "api.anthropic.com", "dev-app.sprintable.ai", ""):
        assert not guard.is_made_up(h), h


def test_metadata_lookups_are_off_for_the_suite():
    # google-auth (google.auth.default) and boto ask the metadata server for credentials unless told not to
    assert os.environ.get("NO_GCE_CHECK") == "true"
    assert os.environ.get("AWS_EC2_METADATA_DISABLED") == "true"


@pytest.mark.parametrize("url", ["http://x/api/v2/auth/me", "http://test/y", "https://api/z", "http://169.254.169.254/computeMetadata/v1/"])
def test_httpx_to_a_made_up_host_is_refused_and_recorded(url):
    with pytest.raises(httpx.ConnectError, match="_no_real_network"):
        httpx.get(url, timeout=2)
    assert _take() == [f"httpx GET {url}"]  # mutant: install() not called by conftest → a real attempt, nothing recorded → RED


@pytest.mark.anyio
async def test_async_httpx_is_refused_too():
    async with httpx.AsyncClient() as c:
        with pytest.raises(httpx.ConnectError, match="_no_real_network"):
            await c.patch("http://x/api/v2/team-members/MEM/heartbeat")
    assert len(_take()) == 1


def test_urllib_and_a_raw_socket_are_refused():
    with pytest.raises(Exception, match="_no_real_network"):
        urllib.request.urlopen("http://169.254.169.254/latest/meta-data/", timeout=2)
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        with pytest.raises(ConnectionRefusedError, match="_no_real_network"):
            s.connect(("169.254.169.254", 80))
        assert s.connect_ex(("169.254.169.254", 80)) != 0
    finally:
        s.close()
    assert len(_take()) >= 2


@pytest.mark.anyio
async def test_an_asgi_transport_is_not_touched():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        assert (await c.get("/y")).status_code == 204
    assert _take() == []
