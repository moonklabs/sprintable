"""Tests for event_taxonomy + add_reply process_event integration (S4-1)."""
import re
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.event_taxonomy import EVENT_TAXONOMY, validate_event_context
from app.routers.memos import _infer_trigger_type, _resolve_author_role


# ──────────────────────────────────────────────
# EVENT_TAXONOMY schema tests
# ──────────────────────────────────────────────

class TestEventTaxonomy:
    def test_all_expected_event_types_present(self):
        expected = {
            "story.status_changed",
            "story.assignee_changed",
            "memo_created",
            "memo.reply_created",
            "manual_trigger",
        }
        assert expected.issubset(set(EVENT_TAXONOMY.keys()))

    def test_memo_reply_created_required_params(self):
        schema = {p.key: p for p in EVENT_TAXONOMY["memo.reply_created"]}
        assert schema["original_memo_id"].required is True
        assert schema["reply_author_id"].required is True

    def test_memo_reply_created_optional_params(self):
        schema = {p.key: p for p in EVENT_TAXONOMY["memo.reply_created"]}
        for key in ("original_memo_type", "original_title", "reply_author_role",
                    "review_type", "has_pr_link", "content_preview"):
            assert key in schema
            assert schema[key].required is False

    def test_memo_created_schema(self):
        schema = {p.key: p for p in EVENT_TAXONOMY["memo_created"]}
        assert schema["memo_id"].required is True
        assert "assigned_to_id" in schema
        assert "title" in schema

    def test_validate_event_context_missing_required(self):
        errors = validate_event_context("memo.reply_created", {})
        assert "original_memo_id" in errors
        assert "reply_author_id" in errors

    def test_validate_event_context_ok(self):
        errors = validate_event_context("memo.reply_created", {
            "original_memo_id": str(uuid.uuid4()),
            "reply_author_id": str(uuid.uuid4()),
        })
        assert errors == []

    def test_validate_unknown_event_type_returns_empty(self):
        errors = validate_event_context("unknown.event", {})
        assert errors == []


# ──────────────────────────────────────────────
# _infer_trigger_type tests
# ──────────────────────────────────────────────

class TestInferTriggerType:
    def test_approve_returns_review_request(self):
        assert _infer_trigger_type("task", "approve") == "review_request"

    def test_request_changes_returns_review_request(self):
        assert _infer_trigger_type("task", "request_changes") == "review_request"

    def test_qa_returns_qa_request(self):
        assert _infer_trigger_type("task", "qa") == "qa_request"

    def test_comment_returns_reply(self):
        assert _infer_trigger_type("memo", "comment") == "reply"

    def test_none_review_type_returns_reply(self):
        assert _infer_trigger_type("memo", None) == "reply"

    def test_task_memo_type_no_review_returns_reply(self):
        assert _infer_trigger_type("task", None) == "reply"


# ──────────────────────────────────────────────
# _resolve_author_role tests
# ──────────────────────────────────────────────

class TestResolveAuthorRole:
    @pytest.mark.asyncio
    async def test_returns_member_role_when_found(self):
        db = AsyncMock()
        member_id = uuid.uuid4()
        result_mock = MagicMock()
        result_mock.scalar_one_or_none.return_value = "agent"
        db.execute = AsyncMock(return_value=result_mock)

        role = await _resolve_author_role(db, member_id)
        assert role == "agent"

    @pytest.mark.asyncio
    async def test_returns_member_when_not_found(self):
        db = AsyncMock()
        member_id = uuid.uuid4()
        result_mock = MagicMock()
        result_mock.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(return_value=result_mock)

        role = await _resolve_author_role(db, member_id)
        assert role == "member"

    @pytest.mark.asyncio
    async def test_returns_member_when_created_by_is_none(self):
        db = AsyncMock()
        role = await _resolve_author_role(db, None)
        assert role == "member"
        db.execute.assert_not_called()


# ──────────────────────────────────────────────
# has_pr_link regex test
# ──────────────────────────────────────────────

class TestHasPrLink:
    def _detect(self, content: str) -> bool:
        return bool(re.search(r"github\.com/.+/pull/\d+", content))

    def test_detects_github_pr_link(self):
        assert self._detect("PR: https://github.com/org/repo/pull/123 참고") is True

    def test_no_link_returns_false(self):
        assert self._detect("일반 답신 내용") is False

    def test_partial_url_returns_false(self):
        assert self._detect("https://github.com/org/repo/issues/42") is False

    def test_empty_string_returns_false(self):
        assert self._detect("") is False
