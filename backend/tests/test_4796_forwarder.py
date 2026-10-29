"""story 4796 - deploy/vm/forwarder/: the thin forwarder of the old address, pinned.

The forwarder is the one revision of the prod backend service on Cloud Run after the move: a Caddy that hands every request to the API name, so a client that still calls the old
address reaches the VM without changing anything. These tests pin what makes it safe (it holds nothing, it answers on the port Cloud Run gives, it filters its error log like the
stack's Caddy) and, when a Caddy binary is on the machine, run the real thing against a local upstream: the Host header is rewritten, a stream is flushed as it arrives, and the
error log carries neither the URI nor a header.
"""
from __future__ import annotations

import http.client
import json
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
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_DIR = _ROOT / "deploy/vm/forwarder"
CADDYFILE = (_DIR / "Caddyfile").read_text()
DOCKERFILE = (_DIR / "Dockerfile").read_text()
SETTINGS = re.sub(r"(?m)^\s*#.*$", "", CADDYFILE)   # the settings only: the comments talk about them too


def _caddy() -> str | None:
    found = os.environ.get("SPRINTABLE_TEST_CADDY") or shutil.which("caddy")
    return found if found and os.access(found, os.X_OK) else None


def test_the_image_is_the_pinned_caddy_of_the_stack_plus_one_caddyfile() -> None:
    compose = yaml.safe_load((_ROOT / "deploy/vm/compose.yml").read_text())
    assert re.search(r"(?m)^FROM caddy:2\.8\.4-alpine$", DOCKERFILE), "the pinned Caddy of 4796"
    assert compose["services"]["caddy"]["image"] == "caddy:2.8.4-alpine", "the same one as the stack's"
    assert "COPY Caddyfile /etc/caddy/Caddyfile" in DOCKERFILE
    assert 'CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]' in DOCKERFILE
    assert sorted(p.name for p in _DIR.iterdir()) == ["Caddyfile", "Dockerfile"], "nothing else goes into the image"


def test_it_listens_on_the_port_cloud_run_gives_and_makes_no_certificate_and_no_admin_port() -> None:
    assert re.search(r"(?m)^:\{\$PORT:8080\} \{$", SETTINGS), "Cloud Run says the port in PORT; 8080 is its default"
    assert re.search(r"(?m)^\tauto_https off$", SETTINGS) and re.search(r"(?m)^\tadmin off$", SETTINGS), "Cloud Run ends TLS; nothing to obtain and nothing to listen on for admin"


def test_it_hands_everything_to_the_api_name_with_that_name_as_host_and_flushes_every_chunk() -> None:
    assert "reverse_proxy {$FORWARD_TO:https://api.sprintable.ai} {" in SETTINGS, "the one upstream is the API name"
    assert "header_up Host {upstream_hostport}" in SETTINGS, "without it the VM's front sees the old name as Host and answers no site"
    assert "flush_interval -1" in SETTINGS, "a stream (SSE) must not be held back"
    assert not re.search(r"(?m)^\s*encode\b", SETTINGS), "compressing would hold stream frames back"
    assert len(re.findall(r"(?m)^\s*reverse_proxy\b", SETTINGS)) == 1 and "redir" not in SETTINGS and "rewrite" not in SETTINGS, "it forwards and does nothing else"
    assert re.findall(r"(?m)^\s*respond .*$", SETTINGS) == ['\trespond @looped "forwarding loop" 508'], "the one answer of its own is the refusal of a loop"
    assert "@looped header X-Sprintable-Forwarded *" in SETTINGS and "header_up X-Sprintable-Forwarded 1" in SETTINGS, "a request that comes back with the mark is a loop"
    assert "header_up -X-Serverless-Authorization" in SETTINGS and not re.search(r"header_up -?Authorization\b", SETTINGS), "the identity token header is removed; the application's own Authorization is not touched"


