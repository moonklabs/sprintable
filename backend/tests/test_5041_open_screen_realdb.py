"""story 5041 B6 — the «화면 열기» card: a road a PERSON does on the screen (a channel connection, a generation connector's credential) answers an AGENT with the same 403 as before — now with `open_screen` in the body — and a card
goes to the person: what it is and a button to the screen. Nothing is kept but the screen's key (no stored call · no body · no secret). Real database, the real routes and the app's own handler.
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


def _path(d, screen):
    org = d["org_id"]
    return f"/api/v2/organizations/{org}/channel-connections" if screen == "channel_connections" else f"/api/v2/organizations/{org}/generation-connectors"


async def _as(app, Session, d, who, **kw):
    await _act_as(app, Session, who, d["org_id"], **kw)


@pytest.mark.anyio
@pytest.mark.parametrize("screen", ["channel_connections", "generation_connectors"])
async def test_an_agent_on_a_screen_road_gets_the_403_with_the_screen_and_the_person_gets_a_card(screen):
    from sqlalchemy import select

    from app.main import app
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _as(app, Session, d, d["agent_id"], api_key=True)
        async with _client_for(app) as c:
            r = await c.get(_path(d, screen)) if screen == "channel_connections" else await c.post(_path(d, screen), json={"provider_key": "x", "label": "l", "credentials": "SECRET-VALUE"})
            again = await c.get(_path(d, screen)) if screen == "channel_connections" else await c.post(_path(d, screen), json={"provider_key": "x", "label": "l", "credentials": "SECRET-VALUE"})
        assert r.status_code == 403 and r.json()["error"]["code"] == {"channel_connections": "CHANNEL_CONNECTION_HUMAN_ONLY", "generation_connectors": "GENERATION_CONNECTOR_HUMAN_ONLY"}[screen] and r.json()["error"]["open_screen"] == screen, r.text
        assert again.status_code == 403
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1, "the same call again is the same card, not a pile"
        meta = reqs[0].hitl_metadata
        assert meta["screen"] == {"key": screen} and "snapshot" not in meta and meta["action_key"] == f"screen.{screen}", "nothing is kept but the key"
        assert "SECRET-VALUE" not in str(meta) and "SECRET-VALUE" not in str(reqs[0].title) + str(reqs[0].prompt)
        async with Session() as s:
            cards = (await s.execute(select(ConversationMessage).where(ConversationMessage.msg_metadata["agent_action"]["request_id"].astext == str(reqs[0].id)))).scalars().all()
        assert len(cards) == 1 and cards[0].msg_metadata["card"]["kind"] == "agent_action", "the card is the closed vocabulary's own"
        # the person reads it: no stored call, a screen with its route, nothing to approve
        await _as(app, Session, d, d["admin_user"])
        async with _client_for(app) as c:
            view = (await c.get(f"/api/v2/agent-actions/{reqs[0].id}")).json()
            approve = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
            dismiss = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "reject"})
        assert view["screen"] == {"key": screen, "href": {"channel_connections": "/organization/channels", "generation_connectors": "/organization/generation-connectors"}[screen]}
        assert view["always_allow_available"] is False and view["target"] is None
        assert approve.status_code == 409 and approve.json()["error"]["code"] == "AGENT_ACTION_OPEN_SCREEN_NOT_APPROVABLE"
        assert dismiss.status_code == 200 and dismiss.json()["state"] == "rejected", "closing the card is the one decision it has"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_person_on_the_same_road_is_untouched_and_an_agent_with_no_project_gets_no_card():
    from sqlalchemy import text

    from app.main import app
    from app.models.member import Member

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            lone = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="No Project Agent", is_active=True, owner_member_id=d["admin_om"])
            s.add(lone)
            await s.commit()
        await _as(app, Session, d, d["admin_user"])
        async with _client_for(app) as c:
            ok = await c.get(_path(d, "channel_connections"))
        assert ok.status_code == 200, ok.text
        assert await _requests(Session, d["org_id"]) == [], "a person's call puts no card"
        # an agent that holds no project cannot even be told apart by the road (it is resolved through its grants), so the service is asked directly: no project to file the card under → no card, no row, no error
        from app.services.agent_action import request_open_screen

        class _Req:
            headers: dict = {}

        async with Session() as s:
            got = await request_open_screen(_Req(), s, org_id=d["org_id"], agent=lone, screen_key="channel_connections")
            await s.commit()
            assert got is None
            assert (await s.execute(text("SELECT count(*) FROM agent_hitl_requests WHERE agent_id = :a"), {"a": lone.id})).scalar_one() == 0
        assert await _requests(Session, d["org_id"]) == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
