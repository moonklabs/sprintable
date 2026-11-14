"""story 4947 - the front door holds a request and tries the upstream again while a deploy replaces `backend` / `frontend`, instead of answering 502.

The incident (dev, 2026-11-14, deploy-81): a deploy replaces the two containers and for about 25 s (15:29:22 -> 15:29:46Z, the new container started 15:29:31Z) the names do not answer: Caddy answered 502 491 times and
Cloudflare put its error page in front of the person. Caddy's `lb_try_duration` / `lb_try_interval` make it try a refused or unreachable upstream again for that long before it gives up; only a request that could not be SENT is
tried again (nothing of it reached the app), so a POST is as safe as a GET.

Pinned here:
  - the Caddyfile text: EVERY `reverse_proxy` of the file (the API name, the app name's `/api/v2/*`, its catch-all) carries `lb_try_duration` (more than twice the measured gap, under Cloudflare's 100 s proxy limit) and a short
    `lb_try_interval`, and keeps its `flush_interval -1`;
  - with a real Caddy (`SPRINTABLE_TEST_CADDY`, or `caddy` on the PATH; skipped without one, as in test_4843 - the CI image has none, the text pins run there): the REAL Caddyfile with the service names pointed at ports that
    do not answer yet; a request sent now is answered 200 once the upstream starts a few seconds later (not 502) on all three roads; a POST (body up to the 1 MiB buffer) reaches the upstream exactly once with its body, a bigger one still streams whole through a live upstream; with no upstream at all the answer is a 502
    only after the hold time (shortened to 2 s in a copy for the test); a live upstream is answered at once (no added wait).
"""
from __future__ import annotations

import http.client
import os
import re
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
CADDYFILE = (_ROOT / "deploy/vm/Caddyfile").read_text()
CODE = re.sub(r"(?m)^\s*#.*$", "", CADDYFILE)   # the settings only: the comments talk about them too

MEASURED_GAP_S = 25   # dev 11-14 deploy-81: 15:29:22 -> 15:29:46Z
CLOUDFLARE_PROXY_LIMIT_S = 100


def _reverse_proxy_blocks(text: str) -> list[str]:
    """every `reverse_proxy <upstream> { ... }` block of the text, as written (opening line to its closing brace)"""
    out, cur, depth = [], None, 0
    for line in text.splitlines():
        s = line.strip()
        if cur is None and s.startswith("reverse_proxy ") and s.endswith("{"):
            cur, depth = [s], 1
            continue
        if cur is not None:
            depth += s.count("{") - s.count("}")
            cur.append(s)
            if depth == 0:
                out.append("\n".join(cur))
                cur = None
    return out


def _seconds(value: str) -> float:
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m)", value)
    assert m, f"not a Caddy duration: {value!r}"
    n, unit = float(m.group(1)), m.group(2)
    return n / 1000 if unit == "ms" else n * 60 if unit == "m" else n


# ───────────────────────── the text ─────────────────────────

def test_the_file_has_three_reverse_proxies_and_each_one_retries_an_upstream_that_is_not_there_yet() -> None:
    blocks = _reverse_proxy_blocks(CODE)
    assert [b.splitlines()[0] for b in blocks] == ["reverse_proxy backend:8000 {", "reverse_proxy backend:8000 {", "reverse_proxy frontend:3000 {"], (
        "the API name, the app name's /api/v2/*, the app name's catch-all - in file order; a fourth proxy or a missing one needs this test read again")
    for b in blocks:
        head = b.splitlines()[0]
        m_dur = re.search(r"(?m)^lb_try_duration (\S+)$", b)
        m_int = re.search(r"(?m)^lb_try_interval (\S+)$", b)
        assert m_dur, f"{head}: no lb_try_duration - a deploy gap would be answered with a 502"
        assert m_int, f"{head}: no lb_try_interval"
        hold = _seconds(m_dur.group(1))
        assert hold >= 2 * MEASURED_GAP_S, f"{head}: holds {hold:g} s - the measured gap is {MEASURED_GAP_S} s, the hold must be more than twice that"
        assert hold < CLOUDFLARE_PROXY_LIMIT_S, f"{head}: holds {hold:g} s - Cloudflare's proxy gives up at {CLOUDFLARE_PROXY_LIMIT_S} s and would show its own page"
        assert _seconds(m_int.group(1)) <= 1.0, f"{head}: tries again only every {m_int.group(1)} - a request would wait out a second for nothing"
        m_buf = re.search(r"(?m)^request_buffers (\d+)(KiB|MiB)$", b)
        assert m_buf, f"{head}: no request_buffers - a request with a body is tried again with an EMPTY body (Caddy closes it after the first failed dial)"
        assert int(m_buf.group(1)) * (1024 if m_buf.group(2) == "KiB" else 1024 * 1024) >= 1024 * 1024, f"{head}: request_buffers {m_buf.group(0)} - ordinary API bodies are well under 1 MiB"
        assert "flush_interval -1" in b, f"{head}: an event stream must still be flushed as it comes"


