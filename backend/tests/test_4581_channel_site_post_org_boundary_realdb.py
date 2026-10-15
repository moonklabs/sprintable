"""story #4581 AC2 (real HTTP · migrated PG) — the backend routes the new hosted MCP channel · site post tools call refuse another
organization's path. The tools always build the path from the key's organization (client.org_id — an org_id argument is refused,
test_4581_mcp_channel_site_post_tools.py); this is the second layer: a caller of org A naming org B in the path is refused by the
routes themselves (each compares the path's org with the verified one). Positive control: the same caller's own org answers."""
from __future__ import annotations

import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    ORG,
    ORG2,
    OWNER,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _quiet_stream_side_effects,
    anyio_backend,
    world,
)

D = uuid.uuid4()  # a draft id that exists nowhere — the org check comes first (measured: 403 on every route)


def _calls(org: uuid.UUID) -> list[tuple[str, str, dict | None]]:
    base = f"/api/v2/organizations/{org}"
    return [
        ("POST", f"{base}/channel-posts/drafts", {"work_item_id": str(uuid.uuid4()), "connection_id": str(uuid.uuid4()), "text": "t"}),
        ("POST", f"{base}/channel-posts/drafts/{D}/submit", {"version_id": None}),
        ("GET", f"{base}/channel-posts/drafts/{D}", None),
        ("GET", f"{base}/channel-connections/agent-visible", None),
        ("POST", f"{base}/channel-posts/drafts/{D}/assets/import-image", {"image_base64": "aGk=", "content_type": "image/png"}),
        ("POST", f"{base}/channel-posts/drafts/{D}/assets/video/upload-url", {"content_type": "video/mp4"}),
        ("POST", f"{base}/channel-posts/drafts/{D}/assets/video/confirm", {"object_path": "o/p.mp4"}),
        ("POST", f"{base}/site-posts/drafts", {"work_item_id": str(uuid.uuid4()), "title": "T", "slug": "t", "lang": "ko", "summary": "S", "body_md": "B"}),
        ("POST", f"{base}/site-posts/drafts/{D}/submit", {"version_id": None}),
        ("GET", f"{base}/site-posts/drafts/{D}/publication", None),
    ]


@pytest.mark.anyio
async def test_every_route_the_tools_call_refuses_another_organizations_path(world):
    async with _client() as c:
        for method, path, body in _calls(ORG2):
            r = await c.request(method, path, json=body, headers=_person(OWNER, ORG))
            # 403 — the route's own org check (it comes before any lookup: a draft id that exists nowhere is still 403, not 404)
            assert r.status_code == 403, (method, path, r.status_code, r.text[:200])
        # positive control: the caller's own organization answers (the drafts list · 200)
        own = await c.get(f"/api/v2/organizations/{ORG}/channel-posts/drafts", headers=_person(OWNER, ORG))
        assert own.status_code == 200, own.text[:200]
