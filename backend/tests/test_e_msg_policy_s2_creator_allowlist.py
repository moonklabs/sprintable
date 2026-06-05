"""E-MSG-POLICY S2: agent 키 생성 시 creator 자동 allow_list 등록.

ensure_creator_allowlisted: agent의 owner_member_id(creator)를 agent_message_allowlist에 멱등 등록.
"""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_inserts_creator_with_on_conflict():
    from app.services.agent_message_policy import ensure_creator_allowlisted
    agent_id, owner_id, org_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    row = MagicMock(); row.owner_member_id = owner_id; row.org_id = org_id
    select_res = MagicMock(); select_res.first.return_value = row
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[select_res, MagicMock()])

    result = await ensure_creator_allowlisted(session, agent_id)

    assert result is True
    assert session.execute.call_count == 2  # SELECT member + INSERT
    insert_sql = str(session.execute.call_args_list[1].args[0]).lower()
    assert "agent_message_allowlist" in insert_sql
    assert "on conflict" in insert_sql and "do nothing" in insert_sql  # 멱등(중복 방지)


@pytest.mark.anyio
async def test_skips_when_no_owner():
    """owner_member_id None(creator 미상) → insert 안 함(False). is_creator가 enforcement 커버."""
    from app.services.agent_message_policy import ensure_creator_allowlisted
    row = MagicMock(); row.owner_member_id = None; row.org_id = uuid.uuid4()
    select_res = MagicMock(); select_res.first.return_value = row
    session = AsyncMock(); session.execute = AsyncMock(side_effect=[select_res])

    result = await ensure_creator_allowlisted(session, uuid.uuid4())

    assert result is False
    assert session.execute.call_count == 1  # SELECT만, INSERT 없음


@pytest.mark.anyio
async def test_skips_when_agent_not_found():
    from app.services.agent_message_policy import ensure_creator_allowlisted
    select_res = MagicMock(); select_res.first.return_value = None
    session = AsyncMock(); session.execute = AsyncMock(side_effect=[select_res])

    assert await ensure_creator_allowlisted(session, uuid.uuid4()) is False
    assert session.execute.call_count == 1


def test_wired_into_all_agent_key_paths():
    """team_members(agent create) + api_keys(manual create·rotate) 3경로 모두 호출 wiring 확인."""
    import inspect
    import app.routers.team_members as tm
    import app.routers.api_keys as ak
    tm_src = inspect.getsource(tm)
    ak_src = inspect.getsource(ak)
    assert "ensure_creator_allowlisted" in tm_src, "team_members agent-create 미연결"
    # api_keys: 수동 생성 + rotate 2곳
    assert ak_src.count("ensure_creator_allowlisted") >= 2, "api_keys create/rotate 미연결"
