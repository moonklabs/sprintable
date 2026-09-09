"""story #3722 — `extract_story_id()` 축 우선순위(path 템플릿 파라미터 > 쿼리 > body
최상위) · `/stories/{id}` 특례(파라미터명이 story_id가 아니라 id일 때 라우트 템플릿으로
판별)."""
from __future__ import annotations

from app.services.tool_call_attribution import extract_story_id


def test_path_param_story_id_wins_over_query_and_body():
    result = extract_story_id(
        route_path="/api/v2/goals/{story_id}/reference-candidates",
        path_params={"story_id": "s1"},
        query_params={"story_id": "s2"},
        body={"story_id": "s3"},
    )
    assert result == "s1"


def test_stories_route_id_param_treated_as_story_id():
    result = extract_story_id(
        route_path="/api/v2/stories/{id}",
        path_params={"id": "s1"},
        query_params=None,
        body=None,
    )
    assert result == "s1"


def test_tasks_route_id_param_not_treated_as_story_id():
    """«id»라는 이름만으로는 어느 리소스인지 모른다 — /tasks/{id}의 id는 story_id가
    아니다(회귀 표적: route_path 체크 없이 path_params["id"]를 그냥 쓰면 이 테스트가
    실패한다)."""
    result = extract_story_id(
        route_path="/api/v2/tasks/{id}",
        path_params={"id": "t1"},
        query_params=None,
        body=None,
    )
    assert result is None


def test_query_param_used_when_no_path_param():
    result = extract_story_id(
        route_path="/api/v2/agent-runs",
        path_params=None,
        query_params={"story_id": "s1"},
        body=None,
    )
    assert result == "s1"


def test_body_top_level_used_as_last_resort():
    result = extract_story_id(
        route_path="/api/v2/stories/status",
        path_params=None,
        query_params=None,
        body={"story_id": "s1"},
    )
    assert result == "s1"


def test_returns_none_when_no_story_id_anywhere():
    assert extract_story_id(route_path="/api/v2/notifications", path_params=None, query_params=None, body=None) is None


def test_body_story_id_ignored_when_not_a_string():
    """body["story_id"]가 문자열이 아니면(예: 리스트·숫자) 무시 — 지어내지 않는다."""
    result = extract_story_id(
        route_path="/api/v2/stories/bulk", path_params=None, query_params=None, body={"story_id": ["s1", "s2"]},
    )
    assert result is None
