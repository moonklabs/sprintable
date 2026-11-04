"""story 4843 - `/api/v2/*` on the APP name goes straight to the backend, and a stream the backend cuts ends for the client too.

The incident (prod, 2026-11-04): the agents' clients reach `GET /api/v2/agent/stream` through the app name -> the front door -> the web server's rewrite (next.config.ts) -> the API name -> the front door again -> the
backend. The backend ends that stream by itself every ~5 minutes (agent_gateway `_AGENT_SSE_LIFESPAN_SEC`). Measured on dev: when the upstream of a response the web server rewrites is CUT, the web server never ends the client's
side (Next 16.2.2, Node 22.23.3, 20 of 20 left open with `head sent`); about 36 an hour piled up in `next-server` (172 held) and in the front door (168 in flight against 62 at the backend), and both grew by the day.

Pinned here:
  - the Caddyfile text: the app site has `handle /api/v2/*` -> `reverse_proxy backend:8000` with `flush_interval -1` and NO `encode` (a compressor holds an event stream back), BEFORE the catch-all `handle` that keeps
    `encode zstd gzip` -> `reverse_proxy frontend:3000`; the API site is untouched;
  - with a real Caddy (`SPRINTABLE_TEST_CADDY`, or `caddy` on the PATH; skipped without one, as in test_4796_forwarder): the REAL Caddyfile, with the two service names pointed at local stubs, sends `/api/v2/*` to the backend stub and
    everything else to the web stub; a stream the backend stub cuts with a reset ends the client's connection within seconds (the case the web server failed); an API response is not compressed, a page still is.
"""
from __future__ import annotations

import gzip
import http.client
import os
import re
import shutil
import socket
import struct
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
CADDYFILE = (_ROOT / "deploy/vm/Caddyfile").read_text()
CODE = re.sub(r"(?m)^\s*#.*$", "", CADDYFILE)   # the settings only: the comments talk about them too


def _sites(text: str) -> dict[str, str]:
    """the body of each top-level block of a Caddyfile text, by its address line"""
    out, depth, head, body = {}, 0, "", []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if depth == 0 and s.endswith("{"):
            head, body, depth = ("<global>" if s == "{" else s[:-1].strip()), [], 1
            continue
        if depth >= 1:
            depth += s.count("{") - s.count("}")
            if depth == 0:
                out[head] = "\n".join(body)
                continue
            body.append(line)
    return out


def _blocks(body: str) -> dict[str, str]:
    """the `handle ... {}` blocks directly inside a site body, in order, by their opening line"""
    out, depth, head, cur = {}, 0, "", []
    for line in body.splitlines():
        s = line.strip()
        if depth == 0 and s.startswith("handle") and s.endswith("{"):
            head, cur, depth = s[:-1].strip(), [], 1
            continue
        if depth >= 1:
            depth += s.count("{") - s.count("}")
            if depth == 0:
                out[head] = "\n".join(cur)
                continue
            cur.append(line)
    return out


# ───────────────────────── the text ─────────────────────────

def test_the_app_site_sends_the_api_prefix_straight_to_the_backend_uncompressed_before_the_catch_all() -> None:
    app = _sites(CODE)["{$APP_HOST}"]
    order = [m.group(0).strip() for m in re.finditer(r"(?m)^\s*handle\b.*\{$", app)]
    assert order == ["handle /api/v2/* {", "handle {"], "the API prefix first, the catch-all after it (Caddy runs `handle` blocks in file order, first match wins)"
    blocks = _blocks(app)
    api, rest = blocks["handle /api/v2/*"], blocks["handle"]
    assert re.search(r"(?m)^\s*reverse_proxy backend:8000 \{$", api) and "flush_interval -1" in api, "straight to the backend, every chunk flushed"
    assert "encode" not in api, "a compressor holds an event stream back (the API name has none either)"
    assert "frontend" not in api, "nothing of this prefix goes to the web server"
    assert "encode zstd gzip" in rest and re.search(r"(?m)^\s*reverse_proxy frontend:3000 \{$", rest) and "flush_interval -1" in rest, "pages keep compression and the web server"
    assert "backend" not in rest, "the web server's own routes are not sent to the backend"
    assert not re.search(r"(?m)^\s*encode\b", re.sub(r"(?s)\bhandle\b.*", "", app)), "no `encode` outside the catch-all, where it would cover the API prefix too"


def test_the_api_site_and_the_logs_are_as_they_were() -> None:
    sites = _sites(CODE)
    api = sites["{$API_HOST}, {$REALTIME_HOST}"]
    assert re.search(r"(?m)^\s*reverse_proxy backend:8000 \{$", api) and "flush_interval -1" in api and "encode" not in api and "handle" not in api
    for name in ("{$API_HOST}, {$REALTIME_HOST}", "{$APP_HOST}"):
        assert "output stdout" in sites[name] and "request>uri delete" in sites[name], name
    assert set(sites) == {"<global>", "{$API_HOST}, {$REALTIME_HOST}", "{$APP_HOST}"}


# ───────────────────────── a real Caddy ─────────────────────────

def _caddy() -> str | None:
    found = os.environ.get("SPRINTABLE_TEST_CADDY") or shutil.which("caddy")
    return found if found and os.access(found, os.X_OK) else None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PAGE = ("<html><body>" + "frontend page " * 400 + "</body></html>").encode()
BIG = ("event: message\ndata: " + "x" * 6000 + "\n\n").encode()