def test_the_retry_lines_do_not_name_a_host_or_a_path_so_the_production_vm_reads_the_same_file_as_it_is() -> None:
    for b in _reverse_proxy_blocks(CODE):
        retry = [ln for ln in b.splitlines() if ln.startswith(("lb_try_", "request_buffers"))]
        assert len(retry) == 3 and all(re.fullmatch(r"(lb_try_(duration|interval) \d+(ms|s|m)|request_buffers \d+(KiB|MiB))", ln) for ln in retry), retry
    assert "encode" not in re.search(r"handle /api/v2/\* \{.*?\n\t\}", CODE, re.S).group(0), "the API prefix is still not compressed"


# ───────────────────────── a real Caddy ─────────────────────────

def _caddy() -> str | None:
    found = os.environ.get("SPRINTABLE_TEST_CADDY") or shutil.which("caddy")
    return found if found and os.access(found, os.X_OK) else None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    log: list[tuple[str, str, bytes]] = []

    def log_message(self, *a: object) -> None:
        pass

    def _answer(self, method: str) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        _Upstream.log.append((method, self.path, body))
        out = f"{self.server.name} {method} {self.path}".encode()  # type: ignore[attr-defined]
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self) -> None:
        self._answer("GET")

    def do_POST(self) -> None:
        self._answer("POST")


def _serve(port: int, name: str) -> ThreadingHTTPServer:
    s = ThreadingHTTPServer(("127.0.0.1", port), _Upstream)
    s.name = name  # type: ignore[attr-defined]
    s.daemon_threads = True
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


class _Front:
    """the real Caddyfile, running, its two service names pointed at two local ports that nobody listens on yet; `start_upstreams()` is the new container coming up"""

    def __init__(self, tmp_path: Path, hold: str | None = None) -> None:
        caddy = _caddy()
        if caddy is None:
            pytest.skip("no caddy binary (set SPRINTABLE_TEST_CADDY)")
        _Upstream.log = []
        self.be_port, self.web_port, self.app_port, self.api_port, rt_port, admin = (_free_port() for _ in range(6))
        self.servers: list[ThreadingHTTPServer] = []
        text = CADDYFILE.replace("backend:8000", f"127.0.0.1:{self.be_port}").replace("frontend:3000", f"127.0.0.1:{self.web_port}")
        if hold is not None:
            text, n = re.subn(r"(?m)^(\s*)lb_try_duration \S+$", rf"\1lb_try_duration {hold}", text)
            assert n == 3
        text = text.replace("{\n\temail {$ACME_EMAIL}", f"{{\n\tadmin 127.0.0.1:{admin}\n\temail {{$ACME_EMAIL}}", 1)
        assert f"admin 127.0.0.1:{admin}" in text
        cfg = tmp_path / "Caddyfile"
        cfg.write_text(text)
        home = tmp_path / "home"
        home.mkdir()
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home), "XDG_DATA_HOME": str(home), "XDG_CONFIG_HOME": str(home),
               "APP_HOST": f"http://127.0.0.1:{self.app_port}", "API_HOST": f"http://127.0.0.1:{self.api_port}", "REALTIME_HOST": f"http://127.0.0.1:{rt_port}", "ACME_EMAIL": "ops@example.test"}
        self.log_file = tmp_path / "caddy.err"
        self._err = open(self.log_file, "w")
        self.proc = subprocess.Popen([caddy, "run", "--config", str(cfg), "--adapter", "caddyfile"], env=env, stdout=subprocess.DEVNULL, stderr=self._err, stdin=subprocess.DEVNULL)
        for _ in range(150):
            try:
                socket.create_connection(("127.0.0.1", self.app_port), timeout=0.2).close()
                return
            except OSError:
                time.sleep(0.1)
        pytest.fail("the front door did not listen: " + self.log_file.read_text()[-600:])

    def start_upstreams(self) -> None:
        self.servers = [_serve(self.be_port, "backend"), _serve(self.web_port, "frontend")]

    def close(self) -> None:
        self.proc.terminate()
        self.proc.wait(timeout=10)
        self._err.close()
        for s in self.servers:
            s.shutdown()

    def request(self, port: int, method: str, path: str, body: bytes | None = None, timeout: float = 30.0) -> tuple[int, bytes, float]:
        t0 = time.monotonic()
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        try:
            c.request(method, path, body=body, headers={"Content-Type": "text/plain"} if body is not None else {})
            r = c.getresponse()
            return r.status, r.read(), time.monotonic() - t0
        finally:
            c.close()


