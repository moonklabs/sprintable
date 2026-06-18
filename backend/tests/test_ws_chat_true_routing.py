"""2c457a06 ws_chat true-routing: 기존 (agent,caller) DM 이 있으면 그 conversation 의 project 를
재사용(project 필터 없이 조회)·신규 DM 생성 시에만 default_project_id 사용.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _DB:
    def __init__(self, existing):
        self._existing = existing
        self.added: list = []

    async def execute(self, *a, **k):
        r = MagicMock()
        r.scalar_one_or_none.return_value = self._existing
        return r

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        pass

    async def commit(self):
        pass

    async def refresh(self, obj):
        pass


def _factory(db):
    class _F:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *a):
            return False

    return lambda: _F()


@pytest.mark.anyio
async def test_existing_dm_project_reused_not_default():
    """기존 DM 이 있으면 default_project_id 무관하게 그 conversation 을 재사용(project=대화 스코프)."""
    from app.routers import ws_chat

    existing = MagicMock()
    existing.id = uuid.uuid4()
    db = _DB(existing)

    with patch.object(ws_chat, "async_session_factory", _factory(db)):
        conv_id = await ws_chat._get_or_create_conversation(
            uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), default_project_id=uuid.uuid4()
        )

    assert conv_id == existing.id   # 기존 DM 재사용
    assert db.added == []           # 신규 생성 없음(그 conversation 의 project 그대로)


@pytest.mark.anyio
async def test_new_dm_uses_default_project():
    """기존 DM 없으면 신규 생성 — default_project_id 로 스코프."""
    from app.models.conversation import Conversation
    from app.routers import ws_chat

    db = _DB(None)  # 기존 DM 없음
    default_pid = uuid.uuid4()

    # Conversation/ConversationParticipant 는 패치 안 함 — select(Conversation)·select(...conversation_id)
    # 쿼리 구성에 실 엔티티/컬럼 필요(db.execute 는 mock·생성 객체는 db.add 로 captured).
    with patch.object(ws_chat, "async_session_factory", _factory(db)):
        await ws_chat._get_or_create_conversation(
            uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), default_project_id=default_pid
        )

    convs = [o for o in db.added if isinstance(o, Conversation)]
    assert len(convs) == 1                       # 신규 DM 1건 생성
    assert convs[0].project_id == default_pid    # default project 로 스코프
    assert convs[0].type == "dm"