class _Backend(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen: list[str] = []

    def log_message(self, *a: object) -> None:
        pass

    def do_GET(self) -> None:
        _Backend.seen.append(self.path)
        if self.path.startswith("/api/v2/agent/stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            chunk = b": ok\n\n"
            self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
            self.wfile.flush()
            time.sleep(0.4)
            # the cut: a reset, not a normal end (no terminating chunk)
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            self.connection.close()
            self.close_connection = True
            return
        body = BIG if self.path.startswith("/api/v2/big") else b"backend"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain" if not self.path.startswith("/api/v2/big") else "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class _Web(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen: list[str] = []

    def log_message(self, *a: object) -> None:
        pass

    def do_GET(self) -> None:
        _Web.seen.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)


@pytest.fixture()
def front(tmp_path: Path):
    caddy = _caddy()
    if caddy is None:
        pytest.skip("no caddy binary (set SPRINTABLE_TEST_CADDY)")
    _Backend.seen, _Web.seen = [], []
    be_port, web_port, app_port, api_port, rt_port, admin = (_free_port() for _ in range(6))
    servers = [ThreadingHTTPServer(("127.0.0.1", be_port), _Backend), ThreadingHTTPServer(("127.0.0.1", web_port), _Web)]
    for s in servers:
        s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start()
    text = CADDYFILE.replace("backend:8000", f"127.0.0.1:{be_port}").replace("frontend:3000", f"127.0.0.1:{web_port}")
    assert "backend:8000" not in text and "frontend:3000" not in text
    text = text.replace("{\n\temail {$ACME_EMAIL}", f"{{\n\tadmin 127.0.0.1:{admin}\n\temail {{$ACME_EMAIL}}", 1)
    assert f"admin 127.0.0.1:{admin}" in text
    cfg = tmp_path / "Caddyfile"
    cfg.write_text(text)
    home = tmp_path / "home"
    home.mkdir()
    env = {
        "PATH": os.environ.get("PATH", ""), "HOME": str(home), "XDG_DATA_HOME": str(home), "XDG_CONFIG_HOME": str(home),
        "APP_HOST": f"http://127.0.0.1:{app_port}", "API_HOST": f"http://127.0.0.1:{api_port}", "REALTIME_HOST": f"http://127.0.0.1:{rt_port}", "ACME_EMAIL": "ops@example.test",
    }
    log = tmp_path / "caddy.err"
    with open(log, "w") as err:
        proc = subprocess.Popen([caddy, "run", "--config", str(cfg), "--adapter", "caddyfile"], env=env, stdout=subprocess.DEVNULL, stderr=err, stdin=subprocess.DEVNULL)
        try:
            for _ in range(150):
                try:
                    socket.create_connection(("127.0.0.1", app_port), timeout=0.2).close()
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                pytest.fail("the front door did not listen: " + log.read_text()[-600:])
            yield app_port, api_port
        finally:
            proc.terminate()
            proc.wait(timeout=10)
            for s in servers:
                s.shutdown()


def test_the_api_prefix_reaches_the_backend_and_the_rest_reaches_the_web_server(front) -> None:
    app_port, api_port = front
    c = http.client.HTTPConnection("127.0.0.1", app_port, timeout=10)
    c.request("GET", "/api/v2/health?x=1")
    r = c.getresponse()
    assert r.status == 200 and r.read() == b"backend"
    c.request("GET", "/api/dashboard")
    r = c.getresponse()
    assert r.status == 200 and r.read() == PAGE
    assert _Backend.seen == ["/api/v2/health?x=1"], _Backend.seen
    assert _Web.seen == ["/api/dashboard"], "a BFF route of the web app (not /api/v2) still goes to the web server"
    c.request("GET", "/api/v2")   # the prefix is `/api/v2/`: the bare path is not an API route (apps/web/src/lib/embedded-api-origin.ts treats it the same way)
    r = c.getresponse()
    r.read()
    assert _Web.seen[-1] == "/api/v2" and "/api/v2" not in _Backend.seen
    c.request("GET", "/API/V2/health")   # Caddy path matching is case-insensitive by default: the web server treats this spelling as the same route, so must we
    r = c.getresponse()
    r.read()
    assert _Backend.seen[-1] == "/API/V2/health"


def test_a_stream_the_backend_cuts_with_a_reset_ends_the_clients_connection(front) -> None:
    """the case the web server's rewrite failed (20 of 20 left open): the client must see the end, not wait for ever"""
    app_port, api_port = front
    c = http.client.HTTPConnection("127.0.0.1", app_port, timeout=8)
    c.request("GET", "/api/v2/agent/stream", headers={"Accept-Encoding": "gzip"})
    r = c.getresponse()
    assert r.status == 200 and r.getheader("Content-Type") == "text/event-stream"
    assert r.getheader("Content-Encoding") is None, "an event stream is not compressed"
    started = time.time()
    try:
        while r.read(4096):
            pass
        ended = "normal end"
    except (http.client.IncompleteRead, ConnectionError, http.client.RemoteDisconnected):
        ended = "cut"
    except TimeoutError:   # socket.timeout: the connection stayed open - the defect
        pytest.fail("the client was left waiting after the backend cut the stream")
    assert ended in ("normal end", "cut")
    assert time.time() - started < 6, "the end comes within seconds of the cut"


def test_the_api_prefix_is_not_compressed_and_a_page_still_is(front) -> None:
    app_port, api_port = front
    c = http.client.HTTPConnection("127.0.0.1", app_port, timeout=10)
    c.request("GET", "/api/v2/big", headers={"Accept-Encoding": "zstd, gzip"})
    r = c.getresponse()
    body = r.read()
    assert r.status == 200 and r.getheader("Content-Encoding") is None and body == BIG
    c.request("GET", "/some-page", headers={"Accept-Encoding": "gzip"})
    r = c.getresponse()
    body = r.read()
    assert r.status == 200 and r.getheader("Content-Encoding") == "gzip" and gzip.decompress(body) == PAGE, "the catch-all keeps its compression"