def test_its_error_log_has_the_filter_of_the_stacks_caddy_and_no_access_log() -> None:
    head = SETTINGS.split(":{$PORT:8080}")[0]
    log = head.split("log {", 1)[1]
    assert "output stderr" in log and "format filter {" in log and "wrap json" in log
    for removed in ("request>headers delete", "request>tls delete", "resp_headers delete", "request>uri delete"):
        assert removed in log, removed
    stack = re.sub(r"(?m)^\s*#.*$", "", (_ROOT / "deploy/vm/Caddyfile").read_text()).split("{$API_HOST}")[0]
    for removed in ("request>headers delete", "request>tls delete", "resp_headers delete", "request>uri delete"):
        assert removed in stack, "the stack's Caddyfile carries the same four lines"
    assert not re.search(r"(?m)^\s*log\b", SETTINGS.split(":{$PORT:8080}")[1]), "no access log of its own: Cloud Run's own request log is the record"


def test_it_names_no_database_no_secret_and_no_setting_of_the_application() -> None:
    for word in ("DATABASE", "SECRET", "PASSWORD", "TOKEN", "KEY", "JWT", "REDIS", "cloudsql"):
        assert word not in CADDYFILE + DOCKERFILE, word
    assert sorted(set(re.findall(r"\{\$(\w+)", CADDYFILE))) == ["FORWARD_TO", "PORT"], "the only settings it reads"


# ── the real Caddy, when there is one on the machine ────────────────────────────────────────────────────────────────────────────────────────

