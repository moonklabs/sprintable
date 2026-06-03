"""E-MEMBER-SSOT AC3-1b: 신규 agent anchor write-sync + agent_api_keys.member_id FK 재추가.

실데이터 기능(write-sync가 members/profile 생성·FK 충족)은 test_member_ssot_parity_realdb.py(실 PG)에서.
여기선 항상 도는 구조회귀 + 헬퍼 no-op 가드.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


def test_apikey_member_id_has_members_fk():
    """AC3(0080): agent_api_keys.member_id → members FK 재추가(QA H1 해소). write-sync로 referent 선행."""
    from app.models.api_key import ApiKey

    referred = {fk.column.table.name for fk in ApiKey.__table__.c.member_id.foreign_keys}
    assert "members" in referred, "agent_api_keys.member_id의 members FK가 없음(0080 재추가 누락)"


@pytest.mark.anyio
async def test_sync_agent_anchor_noop_for_non_agent():
    """type != 'agent'면 write-sync는 no-op(어떤 INSERT/flush도 안 함)."""
    from app.services.agent_anchor_sync import sync_agent_anchor_on_create

    session = AsyncMock()
    session.execute = AsyncMock()
    session.flush = AsyncMock()
    tm = MagicMock()
    tm.type = "human"
    await sync_agent_anchor_on_create(session, tm, created_by=uuid.uuid4())
    session.execute.assert_not_called()
    session.flush.assert_not_called()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
