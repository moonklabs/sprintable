"""PO 2026-10-07 22:51Z (Minh's catch_test_host · «사람 손 없이»): a backend test never opens a real socket to a made-up host or a cloud
metadata address. In an agent's sandbox each such connection raised a network question a person had to answer, every run (Minh caught
twelve: `http://x` · `http://test` from the MCP client singleton, 169.254.169.254 from google-auth and boto's credential lookups).

Installed once by conftest.py, before any test module is imported. A request to such a host is refused before a socket opens — the
same error a refused connection gives (httpx.ConnectError · ConnectionRefusedError · urllib3 NewConnectionError), so best-effort code
behaves as it did — and recorded with the test that made it; conftest's autouse fixture fails that test, naming the request.

A process is a door too (story 4796): a test never starts the REAL gcloud binary except through tests/_real_gcloud.py. gcloud asks the metadata server whether it runs on Google Compute Engine
(3 s per try, 3 retries) and on a CI runner the address does not answer: every start waited ~12 s and tests hit pytest's 30 s limit. The helper sends that question to a refusing port and puts a marker in the environment; a spawn of
the real gcloud - by name or path, or named as a command inside a shell script - WITHOUT the marker is refused at the spawn (a stand-in `gcloud` that a test put on its own PATH is not the real one and passes).

Made-up = a host with no dot other than localhost (`test` · `x` · `api` …) · `*.test` · `testserver` · `metadata.google.internal`;
an IP only when link-local (169.254.0.0/16 · fe80::/10) or AWS's v6 metadata address. Loopback and real addresses pass. An ASGI or
Mock transport never reaches these doors."""
from __future__ import annotations

import http.client
import ipaddress
import os
import re
import shutil
import socket
import subprocess
from urllib.parse import urlsplit

import httpx

_STOP_NETS = (ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("fe80::/10"), ipaddress.ip_network("fd00:ec2::254/128"))

#: (test id, what) for every request stopped — conftest reads and empties it around each test
CAUGHT: list[tuple[str, str]] = []


def is_made_up(host: str | None) -> bool:
    h = (host or "").strip("[]").lower().split("%")[0]
    if not h or h == "localhost":
        return False
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        ip = None
    if ip is not None:
        return any(ip in n for n in _STOP_NETS)
    return "." not in h or h.endswith(".test") or h == "testserver" or h == "metadata.google.internal"


def _stop(how: str, url: object) -> str:
    CAUGHT.append((os.environ.get("PYTEST_CURRENT_TEST", "?"), f"{how} {url}"))
    return f"tests/_no_real_network: a real connection to a made-up host was refused ({how} {url})"


#: set by tests/_real_gcloud.py in the environment of every gcloud start it makes
GCLOUD_MARKER = "SPRINTABLE_TEST_GCLOUD_ENV"
_STARTUP_PATH = [d for d in os.environ.get("PATH", "").split(os.pathsep) if d]   # where the REAL tools live: the PATH the session began with
_SHELLS = {"bash", "sh", "zsh", "dash"}
_GCLOUD_STAND_IN = re.compile(r"(?:^|[;&|(\n])\s*(?:function\s+)?gcloud\s*(?:\(\s*\))?\s*\{|\balias\s+gcloud=")   # the script defines its own gcloud (a shell function or an alias): what runs is the stand-in
_GCLOUD_AS_COMMAND = re.compile(r"(?:^|[;&|(\n]|\$\()\s*(?:sudo\s+)?(?:\S*/)?gcloud(?:\s|$)")


def real_gcloud_without_marker(args: object, env: object) -> bool:
    """would this spawn start the real gcloud with an environment that did not come from tests/_real_gcloud.py?"""
    environment = env if isinstance(env, dict) else os.environ
    if environment.get(GCLOUD_MARKER) == "1":
        return False
    found = shutil.which("gcloud", path=environment.get("PATH", os.defpath))
    if not found or os.path.dirname(found) not in _STARTUP_PATH:
        return False   # no gcloud at all, or only a stand-in a test put on its own PATH
    argv = [args] if isinstance(args, (str, bytes, os.PathLike)) else list(args or [])
    argv = [os.fsdecode(a) if isinstance(a, (bytes, os.PathLike)) else str(a) for a in argv]
    if not argv:
        return False
    first = os.path.basename(argv[0])
    if first == "gcloud":
        return True
    if first in _SHELLS and "-c" in argv[1:]:
        script = argv[argv.index("-c") + 1] if argv.index("-c") + 1 < len(argv) else ""
        return bool(_GCLOUD_AS_COMMAND.search(script)) and not _GCLOUD_STAND_IN.search(script)
    return False


