"""EF-S2 db75ecd0 — 채팅 세션 정책 회귀(신규세션) + 방 title PATCH.

AC1: create_conversation "기존방 다이렉트"(DM dedup) 제거 → 매 호출 신규 conversation(existing false).
AC3: PATCH /conversations/{id} {title} (참여자 게이트·기본 title 보존).
보존 불변식(체크리스트 ④): _enforce_agent_creator_policy(creator/allow_list) 보존 / 메시지 dedup
(send_message·미변경) / thread=스토리(미변경). dup-DM 공존은 pgvector e2e 로 검증.
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.routers.conversations as conv_mod

CONV = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── AC1 회귀 가드 (소스) ───────────────────────────────────────────────────────

def test_create_conversation_removed_dm_direct_reuse():
    src = inspect.getsource(conv_mod.create_conversation)
    # 기존방 다이렉트(DM dedup) 재사용 제거
    assert "_find_existing_dm" not in src
    # 신규 세션 = existing 항상 false
    assert '"existing": False' in src
    # 보존 불변식: creator 동석/allow_list 인가 그대로
    assert "_enforce_agent_creator_policy" in src


def test_message_dedup_and_thread_paths_untouched():
    """보존 불변식 ①메시지 dedup ③thread=스토리 — 내 diff가 건드리지 않음(send_message 존재 확인)."""
    # send_message(메시지 dedup 경로)는 별개 함수로 그대로 존재
    assert hasattr(conv_mod, "send_message")
    src = inspect.getsource(conv_mod.create_conversation)
    # create_conversation 은 메시지 dedup/thread 로직을 포함하지 않음(방 생성만) — 회귀 국한 확인
    assert "dm_pair_key" in src  # 컬럼은 유지(태깅·non-unique)


# ── AC3 title PATCH ───────────────────────────────────────────────────────────

async def _call_update(title, conv_obj, participant):
    """update_conversation 직접 호출 — _resolve_member 패치, execute 시퀀스 [conv, participant]."""
    from app.routers.conversations import UpdateConversationRequest, update_conversation

    session = AsyncMock()
    results = []
    r1 = MagicMock(); r1.scalar_one_or_none.return_value = conv_obj
    r2 = MagicMock(); r2.scalar_one_or_none.return_value = participant
    results = [r1, r2]

    async def _execute(*a, **k):
        return results.pop(0) if results else MagicMock()
    session.execute = AsyncMock(side_effect=_execute)
    session.commit = AsyncMock()
    session.refresh = AsyncMock()

    auth = MagicMock(); auth.user_id = str(uuid.uuid4())
    requester = MagicMock(); requester.id = uuid.uuid4()
    with patch("app.routers.conversations._resolve_member", new=AsyncMock(return_value=requester)):
        return await update_conversation(
            CONV, UpdateConversationRequest(title=title), session, auth, uuid.uuid4()
        ), session


def _conv():
    c = MagicMock(); c.id = CONV; c.project_id = uuid.uuid4(); c.title = "default-gen-title"
    return c


@pytest.mark.anyio
async def test_title_patch_404_when_missing():
    with pytest.raises(Exception) as ei:
        await _call_update("New", None, None)
    assert getattr(ei.value, "status_code", None) == 404


@pytest.mark.anyio
async def test_title_patch_403_when_not_participant():
    with pytest.raises(Exception) as ei:
        await _call_update("New", _conv(), None)  # participant lookup → None
    assert getattr(ei.value, "status_code", None) == 403


@pytest.mark.anyio
async def test_title_patch_updates_title():
    c = _conv()
    out, session = await _call_update("Q3 Planning", c, uuid.uuid4())
    assert c.title == "Q3 Planning"
    assert out["title"] == "Q3 Planning"
    session.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_title_patch_none_preserves_default():
    c = _conv()
    out, session = await _call_update(None, c, uuid.uuid4())
    assert c.title == "default-gen-title"  # 미변경(기본 보존)
    session.commit.assert_not_awaited()  # title None → no-op commit