class _Upstream(BaseHTTPRequestHandler):
    seen: list[dict] = []

    def log_message(self, *a) -> None:   # silence
        pass

    def do_GET(self) -> None:
        _Upstream.seen.append({"path": self.path, "host": self.headers.get("Host"), "xff": self.headers.get("X-Forwarded-For"), "mark": self.headers.get("X-Sprintable-Forwarded"), "xsa": self.headers.get("X-Serverless-Authorization"), "auth": self.headers.get("Authorization")})
        if self.path.startswith("/stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"data: first\n\n")
            self.wfile.flush()
            time.sleep(2.0)
            self.wfile.write(b"data: second\n\n")
            self.wfile.flush()
            return
        body = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n)
        _Upstream.seen.append({"path": self.path, "host": self.headers.get("Host"), "body": data.decode()})
        self.send_response(201)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def running(tmp_path: Path):
    caddy = _caddy()
    if caddy is None:
        pytest.skip("no caddy binary (set SPRINTABLE_TEST_CADDY)")
    _Upstream.seen = []
    up_port, port = _free_port(), _free_port()
    server = ThreadingHTTPServer(("127.0.0.1", up_port), _Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    home = tmp_path / "home"
    home.mkdir()
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home), "XDG_DATA_HOME": str(home), "XDG_CONFIG_HOME": str(home), "PORT": str(port), "FORWARD_TO": f"http://127.0.0.1:{up_port}"}
    log = tmp_path / "caddy.err"
    with open(log, "w") as err:
        proc = subprocess.Popen([caddy, "run", "--config", str(_DIR / "Caddyfile"), "--adapter", "caddyfile"], env=env, stdout=subprocess.DEVNULL, stderr=err, stdin=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                pytest.fail("the forwarder did not listen")
            yield port, up_port, log
        finally:
            proc.terminate()
            proc.wait(timeout=10)
            server.shutdown()


def test_the_real_caddy_rewrites_the_host_and_passes_path_query_and_body(running) -> None:
    port, up_port, _ = running
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("GET", "/api/v2/health?x=1", headers={"Host": "sprintable-backend-prod-1.asia-northeast3.run.app"})
    r = c.getresponse()
    assert r.status == 200 and json.loads(r.read()) == {"ok": True}
    c.request("POST", "/api/v2/things", body="payload", headers={"Host": "sprintable-backend-prod-1.asia-northeast3.run.app"})
    assert c.getresponse().status == 201
    assert _Upstream.seen[0]["path"] == "/api/v2/health?x=1" and _Upstream.seen[1]["body"] == "payload"
    assert {s["host"] for s in _Upstream.seen} == {f"127.0.0.1:{up_port}"}, "the upstream sees its own name as Host, never the old one"


def test_the_real_caddy_marks_what_it_forwards_and_refuses_what_comes_back_with_the_mark(running) -> None:
    port, up_port, _ = running
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("GET", "/api/v2/health")
    r0 = c.getresponse()
    assert r0.status == 200 and r0.read()
    assert _Upstream.seen[0]["mark"] == "1", "what it forwards carries the mark"
    before = len(_Upstream.seen)
    c.request("GET", "/api/v2/health", headers={"X-Sprintable-Forwarded": "1"})
    r = c.getresponse()
    assert r.status == 508 and b"forwarding loop" in r.read(), "a request that already went through a forwarder is refused"
    assert len(_Upstream.seen) == before, "and is not handed on"


def test_the_real_caddy_does_not_hand_on_the_identity_token_header_but_hands_on_the_callers_own_authorization(running) -> None:
    port, up_port, _ = running
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("GET", "/api/v2/health", headers={"X-Serverless-Authorization": "Bearer id-token-of-the-operator", "Authorization": "Bearer sk_live_agent_key"})
    r = c.getresponse()
    assert r.status == 200 and r.read()
    seen = _Upstream.seen[-1]
    assert seen["xsa"] is None, "the operator's identity token (header of Cloud Run's own check) does not reach the VM"
    assert seen["auth"] == "Bearer sk_live_agent_key", "the agent's own key, in the header the application reads, reaches it unchanged"


def test_the_real_caddy_sends_the_first_frame_of_a_stream_before_the_stream_ends(running) -> None:
    port, _, _ = running
    t0 = time.time()
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("GET", "/stream")
    r = c.getresponse()
    first = r.read(13)   # "data: first\n\n": read() decodes the chunks of the response
    seen_after = time.time() - t0
    assert first == b"data: first\n\n" and seen_after < 1.5, f"the first frame arrived after {seen_after:.2f} s (the stream lasts 2 s)"
    assert b"second" in r.read()


def test_the_real_caddy_error_log_has_neither_the_uri_nor_a_header(tmp_path: Path) -> None:
    # an upstream that is not there: Caddy writes an error for the request
    secret_path = "/api/v2/thing?token=SECRET-IN-THE-QUERY"
    dead = _free_port()
    caddy = _caddy()
    if caddy is None:
        pytest.skip("no caddy binary (set SPRINTABLE_TEST_CADDY)")
    home = tmp_path / "home2"
    home.mkdir()
    port2 = _free_port()
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(home), "XDG_DATA_HOME": str(home), "XDG_CONFIG_HOME": str(home), "PORT": str(port2), "FORWARD_TO": f"http://127.0.0.1:{dead}"}
    err = tmp_path / "dead.err"
    with open(err, "w") as fh:
        proc = subprocess.Popen([caddy, "run", "--config", str(_DIR / "Caddyfile"), "--adapter", "caddyfile"], env=env, stdout=subprocess.DEVNULL, stderr=fh, stdin=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    socket.create_connection(("127.0.0.1", port2), timeout=0.2).close()
                    break
                except OSError:
                    time.sleep(0.1)
            c = http.client.HTTPConnection("127.0.0.1", port2, timeout=10)
            c.request("GET", secret_path, headers={"Authorization": "Bearer SECRET-IN-A-HEADER", "Cookie": "s=SECRET-IN-A-COOKIE"})
            assert c.getresponse().status == 502
            time.sleep(0.5)
        finally:
            proc.terminate()
            proc.wait(timeout=10)
    text = err.read_text()
    assert "dial tcp" in text or "connection refused" in text, "the error was logged at all (otherwise this proves nothing)"
    assert "SECRET" not in text and "/api/v2/thing" not in text, text[-800:]