_installed = False


def install() -> None:
    """`NO_REAL_NETWORK_GUARD=0` leaves the doors as they are — for a measurement with an outside catcher (Minh's catch_test_host
    plugin), which this guard would otherwise refuse ahead of, so it would count nothing."""
    global _installed
    if _installed or os.environ.get("NO_REAL_NETWORK_GUARD") == "0":
        return
    _installed = True

    orig_popen_init = subprocess.Popen.__init__

    def _popen_init(self, args, *a, **kw):
        if real_gcloud_without_marker(args, kw.get("env")):
            what = _stop("subprocess", f"the real gcloud without tests/_real_gcloud.py ({str(args)[:100]})")
            raise FileNotFoundError(what)
        return orig_popen_init(self, args, *a, **kw)

    subprocess.Popen.__init__ = _popen_init

    orig_sync = httpx.HTTPTransport.handle_request
    orig_async = httpx.AsyncHTTPTransport.handle_async_request

    def _sync(self, request):
        if is_made_up(request.url.host):
            raise httpx.ConnectError(_stop(f"httpx {request.method}", request.url), request=request)
        return orig_sync(self, request)

    async def _async(self, request):
        if is_made_up(request.url.host):
            raise httpx.ConnectError(_stop(f"httpx {request.method}", request.url), request=request)
        return await orig_async(self, request)

    httpx.HTTPTransport.handle_request = _sync
    httpx.AsyncHTTPTransport.handle_async_request = _async

    orig_connect = http.client.HTTPConnection.connect
    orig_putrequest = http.client.HTTPConnection.putrequest

    def _connect(self):
        target = getattr(self, "_tunnel_host", None) or self.host  # through a proxy: the tunnel's host is the real target
        if is_made_up(target):
            raise ConnectionRefusedError(_stop("http.client", f"{target}:{self.port}"))
        return orig_connect(self)

    def _putrequest(self, method, url, *a, **kw):
        if isinstance(url, str) and url.startswith(("http://", "https://")) and is_made_up(urlsplit(url).hostname):
            raise ConnectionRefusedError(_stop(f"http.client {method}", url))
        return orig_putrequest(self, method, url, *a, **kw)

    http.client.HTTPConnection.connect = _connect
    http.client.HTTPConnection.putrequest = _putrequest

    orig_sock_connect = socket.socket.connect
    orig_sock_connect_ex = socket.socket.connect_ex

    def _target(address):
        return address[0] if isinstance(address, tuple) and address and isinstance(address[0], str) else None

    def _sock_connect(self, address):
        t = _target(address)
        if t is not None and is_made_up(t):
            raise ConnectionRefusedError(_stop("socket", f"{t}:{address[1]}"))
        return orig_sock_connect(self, address)

    def _sock_connect_ex(self, address):
        t = _target(address)
        if t is not None and is_made_up(t):
            _stop("socket", f"{t}:{address[1]}")
            return 61  # ECONNREFUSED
        return orig_sock_connect_ex(self, address)

    socket.socket.connect = _sock_connect
    socket.socket.connect_ex = _sock_connect_ex

    try:
        import urllib3.connectionpool as cp
        from urllib3.exceptions import NewConnectionError
    except ImportError:
        return
    orig_urlopen = cp.HTTPConnectionPool.urlopen

    def _urlopen(self, method, url, *a, **kw):
        absolute = isinstance(url, str) and url.startswith(("http://", "https://"))
        target = urlsplit(url).hostname if absolute else self.host  # through a proxy: the absolute URL names the real target
        if is_made_up(target) or is_made_up(self.host):
            raise NewConnectionError(self, _stop(f"urllib3 {method}", url if absolute else f"{self.host}{url}"))
        return orig_urlopen(self, method, url, *a, **kw)

    cp.HTTPConnectionPool.urlopen = _urlopen