@pytest.fixture()
def front(tmp_path: Path):
    f = _Front(tmp_path)
    try:
        yield f
    finally:
        f.close()


@pytest.fixture()
def front_short_hold(tmp_path: Path):
    f = _Front(tmp_path, hold="2s")
    try:
        yield f
    finally:
        f.close()


def _during_the_gap(front: _Front, port: int, method: str, path: str, body: bytes | None = None, comes_up_after: float = 3.0) -> tuple[int, bytes, float]:
    """send the request now, with nothing listening; the upstreams start `comes_up_after` seconds later"""
    res: list[tuple[int, bytes, float]] = []
    th = threading.Thread(target=lambda: res.append(front.request(port, method, path, body)))
    th.start()
    time.sleep(comes_up_after)
    front.start_upstreams()
    th.join(timeout=30)
    assert res, "the request never came back"
    return res[0]


@pytest.mark.parametrize("which, method, path, expect", [
    ("app", "GET", "/", b"frontend GET /"),                       # the app name's catch-all -> the web server
    ("app", "GET", "/api/v2/health", b"backend GET /api/v2/health"),   # the app name's API prefix -> the backend, straight
    ("api", "GET", "/api/v2/health", b"backend GET /api/v2/health"),   # the API name -> the backend
])
def test_a_request_sent_while_the_upstream_is_down_is_answered_when_it_comes_up_not_with_a_502(front: _Front, which: str, method: str, path: str, expect: bytes) -> None:
    port = front.app_port if which == "app" else front.api_port
    status, body, took = _during_the_gap(front, port, method, path)
    assert (status, body) == (200, expect), f"the deploy gap showed through: {status} {body[:80]!r} after {took:.1f}s"
    assert 2.5 <= took < 15, f"held for {took:.1f}s - the upstream started after 3 s"


@pytest.mark.parametrize("which, path, expect", [
    ("api", "/api/v2/things", b"backend POST /api/v2/things"),
    ("app", "/api/v2/things", b"backend POST /api/v2/things"),
    ("app", "/auth/form", b"frontend POST /auth/form"),
])
def test_a_post_sent_during_the_gap_reaches_the_upstream_exactly_once_with_its_body(front: _Front, which: str, path: str, expect: bytes) -> None:
    status, body, _ = _during_the_gap(front, front.api_port if which == "api" else front.app_port, "POST", path, b'{"name":"x"}')
    assert (status, body) == (200, expect)
    assert [(m, p, b) for (m, p, b) in _Upstream.log if m == "POST"] == [("POST", path, b'{"name":"x"}')], "a request that could not be sent is tried again once it can - never twice, never without its body"


def test_a_post_body_bigger_than_the_buffer_still_streams_through_whole_when_the_upstream_is_up(front: _Front) -> None:
    front.start_upstreams()
    status, _, _ = front.request(front.api_port, "POST", "/api/v2/upload", b"x" * 5_000_000)
    assert status == 200 and [(m, len(b)) for (m, _p, b) in _Upstream.log] == [("POST", 5_000_000)]


def test_a_live_upstream_is_answered_at_once_no_hold_is_added(front: _Front) -> None:
    front.start_upstreams()
    for port, path in ((front.app_port, "/"), (front.app_port, "/api/v2/h"), (front.api_port, "/api/v2/h")):
        status, _, took = front.request(port, "GET", path)
        assert status == 200 and took < 1.0, (path, status, took)


def test_with_no_upstream_at_all_the_answer_is_a_502_only_after_the_hold_time(front_short_hold: _Front) -> None:
    f = front_short_hold
    status, _, took = f.request(f.app_port, "GET", "/api/v2/health")
    assert status == 502, status
    assert 1.8 <= took < 8, f"the hold time of the copy is 2 s; the 502 came after {took:.1f}s"
