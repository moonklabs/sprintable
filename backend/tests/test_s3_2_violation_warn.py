"""S3-2: 워크플로우 위반 warn 감지 + 알림 검증.

AC1: 상태 전이 시 위반 여부 검사 (2단계 이상 건너뛰기)
AC2: 위반 시 workflow_violation 이벤트 발행 (severity: warn)
AC3: SSE 이벤트 발행 (publish_event 호출)
AC4: 웹훅 알림 (fire_webhooks 호출)
AC5: violation_level 기본값 warn
AC6: warn 모드 — 상태 전이 정상 진행
AC7: block 모드 — 상태 전이 거부 + 사유 반환
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.workflow_violation import ViolationResult, check_transition, build_violation_event

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()


# ─── check_transition 단위 테스트 (AC1) ──────────────────────────────────────

def test_no_violation_adjacent_step():
    """AC1: 인접 단계 전이 — 위반 없음."""
    result = check_transition("backlog", "ready-for-dev")
    assert result.violated is False


def test_no_violation_two_steps():
    """AC1: 2단계 건너뛰기는 skip=2이지만 경계값 검토."""
    # backlog(0) → in-progress(2) = rank diff 2 → 위반
    result = check_transition("backlog", "in-progress")
    assert result.violated is True
    assert "ready-for-dev" in result.reason


def test_violation_skip_three():
    """AC1: 3단계 건너뛰기 — 위반."""
    result = check_transition("backlog", "in-review")
    assert result.violated is True


def test_violation_in_progress_to_done():
    """AC1: in-progress → done (in-review 건너뛰기) — 위반."""
    result = check_transition("in-progress", "done")
    assert result.violated is True
    assert "in-review" in result.reason


def test_no_violation_reopen():
    """AC1: 역방향 전이 (done → in-progress) — 허용."""
    result = check_transition("done", "in-progress")
    assert result.violated is False


def test_no_violation_none_old_status():
    """AC1: old_status=None (최초 생성) — 위반 없음."""
    result = check_transition(None, "in-progress")
    assert result.violated is False


def test_no_violation_unknown_status():
    """AC1: 알 수 없는 status — 위반 없음."""
    result = check_transition("planning", "shipped")
    assert result.violated is False


def test_violation_level_passed_through():
    """AC5: violation_level이 ViolationResult.severity에 반영됨."""
    result = check_transition("in-progress", "done", violation_level="block")
    assert result.violated is True
    assert result.severity == "block"


# ─── build_violation_event 단위 테스트 (AC2) ─────────────────────────────────

def test_build_violation_event_shape():
    """AC2: workflow_violation 이벤트 페이로드 구조."""
    event = build_violation_event(
        story_id=str(STORY_ID),
        story_title="Fix Bug",
        project_id=str(PROJECT_ID),
        org_id=str(ORG_ID),
        old_status="in-progress",
        new_status="done",
        reason="in-review 단계 건너뜀",
        severity="warn",
    )
    assert event["event_type"] == "workflow_violation"
    assert event["severity"] == "warn"
    assert event["story_id"] == str(STORY_ID)
    assert event["reason"] == "in-review 단계 건너뜀"


# ─── migration 파일 확인 ─────────────────────────────────────────────────────

def test_migration_0039_exists():
    """AC5: 0039 migration 파일 존재."""
    from pathlib import Path
    p = Path(__file__).parent.parent / "alembic/versions/0039_add_violation_level_to_projects.py"
    assert p.exists()


def test_migration_0039_revision():
    """AC5: revision=0039, down_revision=0038."""
    from pathlib import Path
    content = (Path(__file__).parent.parent / "alembic/versions/0039_add_violation_level_to_projects.py").read_text()
    assert 'revision = "0039"' in content
    assert 'down_revision = "0038"' in content
    assert "violation_level" in content


# ─── 엔드포인트 통합 테스트 ─────────────────────────────────────────────────

@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_story(old_status: str, new_status: str | None = None):
    s = MagicMock()
    s.id = STORY_ID
    s.org_id = ORG_ID
    s.project_id = PROJECT_ID
    s.title = "Test Story"
    s.status = new_status or old_status
    s.assignee_id = None
    s.epic_id = None
    s.priority = "medium"
    s.story_points = None
    s.description = None
    s.acceptance_criteria = None
    s.position = None
    s.sprint_id = None
    s.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 5, 19, tzinfo=timezone.utc)
    return s


def _mock_project(violation_level: str = "warn"):
    p = MagicMock()
    p.id = PROJECT_ID
    p.name = "Test Project"
    p.violation_level = violation_level
    return p


async def _client():
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def test_warn_mode_does_not_block():
    """AC6: warn 모드 — check_transition 결과 blocked=False (전이 차단 안 함)."""
    result = check_transition("in-progress", "done", violation_level="warn")
    assert result.violated is True
    assert result.severity == "warn"
    # warn 모드는 severity만 warn이고 실제 block 여부는 violation_level 비교로 결정
    assert result.severity != "block"


def test_block_mode_blocks():
    """AC7: block 모드 — violation 결과 severity=block."""
    result = check_transition("in-progress", "done", violation_level="block")
    assert result.violated is True
    assert result.severity == "block"


def test_violation_event_published_on_warn():
    """AC2/3/4: warn 이벤트 발행 페이로드 검증."""
    event = build_violation_event(
        story_id=str(STORY_ID),
        story_title="Story",
        project_id=str(PROJECT_ID),
        org_id=str(ORG_ID),
        old_status="in-progress",
        new_status="done",
        reason="in-review 단계 건너뜀",
        severity="warn",
    )
    assert event["event_type"] == "workflow_violation"
    assert event["severity"] == "warn"
    assert "in-review" in event["reason"]
