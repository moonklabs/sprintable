"""story #2696(커밋1 — 기본값 flip 없이 안전 착륙분): #2694 AC② 인벤토리가 찾은 잔존 동기
dispatch_notification 17건 전량에 ``via_outbox=True``를 명시로 전환한다(#2687→#2688→
#373cfaa1→#2694로 4번 반복된 "호출부 트랜잭션 안 동기 webhook POST" 결함 클래스 마감).

AST 기반 — 각 (파일, 함수) 자리의 dispatch_notification(...) 호출이 실제로 via_outbox=True를
넘기는지 소스를 직접 스캔한다. 라인번호 변경에 안전하고, 누군가 나중에 이 kwarg를 지우면
바로 RED가 된다(mutation-kill)."""
from __future__ import annotations

import ast
from pathlib import Path

_APP = Path(__file__).resolve().parent.parent / "app"

# (상대경로, 함수명) — story #2694 AC② 인벤토리의 잔존 17건.
_CALL_SITES: list[tuple[str, str]] = [
    ("routers/sprints.py", "close_sprint"),
    ("routers/tasks.py", "update_task"),
    ("routers/stories.py", "add_comment"),
    ("routers/visual_artifacts.py", "_notify_artifact_created"),
    ("routers/visual_artifacts.py", "add_artifact_comment"),
    ("routers/visual_artifacts.py", "complete_png_export"),
    ("routers/visual_artifacts.py", "create_html_export"),
    ("routers/visual_artifacts.py", "_notify_artifact_updated"),
    ("routers/team_members.py", "create_team_member"),
    ("services/workflow_parallel_approval.py", "reassign_approver"),
    ("services/story_assignee_events.py", "emit_story_assignee_changed"),
    ("services/workflow_fallback_notify.py", "fallback_notify"),
    ("services/approval_delivery.py", "dispatch_approval_result_reply"),
    ("services/approval_delivery.py", "dispatch_approval_discussion_reply"),
    ("services/workflow_parallel_approval.py", "_notify_parallel_gate_approvers"),
    ("services/agent_dispatch.py", "_finalize_dispatch"),
    ("services/goal_events.py", "_emit"),
]


def _dispatch_notification_calls_in_function(rel_path: str, func_name: str) -> list[ast.Call]:
    src = (_APP / rel_path).read_text(encoding="utf-8")
    tree = ast.parse(src, filename=rel_path)
    calls: list[ast.Call] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == func_name:
            for sub in ast.walk(node):
                if (
                    isinstance(sub, ast.Call)
                    and isinstance(sub.func, ast.Name)
                    and sub.func.id == "dispatch_notification"
                ):
                    calls.append(sub)
    return calls


def test_all_2694_inventory_call_sites_exist_and_are_found():
    """양성대조 — 스캐너 자체가 무력화돼 아래 test가 공허통과하는 것 방지(17곳 전부 최소
    1개 dispatch_notification 호출을 실제로 찾아내는지)."""
    missing = []
    for rel_path, func_name in _CALL_SITES:
        calls = _dispatch_notification_calls_in_function(rel_path, func_name)
        if not calls:
            missing.append(f"{rel_path}:{func_name}")
    assert not missing, f"dispatch_notification 호출을 못 찾음(함수명/구조 변경?): {missing}"


def test_all_17_inventory_call_sites_pass_via_outbox_true():
    """mutation-kill — 17곳 전부 via_outbox=True를 명시로 넘기는지. 아무 자리에서
    via_outbox=True를 지우면(또는 False로 바꾸면) 이 assert가 RED가 된다."""
    violations = []
    for rel_path, func_name in _CALL_SITES:
        for call in _dispatch_notification_calls_in_function(rel_path, func_name):
            has_true = any(
                kw.arg == "via_outbox" and isinstance(kw.value, ast.Constant) and kw.value.value is True
                for kw in call.keywords
            )
            if not has_true:
                violations.append(f"{rel_path}:{func_name}:{call.lineno}")
    assert not violations, (
        f"via_outbox=True 명시가 빠진 자리(동일 결함 클래스 재발 위험): {violations}"
    )
