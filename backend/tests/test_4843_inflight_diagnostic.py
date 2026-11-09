"""story 4843 - the in-flight diagnostic (deploy/vm/diagnostics/inflight_paths.js) reports the requests a Node server holds, by method, path and user-agent FAMILY, and prints no header value, no query and no path segment that is not a plain lowercase word.

It was written to find what the web server (next-server) held on the VM: 152-381 `GET /api/v2/agent/stream` with the response head sent and nothing behind them. It is run over ssh against the frontend container
(`kill -USR1 1` opens Node's inspector inside the container; the script asks that inspector which HTTP requests the process holds). Here it runs against a plain Node server on this machine, with requests held open on purpose
(the positive control: the numbers it prints are the numbers that were held). Skipped without Node >= 22 (the script uses the global WebSocket).
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import time
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = _ROOT / "deploy/vm/diagnostics/inflight_paths.js"

SERVER = r"""
const http = require('http');
http.createServer((req, res) => { if (req.url.startsWith('/hang')) return; res.end('ok'); }).listen(+process.argv[1], '127.0.0.1', () => console.log('up'));
"""


def _node() -> str | None:
    node = shutil.which("node")
    if not node:
        return None
    try:
        major = int(subprocess.run([node, "-p", "process.versions.node.split('.')[0]"], capture_output=True, text=True, timeout=10).stdout.strip())
    except (ValueError, subprocess.SubprocessError):
        return None
    return node if major >= 22 else None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _hold(port: int, path: str, headers: dict[str, str]) -> socket.socket:
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    lines = [f"GET {path} HTTP/1.1", f"Host: 127.0.0.1:{port}", *[f"{k}: {v}" for k, v in headers.items()], "", ""]
    s.sendall("\r\n".join(lines).encode())
    return s


@pytest.fixture()
def held():
    node = _node()
    if node is None:
        pytest.skip("no Node >= 22")
    port = _free_port()
    insp = _free_port()   # SIGUSR1 opens the inspector on this port (not on 9229, which another Node on this machine may hold)
    proc = subprocess.Popen([node, f"--inspect-port={insp}", "-e", SERVER, str(port)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    socks: list[socket.socket] = []
    try:
        assert proc.stdout is not None and proc.stdout.readline().strip() == "up"
        electron = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36 Electron/33.0.0"
        for i in range(3):
            socks.append(_hold(port, f"/hang/sess{'x' * i}-a1?token=secret-value-{i}", {"User-Agent": electron, "X-Forwarded-For": "10.0.0.1, 1.1.1.1", "Last-Event-ID": "5"}))
        socks.append(_hold(port, "/hang/0e9f8c3a-1111-2222-3333-444455556666/stream", {"User-Agent": "python-httpx/0.27", "X-Forwarded-For": "10.0.0.2"}))
        socks.append(_hold(port, "/hang/abcdefghijklmnopqrstuvwxyz0123456789", {}))
        socks.append(_hold(port, "/hang/Mixed.Case_Secret", {}))
        socks.append(_hold(port, "/hang/plain-word?token=secret-value", {}))
        time.sleep(0.8)
        proc.send_signal(signal.SIGUSR1)
        time.sleep(1.0)
        yield node, insp
    finally:
        for s in socks:
            s.close()
        proc.terminate()
        proc.wait(timeout=10)


def test_it_counts_the_held_requests_by_path_and_user_agent_family_and_prints_no_raw_value(held) -> None:
    node, insp = held
    out = subprocess.run([node, "-"], input=SCRIPT.read_text(), capture_output=True, text=True, timeout=30, env={**os.environ, "INSPECT_PORT": str(insp)})
    assert out.returncode == 0, out.stdout + out.stderr
    report = json.loads(out.stdout)
    assert report["holdingRequest"] == 7
    assert report["distinctClientAddrs"] == 2, "a count of addresses, not the addresses"
    assert report["withLastEventId"] == 3
    lines = "\n".join(report["top"])
    assert "GET /hang/:x/stream | head not sent | live | ua python" in lines, lines
    assert "GET /hang/:x | head not sent | live | ua none" in lines, "a token, or a name with capitals or punctuation, in a path is replaced"
    assert "3  (last-event-id 3)  GET /hang/:x | head not sent | live | ua electron" in lines, "the three alike are one line with their count"
    assert "2  (last-event-id 0)  GET /hang/:x | head not sent | live | ua none" in lines, lines
    assert "GET /hang/plain-word | head not sent | live | ua none" in lines, "a plain lowercase word is a route name and is printed as it is (said in the script's header); its query is not"
    for raw in ("secret-value", "10.0.0.1", "10.0.0.2", "Mozilla", "httpx", "abcdefghijklmnopqrstuvwxyz", "Mixed", "Secret", "sess", "a1"):
        assert raw not in out.stdout, f"{raw!r} must not be printed"


def test_it_says_so_when_no_inspector_is_open() -> None:
    node = _node()
    if node is None:
        pytest.skip("no Node >= 22")
    out = subprocess.run([node, "-"], input=SCRIPT.read_text(), capture_output=True, text=True, timeout=30, env={**os.environ, "INSPECT_PORT": str(_free_port())})
    assert out.returncode == 1 and "no inspector on" in out.stdout and "kill -USR1 1" in out.stdout
