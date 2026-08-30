"""E-MSG-POLICY S3 (BE): 메시징 정책 관리 endpoints — GET/PUT mode + POST/DELETE allowlist."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

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


# story #3231 4라운드(카디르 QA) — org-members roster를 admin 전용 403으로 잠그면서
# 이 파일이 관리하는 allowlist 피커가 후보 0명으로 파손됐다(Member가 만든 에이전트는
# 그 생성자 본인도 org-admin이 아니면 막힘). 이 위 모든 엔드포인트와 동일 게이트
# (assert_agent_owner=생성자 OR org admin/owner)의 전용 후보 엔드포인트를 검증한다.
def _org_member_row(role: str = "member") -> MagicMock:
    row = MagicMock()
    row.id = uuid.uuid4()
    row.org_id = uuid.uuid4()
    row.user_id = uuid.uuid4()
    row.role = role
    row.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    row.deleted_at = None
    row.email = "test@example.com"
    row.name = "Test Member"
    return row


@pytest.mark.anyio
async def test_list_message_policy_candidates_creator_allowed(test_client, mock_session, monkeypatch):
    """생성자(org admin 아님)도 assert_agent_owner를 통과하면 후보를 받는다."""
    _owner(monkeypatch)
    mock_result = MagicMock()
    mock_result.__iter__ = MagicMock(return_value=iter([_org_member_row()]))
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/agents/{uuid.uuid4()}/message-policy/candidates")

    assert resp.status_code == 200
    assert len(resp.json()) == 1


@pytest.mark.anyio
async def test_list_message_policy_candidates_non_owner_403(test_client, mock_session, monkeypatch):
    """생성자도 아니고 org admin/owner도 아니면 403 — 로스터 쿼리까지 도달 안 함(원 결함
    재발 시 감지되도록 session.execute 자체를 감시)."""
    monkeypatch.setattr(
        f"{_P}.assert_agent_owner",
        AsyncMock(side_effect=HTTPException(status_code=403, detail="Not the owner of this agent")),
    )

    async def _unexpected_execute(*args, **kwargs):
        raise AssertionError("assert_agent_owner를 통과해 로스터 쿼리까지 도달함 — 원 결함 재발")
    mock_session.execute = _unexpected_execute

    resp = await test_client.get(f"/api/v2/agents/{uuid.uuid4()}/message-policy/candidates")

    assert resp.status_code == 403
