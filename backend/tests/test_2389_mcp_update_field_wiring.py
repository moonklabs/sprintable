"""story #2389 — update_story/update_doc/update_goal declared fields that the backend already
supports but the MCP schema didn't expose, so they were silently dropped (SprintableInput's
extra="ignore" swallowed them before the handler body ever ran — there was no attribute to read,
not a read-but-ignored bug).

story #2412(merged into develop before this PR was rebased) already closed the "silent" half of
this globally — an undeclared field is now rejected with a clear error, for every MCP tool. What
this story still needs to prove is the other half: for the fields it *did* declare, do they
actually reach the outgoing HTTP payload sent to the backend? Schema declaration alone doesn't
prove that — the field could be declared and then never wired into the handler's `updates` dict
(exactly the kind of one-sided fix this session's stories have repeatedly caught elsewhere).

These tests mock the HTTP client (`client.patch`) and assert on the payload the handler actually
sends — one assertion per newly-declared field, so a regression in any single field's wiring line
fails only that field's test, not the others (verified by deliberately breaking one field's wiring
below and confirming the blast radius — see the module docstring positive-control note at the
bottom of this file, run manually during development, not committed as an automated toggle).
"""
from __future__ import annotations

import sys

import pytest

sys.path.insert(0, ".")

pytestmark = pytest.mark.anyio


class _RecordingPatch:
    """client.patch를 흉내내며 마지막 호출의 path/json을 기록한다."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, path: str, *, json: dict | None = None):
        self.calls.append((path, json or {}))
        return {"id": "irrelevant", **(json or {})}

    @property
    def last_json(self) -> dict:
        return self.calls[-1][1]


STORY_FIELD_CASES = [
    ("assignee_ids", ["m1", "m2"]),
    ("human_owner_member_id", "m3"),
    ("success_hypothesis", "if X then Y"),
    ("metric_definition", {"metric": "conversion", "target": 0.1}),
    ("measure_after", "2026-09-01"),
    ("allow_shrink", True),
]


@pytest.mark.parametrize("field_name,value", STORY_FIELD_CASES)
async def test_update_story_wires_each_new_field_into_patch_payload(monkeypatch, field_name, value):
    from sprintable_mcp.tools import stories

    recorder = _RecordingPatch()
    monkeypatch.setattr(stories.client, "patch", recorder)

    args = stories.UpdateStoryInput(story_id="s1", **{field_name: value})
    await stories.update_story(args)

    assert recorder.last_json.get(field_name) == value, (
        f"{field_name}이 UpdateStoryInput엔 선언돼 있지만 update_story()의 PATCH payload엔 "
        f"실리지 않았다 — 스키마 선언과 handler 배선(if args.{field_name} is not None: ...)이 따로 논다."
    )


async def test_update_story_omits_new_fields_when_not_provided(monkeypatch):
    """미지정 필드는 payload에 아예 안 실려야 한다(None을 명시로 보내 백엔드 필드를 지우는
    사고 방지 — 다른 기존 필드들과 동일한 규약)."""
    from sprintable_mcp.tools import stories

    recorder = _RecordingPatch()
    monkeypatch.setattr(stories.client, "patch", recorder)

    args = stories.UpdateStoryInput(story_id="s1", title="only this")
    await stories.update_story(args)

    for field_name, _ in STORY_FIELD_CASES:
        assert field_name not in recorder.last_json


DOC_FIELD_CASES = [
    ("slug", "new-slug"),
    ("slug_locked", True),
    ("sort_order", 3),
    ("doc_type", "runbook"),
    ("assignee_id", "m1"),
]


@pytest.mark.parametrize("field_name,value", DOC_FIELD_CASES)
async def test_update_doc_wires_each_new_field_into_patch_payload(monkeypatch, field_name, value):
    from sprintable_mcp.tools import docs

    recorder = _RecordingPatch()
    monkeypatch.setattr(docs.client, "patch", recorder)

    args = docs.UpdateDocInput(doc_id="d1", **{field_name: value})
    await docs.update_doc(args)

    assert recorder.last_json.get(field_name) == value, (
        f"{field_name}이 UpdateDocInput엔 선언돼 있지만 update_doc()의 PATCH payload엔 안 실렸다."
    )


async def test_update_doc_omits_new_fields_when_not_provided(monkeypatch):
    from sprintable_mcp.tools import docs

    recorder = _RecordingPatch()
    monkeypatch.setattr(docs.client, "patch", recorder)

    args = docs.UpdateDocInput(doc_id="d1", title="only this")
    await docs.update_doc(args)

    for field_name, _ in DOC_FIELD_CASES:
        assert field_name not in recorder.last_json


GOAL_FIELD_CASES = [
    ("assignee_id", "m1"),
    ("success_hypothesis", "if X then Y"),
    ("metric_definition", {"metric": "retention", "target": 0.5}),
    ("measure_after", "2026-10-01"),
]


@pytest.mark.parametrize("field_name,value", GOAL_FIELD_CASES)
async def test_update_goal_wires_each_new_field_into_patch_payload(monkeypatch, field_name, value):
    from sprintable_mcp.tools import goals

    recorder = _RecordingPatch()
    monkeypatch.setattr(goals.client, "patch", recorder)

    args = goals.UpdateGoalInput(goal_id="g1", **{field_name: value})
    await goals.update_goal(args)

    assert recorder.last_json.get(field_name) == value, (
        f"{field_name}이 UpdateGoalInput엔 선언돼 있지만 update_goal()의 PATCH payload엔 안 실렸다."
    )


async def test_update_goal_omits_new_fields_when_not_provided(monkeypatch):
    from sprintable_mcp.tools import goals

    recorder = _RecordingPatch()
    monkeypatch.setattr(goals.client, "patch", recorder)

    args = goals.UpdateGoalInput(goal_id="g1", title="only this")
    await goals.update_goal(args)

    for field_name, _ in GOAL_FIELD_CASES:
        assert field_name not in recorder.last_json


async def test_measure_after_field_reaches_payload_same_as_goal_analog(monkeypatch):
    """story #2389 PR 본문 지적 — story 쪽 measure_after는 goals와 달리 outcome_status 자동전이를
    트리거하지 않는다(story 라우터엔 그 동형 함수가 없음, PR 본문 확認). 그래도 «값 자체»는
    실려야 한다는 것만 이 테스트의 범위 — 전이 여부는 백엔드 라우터 스코프."""
    from sprintable_mcp.tools import stories

    recorder = _RecordingPatch()
    monkeypatch.setattr(stories.client, "patch", recorder)

    args = stories.UpdateStoryInput(story_id="s1", measure_after="2026-09-01")
    await stories.update_story(args)

    assert recorder.last_json.get("measure_after") == "2026-09-01"


# ── 의도적으로 뺀 3개 필드가 정말 도구 인자로 안 받아지는지(코드 스코프 준수) ──────────────


async def test_update_story_does_not_declare_intentionally_excluded_fields():
    """position·is_excluded·meeting_id는 handler 주석이 설명하는 대로 의도적 제외 — 스키마에
    아예 없어야 한다(실수로 나중에 붙었는지 회귀 감시)."""
    from sprintable_mcp.tools.stories import UpdateStoryInput

    declared = set(UpdateStoryInput.model_fields)
    for excluded in ("position", "is_excluded", "meeting_id"):
        assert excluded not in declared, (
            f"{excluded}는 update_story()의 docstring이 의도적 제외라 설명하는 필드인데 "
            f"스키마에 선언돼 있다 — 문서와 코드가 어긋난다."
        )
