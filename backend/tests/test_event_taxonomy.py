"""Tests for event_taxonomy validate_event_context (S4-1)."""
import re
import uuid

import pytest

from app.services.event_taxonomy import EVENT_TAXONOMY, validate_event_context


# ──────────────────────────────────────────────
# EVENT_TAXONOMY schema tests
# ──────────────────────────────────────────────

class TestEventTaxonomy:
    def test_all_expected_event_types_present(self):
        expected = {
            "story.status_changed",
            "story.assignee_changed",
            "manual_trigger",
        }
        assert expected.issubset(set(EVENT_TAXONOMY.keys()))

    def test_validate_unknown_event_type_returns_empty(self):
        errors = validate_event_context("unknown.event", {})
        assert errors == []


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
