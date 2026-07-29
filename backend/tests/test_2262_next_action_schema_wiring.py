"""story #2262(C-4) AC9 — next_action_code가 실제 응답 스키마 클래스에 배선됐는지(조건식
자체는 test_2262_next_action_conditions.py가 이미 pin) — 여기는 "그 필드가 응답에
나타나는가"만 확인한다. DB 무접촉(모든 대상 클래스가 from_attributes라 최소 속성 객체로
model_validate 가능)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

_NOW = datetime.now(timezone.utc)
_PAST = _NOW - timedelta(days=1)


def test_story_response_exposes_next_action_code():
    from app.schemas.story import StoryResponse

    obj = SimpleNamespace(
        id=uuid.uuid4(), story_number=1, project_id=uuid.uuid4(), org_id=uuid.uuid4(),
        epic_id=None, sprint_id=None, assignee_id=None, assignee_ids=[], human_owner_member_id=None,
        declared_scope_paths=None, agent_delegate_ids=[], references=None, attachments=[],
        meeting_id=None, title="T", status="in-progress", priority="medium", story_points=None,
        description=None, acceptance_criteria=None, position=None, success_hypothesis=None,
        metric_definition={"source": "manual"}, measure_after=_PAST, outcome_status="pending",
        outcome_result=None, is_excluded=False, created_at=_NOW, updated_at=_NOW, violation=None,
        has_evidence=None, self_reported=None, human_verified=None, human_verified_by=None,
        human_verified_at=None,
    )
    resp = StoryResponse.model_validate(obj)
    assert resp.next_action_code == "outcome_measurement_due"


def test_doc_response_exposes_next_action_code():
    from app.schemas.doc import DocResponse

    obj = SimpleNamespace(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), parent_id=None,
        created_by=None, assignee_id=None, status="draft", superseded_by=None, title="D",
        slug="d", canonical_slug="d", slug_locked=False, content="c", icon=None, sort_order=0,
        doc_type="page", content_format="markdown", tags=[], created_at=_NOW, updated_at=_NOW,
        assignee=None, revisions=None,
    )
    resp = DocResponse.model_validate(obj)
    assert resp.next_action_code == "decision_pending"


def test_artifact_summary_exposes_next_action_code():
    from app.schemas.visual_artifact import VisualArtifactSummary

    obj = SimpleNamespace(
        id=uuid.uuid4(), title="A", story_id=None, epic_id=None, doc_id=None, source="created",
        latest_version_number=1, anchor_version=None, created_by=None, created_at=_NOW,
        canvas_bounds=None, unresolved_comment_count=2,
    )
    resp = VisualArtifactSummary.model_validate(obj)
    assert resp.next_action_code == "artifact_has_unresolved_comments"


def test_task_response_exposes_next_action_code():
    from app.schemas.task import TaskResponse

    obj = SimpleNamespace(
        id=uuid.uuid4(), story_id=uuid.uuid4(), org_id=uuid.uuid4(), assignee_id=None,
        title="T", status="in-review", story_points=None, created_at=_NOW, updated_at=_NOW,
        has_evidence=True, self_reported=True, human_verified=None, human_verified_by=None,
        human_verified_at=None,
    )
    resp = TaskResponse.model_validate(obj)
    assert resp.next_action_code == "verification_pending"


def test_goal_response_exposes_next_action_code():
    from app.schemas.goal import GoalResponse

    obj = SimpleNamespace(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), assignee_id=None,
        title="G", status="active", priority="medium", description=None, objective=None,
        success_criteria=None, target_sp=None, target_date=None, success_hypothesis=None,
        metric_definition={"source": "manual"}, measure_after=_PAST, outcome_status="pending",
        outcome_result=None, hypothesis_count=0, risky_status=None, total_stories=0, done_stories=0,
        position=None, source_loop_id=None, created_at=_NOW, updated_at=_NOW,
    )
    resp = GoalResponse.model_validate(obj)
    assert resp.next_action_code == "outcome_measurement_due"


def test_sprint_response_exposes_next_action_code():
    from app.schemas.sprint import SprintResponse

    obj = SimpleNamespace(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), status="active",
        velocity=None, duration=14, report_doc_id=None, outcome_status="pending",
        outcome_result=None, created_at=_NOW, updated_at=_NOW,
        title="S", start_date=None, end_date=None, team_size=None, goal=None, capacity=None,
        success_hypothesis=None,
        metric_definition={"source": "manual", "metric": "x", "direction": "up", "target": 1},
        measure_after=_PAST,
    )
    resp = SprintResponse.model_validate(obj)
    assert resp.next_action_code == "outcome_measurement_due"
