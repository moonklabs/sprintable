"""story 4915 — nothing in the backend reads the socket address (`request.client`) on its own, except the places listed here with a reason.

Behind the front door (Cloud Run's front end · the VM's front container) the socket address is the same for every person, so an audit row written from it says «everyone signed in from one address».
The sign-in / second-factor / provider-link audit rows now take the address from the one shared rule (`client_ip`), unfolded; this file shows that, and fails when a new direct socket read appears.

| place                                              | uses it for                                  | why it stays on the socket |
| app/core/client_ip.py                              | the rule's own last step                      | it IS the rule |
| app/routers/local_auth.py  local_bootstrap (host)  | «is the caller the local machine» decision    | EMBEDDED-ONLY route (registered only when `settings.is_embedded`, re-checked in the handler) — a hosted/VM deployment never serves it; the question is who is connected, and any proxy header already refuses the call |
| app/routers/local_auth.py  local-set-password audit | embedded build's audit row                    | EMBEDDED-ONLY route (same registration + re-check); no front door exists in the embedded build, so the socket address is the person's |
"""
from __future__ import annotations

import ast
import pathlib

import pytest
from starlette.requests import Request

from app.core.client_ip import CLIENT_IP_HEADER, EDGE_KEY_HEADER, audit_client_ip, client_ip

_BACKEND = pathlib.Path(__file__).resolve().parents[1]
_SECRET = "edge-secret-4915-sweep"
# (path relative to backend/, number of `request.client` attribute reads allowed there — `request.client.host if request.client else x` is two reads)
_ALLOWED = {
    "app/core/client_ip.py": 2,      # the rule's last step
    "app/routers/local_auth.py": 4,  # the loopback decision (2) + the embedded set-password audit (2)
}


def _request(headers: dict[str, str], peer: tuple[str, int] | None = ("10.0.0.9", 5555)) -> Request:
    scope = {"type": "http", "method": "POST", "path": "/", "query_string": b"", "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}
    if peer is not None:
        scope["client"] = peer
    return Request(scope)


@pytest.fixture
def secret(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "edge_client_ip_secret", _SECRET)


def test_audit_address_is_the_persons_not_the_front_containers(secret):
    req = _request({CLIENT_IP_HEADER: "203.0.113.7", EDGE_KEY_HEADER: _SECRET}, peer=("172.18.0.5", 40000))
    assert audit_client_ip(req) == "203.0.113.7"          # the socket says 172.18.0.5 (the front container)


def test_audit_address_behind_a_trusted_front_door_is_the_connecting_address(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "trust_forwarded_for", True)
    req = _request({"X-Forwarded-For": "198.51.100.1, 203.0.113.9"}, peer=("172.18.0.5", 40000))
    assert audit_client_ip(req) == "203.0.113.9"


def test_audit_address_is_not_folded_but_the_limit_key_is():
    from app.core.client_ip import fold_ip

    req = _request({}, peer=("2001:db8:1:2:3:4:5:6", 1))
    assert audit_client_ip(req) == "2001:db8:1:2:3:4:5:6"   # an investigation needs the exact address
    assert fold_ip(client_ip(req)) == "2001:db8:1:2::/64"


def test_audit_address_is_none_when_no_rule_found_one():
    assert audit_client_ip(_request({}, peer=None)) is None   # a text column holds NULL, not the word "unknown"


def test_the_sign_in_audit_rows_use_the_shared_rule():
    """the eight rows: login_failure ×2, login_success, 2fa_enabled, unverified_account_reclaimed (via OAuth sign-in), oauth_link_rejected_conflict, oauth_link, oauth_unlink"""
    src = (_BACKEND / "app/routers/auth.py").read_text()
    assert src.count("audit_client_ip(request)") == 8
    assert "request.client" not in src


def _direct_socket_reads(path: pathlib.Path) -> int:
    """the `.client` attributes that read the socket peer: `<request-like name>.client`, ANY `<expr>.client.host` / `.client.port` (an alias such as `peer = request; peer.client.host` does not hide), and `getattr(x, "client")`"""
    tree = ast.parse(path.read_text())
    hits: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr == "client":
            if isinstance(node.value, ast.Name) and node.value.id in {"request", "req", "websocket", "ws", "scope"}:
                hits.add(id(node))
        if isinstance(node, ast.Attribute) and node.attr in {"host", "port"} and isinstance(node.value, ast.Attribute) and node.value.attr == "client":
            hits.add(id(node.value))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "getattr" and len(node.args) >= 2 and isinstance(node.args[1], ast.Constant) and node.args[1].value == "client":
            hits.add(id(node))
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) and node.slice.value == "client":   # scope["client"]
            hits.add(id(node))
    return len(hits)


def test_no_new_direct_socket_read_in_the_backend():
    found: dict[str, int] = {}
    for root in ("app", "ee"):
        base = _BACKEND / root
        if not base.exists():
            continue
        for path in base.rglob("*.py"):
            n = _direct_socket_reads(path)
            if n:
                found[str(path.relative_to(_BACKEND))] = n
    assert found == _ALLOWED, f"direct socket reads changed: found {found}, allowed {_ALLOWED} — use app.core.client_ip (client_ip / audit_client_ip); a place that must stay on the socket goes in the table at the top with a reason"


# ── through the real routes: the audit row carries the person's address, not the socket's ──────────────────────────────────────────────
from unittest.mock import AsyncMock, MagicMock, patch  # noqa: E402

from tests.login_row_mocks import answer_login_rows as _hash_reread  # noqa: E402


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _audit_rows_of_a_sign_in(password: str):
    from app.models.login_audit_log import LoginAuditLog
    from tests.test_auth_11 import _auth_client, _make_user

    client, session, app = await _auth_client()
    try:
        user = _make_user()
        with patch("app.routers.auth._get_user_by_email", new_callable=AsyncMock) as get_user, \
             patch("app.routers.auth._sign_in_session_context", new_callable=AsyncMock) as meta, \
             patch("app.routers.auth._store_refresh_token", new_callable=AsyncMock), \
             patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
            get_user.return_value = user
            meta.return_value = {}
            session.execute = AsyncMock(return_value=MagicMock())
            _hash_reread(session, user)
            async with client as c:
                resp = await c.post(
                    "/api/v2/auth/token",
                    json={"email": "test@example.com", "password": password},
                    headers={CLIENT_IP_HEADER: "203.0.113.7", EDGE_KEY_HEADER: _SECRET},
                )
        rows = [c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], LoginAuditLog)]
        return resp, rows
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_login_success_row_records_the_persons_address(secret):
    resp, rows = await _audit_rows_of_a_sign_in("correct-password")
    assert resp.status_code == 200
    assert [r.event_type for r in rows] == ["login_success"]
    assert rows[0].ip_address == "203.0.113.7"          # not the socket's («127.0.0.1» here · the front container's behind the front door)


@pytest.mark.anyio
async def test_login_failure_row_records_the_persons_address(secret):
    resp, rows = await _audit_rows_of_a_sign_in("wrong-password")
    assert resp.status_code == 401
    assert [r.event_type for r in rows] == ["login_failure"]
    assert rows[0].ip_address == "203.0.113.7"


def test_the_guard_sees_an_aliased_read(tmp_path):
    f = tmp_path / "x.py"
    f.write_text("def f(request):\n    peer = request\n    return peer.client.host\n")
    assert _direct_socket_reads(f) == 1
    g = tmp_path / "y.py"
    g.write_text("def f(request):\n    return getattr(request, 'client', None)\n")
    assert _direct_socket_reads(g) == 1
