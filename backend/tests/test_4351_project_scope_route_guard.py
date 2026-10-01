"""story #4351 AC3 — 가드: 프로젝트 소속 엔터티를 싣는 라우트 핸들러가 접근 해소기를 거치지 않으면 RED.

규칙(AST · 핸들러 = `@router.get/post/put/patch/delete`로 꾸민 함수):
- «프로젝트 소속 엔터티를 싣는다» = 핸들러 몸통이 `project_id` 칼럼을 가진 모델(등록된 매퍼 전수에서 계산) 또는 Task를 이름으로 쓴다.
- «해소기를 거친다» = 몸통에 `project_access` · `accessible` · `can_access` · `_scope_filter`를 담은 이름(has_project_access ·
  require_project_access · accessible_project_ids_in_org · restricted_accessible_project_ids · 라우터별 `_require_*_project_access` 등)이 있다.
- 둘 다 아니면 잡는다. 지금 잡히는 70자리는 `_KNOWN`에 고정(래칫) — **새로 잡히면 RED**, 고쳐져 안 잡히는데 `_KNOWN`에 남아도 RED
  (양방향 · 고친 자리는 목록에서 뺀다).

⛔못 잡는 것(선언): ① 핸들러가 서비스 함수에 조회를 넘기는 모양(judgments · verdicts · workflow-line/metrics · /today가 그랬다 —
그 자리들은 실 PG 테스트 test_4351_pr_b_scope_realdb.py가 막는다) ② 해소기를 한 갈래에서만 부르고 다른 갈래는 org 전체로 도는 핸들러
(옛 `list_gates`: work_item_id 갈래만 has_project_access) ③ 이름만 보고 판정하므로 해소기를 부르고 결과를 안 쓰는 경우.
_KNOWN 안에는 org 수준 리소스(연결 · 계정 · 에이전트 게이트웨이 등)라 정당한 자리와 아직 안 본 자리가 섞여 있다 — 이 가드는
«새로 생기는 자리»를 사람이 보게 하는 것이지 목록 전체가 결함이라는 주장이 아니다.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
_ROUTERS = _BACKEND / "app" / "routers"
_ROUTE_METHODS = frozenset({"get", "post", "put", "patch", "delete"})
_ACCESS = re.compile(r"(project_access|accessible|can_access|_scope_filter)")

_KNOWN = {
    "app/routers/account.py::resolve_accounts",
    "app/routers/agent_gateway.py::ack_event",
    "app/routers/agent_gateway.py::agent_stream",
    "app/routers/agent_inbox.py::receive_inbox_webhook",
    "app/routers/assets.py::storage_usage",
    "app/routers/auth.py::confirm_set_password",
    "app/routers/auth.py::logout",
    "app/routers/auth.py::refresh_token",
    "app/routers/auth.py::switch_account",
    "app/routers/auth_firebase_internal.py::consume_native_bootstrap",
    "app/routers/auth_native_bootstrap.py::native_bootstrap",
    "app/routers/auth_native_bootstrap.py::native_bootstrap_challenge",
    "app/routers/conversations.py::add_participant",
    "app/routers/conversations.py::get_conversation",
    "app/routers/conversations.py::list_conversations",
    "app/routers/conversations.py::list_conversations_by_work_item",
    "app/routers/conversations.py::list_working_members",
    "app/routers/conversations.py::mark_conversation_read",
    "app/routers/conversations.py::release_circuit_breaker_endpoint",
    "app/routers/conversations.py::set_conversation_mute",
    "app/routers/conversations.py::update_conversation",
    "app/routers/conversations.py::update_conversation_status",
    "app/routers/conversations.py::upload_conversation_attachment",
    "app/routers/cron.py::agent_session_recovery",
    "app/routers/cron.py::assets_grace_hard_delete",
    "app/routers/cron.py::hitl_timeouts",
    "app/routers/cron.py::score_ga4_outcomes",
    "app/routers/cron.py::storage_usage_warn",
    "app/routers/current_project.py::get_current_project",
    "app/routers/device_installations.py::register_device_installation",
    "app/routers/event_notifications.py::get_unread_count",
    "app/routers/event_notifications.py::list_notifications",
    "app/routers/event_notifications.py::mark_all_read",
    "app/routers/event_notifications.py::mark_read",
    "app/routers/events.py::agent_event_stream",
    "app/routers/events.py::create_event",
    "app/routers/events.py::get_event_publish_history",
    "app/routers/events.py::get_my_channel_connection_status",
    "app/routers/events.py::get_my_generation_connector",
    "app/routers/events.py::get_pending_events",
    "app/routers/events.py::mark_delivered",
    "app/routers/file_locks.py::lock_files",
    "app/routers/file_locks.py::unlock_files",
    "app/routers/goals.py::transition_goal_endpoint",
    "app/routers/hitl.py::list_hitl_requests",
    "app/routers/hitl.py::resolve_hitl_request",
    "app/routers/me.py::get_me",
    "app/routers/me.py::update_me",
    "app/routers/notification_preferences.py::upsert_preferences",
    "app/routers/project_access.py::create_project_access",
    "app/routers/project_access.py::delete_project_access",
    "app/routers/project_access.py::list_project_access",
    "app/routers/project_access.py::set_project_role",
    "app/routers/project_settings.py::upsert_project_settings",
    "app/routers/recipe_repeat_schedules.py::list_repeat_schedules",
    "app/routers/recipe_repeat_schedules.py::run_repeat_schedule_now",
    "app/routers/sprints.py::close_sprint",
    "app/routers/team_members.py::create_team_member",
    "app/routers/verdict_capture.py::capture_pr_verdict",
    "app/routers/verdict_capture.py::capture_review",
    "app/routers/visual_artifacts.py::add_artifact_comment",
    "app/routers/visual_artifacts.py::create_artifact",
    "app/routers/visual_artifacts.py::edit_artifact",
    "app/routers/visual_artifacts.py::list_artifact_comments",
    "app/routers/visual_artifacts.py::list_artifacts",
    "app/routers/visual_artifacts.py::resolve_artifact_comment",
    "app/routers/webhooks.py::list_webhook_deliveries",
    "app/routers/workflow_executions.py::get_execution",
}

# story #4351에서 고친 자리 — 뮤테이션 대조(해소기 이름을 지우면 다시 잡혀야 한다 = 가드가 이 자리들을 실제로 보고 있다).
_FIXED_IN_4351 = {
    "app/routers/command_center.py::overview",
    "app/routers/gates.py::list_gate_inbox",
    "app/routers/material_lineage.py::list_material_lineage",
    "app/routers/material_lineage.py::get_material_performance",
    "app/routers/stories.py::add_comment",
    "app/routers/workflow_executions.py::list_executions",
}


def _project_owned_model_names() -> frozenset[str]:
    import app.main  # noqa: F401 — 모든 모델 매퍼 등록
    from app.core.database import Base

    names = {m.class_.__name__ for m in Base.registry.mappers if "project_id" in m.local_table.c}
    return frozenset(names | {"Task"})  # 과제는 소속 스토리 경유로 프로젝트 소속


def _scan(src: str, rel: str, owned: frozenset[str]) -> set[str]:
    hits: set[str] = set()
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not any(
            isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr in _ROUTE_METHODS
            for d in node.decorator_list
        ):
            continue
        names = {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}
        names |= {n.attr for n in ast.walk(node) if isinstance(n, ast.Attribute)}
        if names & owned and not any(_ACCESS.search(n) for n in names):
            hits.add(f"{rel}::{node.name}")
    return hits


def _scan_routers(owned: frozenset[str]) -> set[str]:
    hits: set[str] = set()
    for path in sorted(_ROUTERS.glob("*.py")):
        hits |= _scan(path.read_text(), f"app/routers/{path.name}", owned)
    return hits


def test_no_new_route_loads_project_owned_entities_without_the_access_resolver():
    new = _scan_routers(_project_owned_model_names()) - _KNOWN
    assert not new, (
        "프로젝트 소속 엔터티를 싣는데 접근 해소기(accessible_project_ids_in_org · has_project_access 등)를 안 거치는 새 라우트: "
        f"{sorted(new)} — 접근 가능 프로젝트로 좁히거나, org 수준 리소스라 정당하면 이유와 함께 _KNOWN에 더한다"
    )


def test_known_list_has_no_entries_that_are_already_fixed():
    stale = _KNOWN - _scan_routers(_project_owned_model_names())
    assert not stale, f"고쳐졌거나 사라진 자리가 _KNOWN에 남아 있다(빼야 래칫이 조인다): {sorted(stale)}"


def test_positive_control_synthetic_handlers():
    owned = _project_owned_model_names()
    leaky = '@router.get("/x")\nasync def leaky(session):\n    return await session.execute(select(Story))\n'
    scoped = (
        '@router.get("/y")\nasync def scoped(session, auth, org_id):\n'
        '    ids = await accessible_project_ids_in_org(session, auth.user_id, org_id)\n'
        '    return await session.execute(select(Story).where(Story.project_id.in_(ids)))\n'
    )
    org_level = '@router.get("/z")\nasync def org_level(session):\n    return await session.execute(select(Organization))\n'
    assert _scan(leaky, "m.py", owned) == {"m.py::leaky"}
    assert _scan(scoped, "m.py", owned) == set()
    assert _scan(org_level, "m.py", owned) == set()


def test_sites_fixed_in_4351_are_seen_by_the_guard():
    """고친 자리의 해소기 이름을 지운 사본을 스캔하면 그 핸들러가 다시 잡힌다(가드가 그 자리를 실제로 본다 · 뮤테이션 대조)."""
    owned = _project_owned_model_names()
    for key in sorted(_FIXED_IN_4351):
        rel, func = key.split("::")
        src = (_BACKEND / rel).read_text()
        assert key not in _scan(src, rel, owned), f"{key}는 고쳐져 있어야 한다"
        mutated = _ACCESS.sub("noop", src)
        assert key in _scan(mutated, rel, owned), f"{key}: 해소기를 지워도 가드가 못 잡는다"
