"""E-MSG-POLICY S3 (BE): 메시징 정책 관리 endpoints — GET/PUT mode + POST/DELETE allowlist."""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

_P = "app.routers.agent_message_policy"


def _owner(monkeypatch, agent=None):
    # default mock agent carries a valid message_policy_mode — POST/DELETE allowlist responses
    # now echo it (B1 fix), and a bare MagicMock attr would not be a valid mode literal.
    monkeypatch.setattr(
        f"{_P}.assert_agent_owner",
        AsyncMock(return_value=agent or MagicMock(message_policy_mode="creator_only")),
    )


def _allowlist_result(ids):
    res = MagicMock()
    res.scalars.return_value.all.return_value = list(ids)
    return res


@pytest.mark.anyio
async def test_get_message_policy(test_client, mock_session, monkeypatch):
    agent = MagicMock(); agent.message_policy_mode = "list"
    _owner(monkeypatch, agent)
    ids = [uuid.uuid4(), uuid.uuid4()]
    mock_session.execute = AsyncMock(return_value=_allowlist_result(ids))
    resp = await test_client.get(f"/api/v2/agents/{uuid.uuid4()}/message-policy")
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "list"
    assert len(body["allowlist"]) == 2


@pytest.mark.anyio
async def test_put_mode_valid(test_client, mock_session, monkeypatch):
    _owner(monkeypatch)
    mock_session.execute = AsyncMock(return_value=_allowlist_result([]))
    mock_session.commit = AsyncMock()
    resp = await test_client.put(f"/api/v2/agents/{uuid.uuid4()}/message-policy", json={"mode": "org_wide"})
    assert resp.status_code == 200
    assert resp.json()["mode"] == "org_wide"


@pytest.mark.anyio
async def test_put_mode_invalid_422(test_client, monkeypatch):
    _owner(monkeypatch)
    resp = await test_client.put(f"/api/v2/agents/{uuid.uuid4()}/message-policy", json={"mode": "bogus"})
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_add_allowlist_member(test_client, mock_session, monkeypatch):
    member_id = uuid.uuid4()
    _owner(monkeypatch)
    monkeypatch.setattr(f"{_P}.resolve_member_identity", AsyncMock(return_value=MagicMock()))
    mock_session.execute = AsyncMock(return_value=_allowlist_result([member_id]))
    mock_session.commit = AsyncMock()
    resp = await test_client.post(
        f"/api/v2/agents/{uuid.uuid4()}/message-policy/allowlist", json={"member_id": str(member_id)}
    )
    assert resp.status_code == 201
    assert str(member_id) in str(resp.json()["allowlist"])


@pytest.mark.anyio
async def test_add_allowlist_member_not_in_org_404(test_client, mock_session, monkeypatch):
    _owner(monkeypatch)
    monkeypatch.setattr(f"{_P}.resolve_member_identity", AsyncMock(return_value=None))
    resp = await test_client.post(
        f"/api/v2/agents/{uuid.uuid4()}/message-policy/allowlist", json={"member_id": str(uuid.uuid4())}
    )
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_delete_allowlist_member(test_client, mock_session, monkeypatch):
    _owner(monkeypatch)
    mock_session.execute = AsyncMock(return_value=_allowlist_result([]))
    mock_session.commit = AsyncMock()
    resp = await test_client.delete(
        f"/api/v2/agents/{uuid.uuid4()}/message-policy/allowlist/{uuid.uuid4()}"
    )
    assert resp.status_code == 200
    assert resp.json()["allowlist"] == []
