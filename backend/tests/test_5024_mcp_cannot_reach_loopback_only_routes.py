"""story 5024 (AC5) — the MCP door of a server host is reachable from other computers (`<public address>/mcp`, through the web's relay and the one TLS front).

The MCP server reaches the backend on ITS loopback port with the agent's own key. A backend route that answers only «a caller on this machine that came straight to the loopback port» (no `X-Forwarded-For` / `Forwarded` / `X-Real-IP`: `auth/local-bootstrap`,
`auth/local-set-password`, `server-setup/state`) would therefore be reachable by a stranger WITH a key if an MCP tool ever called it: from the backend's side the MCP server looks like a local caller. Nothing does — and this pin keeps it so:
no source of `sprintable_mcp` names any route of the loopback-only routers. (The client also refuses a path whose segment is empty · `.` · `..` or decodes to a separator — `UnsafeRequestPath` — so a tool cannot be steered onto one by an argument.)

A static pin: no database, no network. It reads the route paths from the routers themselves (so a new loopback-only route is covered by adding it to those routers), and the MCP package's sources as text.
"""
from __future__ import annotations

from pathlib import Path

from app.routers import local_auth, server_setup

MCP_DIR = Path(__file__).resolve().parents[1] / "sprintable_mcp"


def _loopback_only_paths() -> set[str]:
    paths: set[str] = set()
    for module in (local_auth, server_setup):
        for route in module.router.routes:
            path = getattr(route, "path", "")
            if path.startswith("/api/v2/"):
                paths.add(path)
    return paths


def _mcp_sources() -> dict[str, str]:
    return {str(p.relative_to(MCP_DIR)): p.read_text(encoding="utf-8", errors="replace") for p in sorted(MCP_DIR.rglob("*.py"))}


def test_the_pin_sees_the_loopback_only_routes_and_the_mcp_sources():
    paths = _loopback_only_paths()
    assert {"/api/v2/auth/local-bootstrap", "/api/v2/auth/local-set-password", "/api/v2/server-setup/state"} <= paths, paths
    assert len(_mcp_sources()) > 10  # the package is there and was read, so «nothing found» below means something


def test_no_mcp_source_names_a_route_only_a_local_caller_may_use():
    bad: list[str] = []
    for path in sorted(_loopback_only_paths()):
        # the whole path, and its last two segments (a tool that builds `f"/api/v2/{group}/{name}"` from pieces would still have to spell them)
        needles = {path, "/".join(path.split("/")[-2:])}
        for name, text in _mcp_sources().items():
            for needle in needles:
                if needle in text:
                    bad.append(f"{name}: names «{needle}» (route {path})")
    assert not bad, "an MCP source names a route that answers only a caller on this machine — the MCP door is reachable from other computers:\n" + "\n".join(sorted(set(bad)))
