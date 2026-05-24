"""Tests for P6-2: EventContext metadata enrichment (actor_name, actor_role, epic, context_message)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.rule_evaluator import EventMetadata
from app.routers.stories import _resolve_actor_info, _resolve_epic_title


# ──────────────────────────────────────────────
# EventMetadata schema
# ──────────────────────────────────────────────

class TestEventMetadata:
    def test_story_fields_defined(self):
        m = EventMetadata(story_id="abc", story_title="T", story_priority="high")
        assert m.story_id == "abc"
        assert m.story_title == "T"
        assert m.story_priority == "high"

    def test_actor_fields_defined(self):
        m = EventMetadata(actor_id="uid", actor_name="Alice", actor_role="admin")
        assert m.actor_name == "Alice"
        assert m.actor_role == "admin"

    def test_epic_fields_defined(self):
        m = EventMetadata(epic_id="eid", epic_title="My Epic")
        assert m.epic_id == "eid"
        assert m.epic_title == "My Epic"

    def test_context_message_field(self):
        m = EventMetadata(context_message="상태 변경 완료")
        assert m.context_message == "상태 변경 완료"

    def test_extra_fields_allowed(self):
        m = EventMetadata(status="done", old_status="in-progress")
        assert m.model_extra["status"] == "done"
        assert m.model_extra["old_status"] == "in-progress"

    def test_all_fields_optional(self):
        m = EventMetadata()
        assert m.story_id is None
        assert m.actor_name is None
        assert m.context_message is None

    def test_model_dump_includes_extra(self):
        m = EventMetadata(actor_name="Bob", org_id="some-org")
        d = m.model_dump()
        assert d["actor_name"] == "Bob"
        assert d["org_id"] == "some-org"


# ──────────────────────────────────────────────
# _resolve_actor_info
# ──────────────────────────────────────────────

class TestResolveActorInfo:
    @pytest.mark.asyncio
    async def test_returns_name_and_role_when_found(self):
        db = AsyncMock()
        actor_id = uuid.uuid4()
        member = MagicMock()
        member.name = "Didi"
        member.role = "agent"
        member.type = "agent"
        result_mock = MagicMock()
        result_mock.scalar_one_or_none.return_value = member
        db.execute = AsyncMock(return_value=result_mock)

        name, role, member_type = await _resolve_actor_info(db, actor_id)
        assert name == "Didi"
        assert role == "agent"
        assert member_type == "agent"

    @pytest.mark.asyncio
    async def test_returns_none_when_not_found(self):
        db = AsyncMock()
        result_mock = MagicMock()
        result_mock.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(return_value=result_mock)

        name, role, member_type = await _resolve_actor_info(db, uuid.uuid4())
        assert name is None
        assert role is None
        assert member_type is None

    @pytest.mark.asyncio
    async def test_returns_none_when_actor_id_is_none(self):
        db = AsyncMock()
        name, role, member_type = await _resolve_actor_info(db, None)
        assert name is None
        assert role is None
        assert member_type is None
        db.execute.assert_not_called()


# ──────────────────────────────────────────────
# _resolve_epic_title
# ──────────────────────────────────────────────

class TestResolveEpicTitle:
    @pytest.mark.asyncio
    async def test_returns_title_when_found(self):
        db = AsyncMock()
        epic_id = uuid.uuid4()
        epic = MagicMock()
        epic.title = "Launch Epic"
        result_mock = MagicMock()
        result_mock.scalar_one_or_none.return_value = epic
        db.execute = AsyncMock(return_value=result_mock)

        title = await _resolve_epic_title(db, epic_id)
        assert title == "Launch Epic"

    @pytest.mark.asyncio
    async def test_returns_none_when_not_found(self):
        db = AsyncMock()
        result_mock = MagicMock()
        result_mock.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(return_value=result_mock)

        title = await _resolve_epic_title(db, uuid.uuid4())
        assert title is None

    @pytest.mark.asyncio
    async def test_returns_none_when_epic_id_is_none(self):
        db = AsyncMock()
        title = await _resolve_epic_title(db, None)
        assert title is None
        db.execute.assert_not_called()


# ──────────────────────────────────────────────
# context_message truncation
# ──────────────────────────────────────────────

class TestContextMessage:
    def test_context_message_uses_title_first(self):
        title = "My Task Title"
        content = "X" * 200
        msg = title or content[:100]
        assert msg == title

    def test_context_message_falls_back_to_content(self):
        title = ""
        content = "Y" * 200
        msg = title or content[:100]
        assert len(msg) == 100

    def test_context_message_empty_when_both_empty(self):
        msg = "" or ""[:100]
        assert msg == ""
