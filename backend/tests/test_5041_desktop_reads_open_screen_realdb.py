"""story 5041 (A1, PO 11-28) — the eight READ roads of the desktop setup page (table rows 51–57 · 60) no longer answer an AGENT with a plain 403: the same 403 (`person_session_required`) now carries `open_screen: desktop_setups`
and a CARD with a button to the screen (`/desktop`) is put in front of the person; nothing is kept but the screen's key. A person's session is untouched; a person's own API key is refused as before and puts no card.
Also (B2): `delete_webhook_config` — measured: the road has no agent guard, it deletes the CALLER'S OWN config only (another member's id is a 404), so «바로» is right; pinned here.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed and «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _requests,
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]

_SETUP = uuid.uuid4()
_ROADS = [
    ("GET", "/api/v2/desktop/recipes", None),
    ("GET", "/api/v2/desktop/recipes/for-new-org", None),
    ("GET", f"/api/v2/desktop/setup/agents?project_id={uuid.uuid4()}", None),
    ("GET", "/api/v2/desktop/setups", None),
    ("GET", f"/api/v2/desktop/setups/{_SETUP}", None),
    ("GET", f"/api/v2/desktop/setups/{_SETUP}/hands", None),
    ("GET", "/api/v2/desktop/computers", None),
    ("POST", "/api/v2/desktop/device-token-codes/peek", {"code": "A" * 24}),
]


@pytest.mark.anyio
@pytest.mark.parametrize("method,path,body", _ROADS)
async def test_an_agent_reading_a_desktop_setup_road_gets_the_403_with_the_screen_and_the_person_gets_a_card(method, path, body):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            r = await c.request(method, path, json=body) if body is not None else await c.request(method, path)
            again = await c.request(method, path, json=body) if body is not None else await c.request(method, path)
        assert r.status_code == 403 and r.json()["error"]["code"] == "person_session_required", r.text
        assert "open_screen" in r.text and "desktop_setups" in r.text, f"the 403 says which screen the card opens: {r.text}"
        assert again.status_code == 403
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1, "the same ask again is the same card, never a pile"
        meta = reqs[0].hitl_metadata
        assert meta["screen"] == {"key": "desktop_setups"} and "snapshot" not in meta and meta["action_key"] == "screen.desktop_setups", "nothing is kept but the key"
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            view = (await c.get(f"/api/v2/agent-actions/{reqs[0].id}")).json()
            approve = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert view["screen"] == {"key": "desktop_setups", "href": "/desktop"}
        assert approve.status_code == 409 and approve.json()["error"]["code"] == "AGENT_ACTION_OPEN_SCREEN_NOT_APPROVABLE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_person_reads_the_same_roads_untouched_and_a_personal_key_is_refused_without_a_card():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok = [(await c.get(p)).status_code for p in ("/api/v2/desktop/recipes", "/api/v2/desktop/setups", "/api/v2/desktop/computers")]
        assert ok == [200, 200, 200], ok
        assert await _requests(Session, d["org_id"]) == [], "a person's call puts no card"
        await _act_as(app, Session, d["admin_user"], d["org_id"], human_key=True)
        async with _client_for(app) as c:
            r = await c.get("/api/v2/desktop/computers")
        assert r.status_code == 403 and "open_screen" not in r.text and "desktop_setups" not in r.text, r.text
        assert await _requests(Session, d["org_id"]) == [], "a person's own api key is refused as before: no card"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_deletes_its_own_webhook_config_at_once_and_never_another_members():
    """B2 (measured): `DELETE /api/v2/webhooks/config` has no agent guard — it removes the caller's OWN config; an id of another member's config is a 404 (the owner check), so it stays a «바로» road."""
    from sqlalchemy import text

    from app.main import app
    from app.models.webhook_config import WebhookConfig

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            own, other = uuid.uuid4(), uuid.uuid4()
            s.add_all([
                WebhookConfig(id=own, org_id=d["org_id"], member_id=d["agent_id"], project_id=d["project_id"], url="https://example.test/a", events=["x"]),
                WebhookConfig(id=other, org_id=d["org_id"], member_id=d["admin_om"], project_id=d["project_id"], url="https://example.test/b", events=["x"]),
            ])
            await s.commit()
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            foreign = await c.delete("/api/v2/webhooks/config", params={"id": str(other)})
            mine = await c.delete("/api/v2/webhooks/config", params={"id": str(own)})
        assert foreign.status_code == 404, foreign.text
        assert mine.status_code == 200, mine.text
        async with Session() as s:
            left = {str(r[0]) for r in (await s.execute(text("SELECT id FROM webhook_configs WHERE org_id = :o"), {"o": d["org_id"]})).all()}
        assert left == {str(other)}
        assert await _requests(Session, d["org_id"]) == [], "no card: it is the agent's own"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
