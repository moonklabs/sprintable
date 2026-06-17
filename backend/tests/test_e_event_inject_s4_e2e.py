"""E-EVENT-INJECT S4: end-to-end verification of the dispatch/assignment → gateway Event →
connector allow-list → agent work-turn flow, and proof that FYI events do NOT inject.

S1 (dispatch content hoisting), S2 (SSE stream/backfill), S3 (assignment wake) and the connector
allow-list are each unit-tested in their own files. S4 ties the layers together:

- Dispatch path (POST /api/v2/dispatch): agent recipient → `dispatched` gateway Event carrying
  top-level content + per-recipient seq + wake_agent; human recipient → legacy dispatch_notification,
  no gateway wake. (S3 covered the *assignment* path; this covers the *dispatch* path.)
- Contract: the event_types the gateway emits for work (`dispatched`, `story_assigned`,
  conversation message + mention) ARE in the connector's INJECTABLE_EVENT_TYPES, and FYI event
  types (`status_changed`, `task_completed`, `agent_joined`, `sprint_closed`) are NOT — so a
  contentful FYI event cannot poison an agent's turn.
"""
import os
import sys
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
ENTITY_ID = uuid.uuid4()
ASSIGNEE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── connector allow-list (single source of truth) ──────────────────────────────
# The connector SDK lives at <repo>/connectors/sdk; import it the same way the hermes
# adapter does so the E2E asserts against the *real* allow-list, not a copy.
_SDK_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, "connectors", "sdk")
)
if _SDK_DIR not in sys.path:
    sys.path.insert(0, _SDK_DIR)
from sprintable_sse import INJECTABLE_EVENT_TYPES  # noqa: E402


async def _run_dispatch(member_type: str):
    """POST /api/v2/dispatch for an agent/human assignee; return (resp, wake_mock, dispatch_mock, added)."""
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "project_id": str(PROJECT_ID)}}

    session = AsyncMock()
    added = []
    session.add = MagicMock(side_effect=added.append)
    result = MagicMock()
    result.scalar_one_or_none.return_value = None  # sender lookups → none (fine)
    session.execute = AsyncMock(return_value=result)
    session.commit = AsyncMock()
    session.flush = AsyncMock()

    async def _seq(db, ev):
        ev.recipient_seq = 42  # simulate per-recipient dense seq

    assignee_member = MagicMock()
    assignee_member.type = member_type

    async def override_db():
        yield session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    try:
        with patch(
            "app.services.agent_dispatch._fetch_entity",
            new_callable=AsyncMock,
            return_value=(ASSIGNEE_ID, "Build login", "OAuth + password", PROJECT_ID),
        ), patch(
            "app.services.agent_dispatch.resolve_member_identity",
            new_callable=AsyncMock,
            return_value=assignee_member,
        ), patch(
            "app.services.agent_dispatch.assign_recipient_seq", side_effect=_seq
        ), patch(
            "app.services.agent_dispatch.wake_agent"
        ) as mock_wake, patch(
            "app.services.agent_dispatch.dispatch_notification", new_callable=AsyncMock
        ) as mock_dispatch:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                resp = await c.post(
                    "/api/v2/dispatch",
                    json={
                        "entity_type": "story",
                        "entity_id": str(ENTITY_ID),
                        "project_id": str(PROJECT_ID),
                        "message": "please pick this up",
                    },
                )
            return resp, mock_wake, mock_dispatch, added
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dispatch_agent_emits_dispatched_event_with_content_seq_and_wakes():
    resp, mock_wake, mock_dispatch, added = await _run_dispatch("agent")
    assert resp.status_code == 200
    body = resp.json()
    assert body["dispatched"] is True
    assert body["assignee_type"] == "agent"

    events = [e for e in added if getattr(e, "event_type", None) == "dispatched"]
    assert len(events) == 1
    ev = events[0]
    assert ev.recipient_type == "agent"
    # top-level content present (connector drops contentless events)
    assert ev.payload["content"].startswith("[story] Build login")
    assert ev.payload["content"].endswith("please pick this up")
    assert ev.recipient_seq == 42  # per-recipient dense seq assigned for agent
    mock_wake.assert_called_once()
    mock_dispatch.assert_not_called()  # agent path does not double-deliver via notification


@pytest.mark.anyio
async def test_dispatch_human_uses_notification_no_wake():
    resp, mock_wake, mock_dispatch, added = await _run_dispatch("human")
    assert resp.status_code == 200
    events = [e for e in added if getattr(e, "event_type", None) == "dispatched"]
    assert len(events) == 1
    ev = events[0]
    assert ev.recipient_type == "human"
    assert ev.recipient_seq is None  # no gateway seq for human recipients
    mock_wake.assert_not_called()
    mock_dispatch.assert_called_once()


# ── contract: gateway-emitted work events inject; FYI events do not ─────────────

def test_work_event_types_are_injectable():
    """The event types the gateway emits to start a work-turn must be in the allow-list."""
    for t in (
        "dispatched",
        "story_assigned",
        "conversation.message_created",
        "conversation:mention",
    ):
        assert t in INJECTABLE_EVENT_TYPES, f"{t} must be injectable"


def test_fyi_event_types_are_not_injectable():
    """FYI / informational events must NOT inject — prevents non-poisoning trigger leakage."""
    for t in ("status_changed", "task_completed", "agent_joined", "sprint_closed", "file_conflict"):
        assert t not in INJECTABLE_EVENT_TYPES, f"{t} must NOT be injectable (FYI poisoning)"
