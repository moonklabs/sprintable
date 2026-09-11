"""story #3370 회귀 원천봉쇄 — `scripts/lint_raw_auth_id_into_member_field.py`의 검출/미검출
범위를 코드 자체가 아니라 합성 소스 문자열로 pin한다(test_no_team_members_view_dml_in_tests.py
의 #2523 스캐너 자체검증 관례와 동형 — 단발 probe가 아니라 CI가 계속 지키게 하는 것).

2026-09-11 실측: 도입 시점 E-AGENT-* 도메인(agent_deployments.py 등)에서 이 규칙과 정확히
같은 클래스의 기존 위반 14건이 발견됐다 — 페드루 PO 판단②'(칸의 뜻으로 가름)에 따라 10건은
resolve_member_db_verified()로 정정(이 파일 하단 인스턴스 핀 참고), 4건(dependencies.py 3·
agent_sessions.py 1)은 소비처가 없는 users.id 자리라 인라인 `# member-id-lint: user-id-field`
마커로 처리 — `test_repo_has_zero_violations`가 그 최종 상태(0건)를 고정한다."""
from __future__ import annotations

import ast

import pytest

from scripts.lint_raw_auth_id_into_member_field import (
    ScanIncompleteError,
    findings_for_source,
    scan_function,
    scan_repo,
)


def _findings_in(source: str) -> list[tuple[int, str, str]]:
    tree = ast.parse(source)
    out: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            out.extend(scan_function(node))
    return out


# ─── 잡아야 하는 것 ────────────────────────────────────────────────────────────


def test_direct_call_into_member_id_suffix_kwarg_is_caught():
    src = "async def f(auth, db):\n    await create(created_by_member_id=uuid.UUID(auth.user_id))\n"
    findings = _findings_in(src)
    assert len(findings) == 1
    assert findings[0][1] == "created_by_member_id"
    assert "직접" in findings[0][2]


def test_direct_call_into_resolver_id_kwarg_is_caught():
    src = "async def f(auth, session, gate):\n    await transition_gate(session, gate, resolver_id=uuid.UUID(auth.user_id))\n"
    findings = _findings_in(src)
    assert len(findings) == 1
    assert findings[0][1] == "resolver_id"


def test_direct_call_into_actor_id_kwarg_is_caught():
    src = "async def f(auth, repo):\n    await repo.create(actor_id=uuid.UUID(auth.user_id))\n"
    findings = _findings_in(src)
    assert len(findings) == 1
    assert findings[0][1] == "actor_id"


def test_one_level_variable_indirection_is_caught():
    """카드 明示 축 — 직접 호출뿐 아니라 1단계 변수 경유도 잡는다."""
    src = (
        "async def f(auth, repo):\n"
        "    raw = uuid.UUID(auth.user_id)\n"
        "    await repo.create(actor_id=raw)\n"
    )
    findings = _findings_in(src)
    assert len(findings) == 1
    assert findings[0][1] == "actor_id"
    assert "변수" in findings[0][2] and "raw" in findings[0][2]


def test_bare_uuid_ctor_form_is_also_caught():
    """`from uuid import UUID` 형(bare Name 호출)도 `uuid.UUID(...)`(Attribute 호출)와
    동형으로 잡는다 — 이 레포 실제 관례는 전자뿐이지만(2026-09-11 실측, app/ 0건) 가드
    자신은 두 형 다 지원한다."""
    src = "async def f(auth, repo):\n    await repo.create(actor_id=UUID(auth.user_id))\n"
    findings = _findings_in(src)
    assert len(findings) == 1


# ─── 양성대조 — 정정 前/後 실제 형(story #3370, app/routers/workflow_line_config.py:290
# `approve_publish_endpoint`, transition_gate(resolver_id=resolved.id) 호출) ───────────────


def test_positive_control_workflow_line_config_pre_fix_shape_is_caught():
    """workflow_line_config.py:290의 **정정 前** 형을 되돌린 것과 동형 — 이 형이면 반드시
    잡혀야 한다(양성대조, 페드루 지시 2026-09-11 "10곳 중 1곳을 되돌리면 그 줄 이름 대고
    RED")."""
    src = (
        "async def approve_publish_endpoint(auth, session, version):\n"
        "    gate = await transition_gate(session, org_id, version.review_gate_id, "
        "\"approved\", resolver_id=uuid.UUID(auth.user_id))\n"
    )
    findings = _findings_in(src)
    assert len(findings) == 1
    assert findings[0][1] == "resolver_id"


def test_fixed_shape_using_resolved_member_id_is_not_flagged():
    """workflow_line_config.py:290의 **정정 後**(실 코드) 형 — resolve_member_db_verified()가
    반환한 영속 멤버 id(`resolved.id`)를 쓰면 이 가드가 조용해야 한다(false positive 0)."""
    src = (
        "async def approve_publish_endpoint(auth, session, version):\n"
        "    resolved = await resolve_member_db_verified(auth, org_id, session)\n"
        "    gate = await transition_gate(session, org_id, version.review_gate_id, "
        "\"approved\", resolver_id=resolved.id)\n"
    )
    findings = _findings_in(src)
    assert findings == []


# ─── 잡지 말아야 하는 것(오탐 방지 + 스크립트 docstring이 선언한 사각지대 pin) ──────────────


def test_non_target_kwarg_is_not_flagged():
    """대상 3종(`*_member_id`·`resolver_id`·`actor_id`) 밖의 kwarg(예: `assignee_id`)는
    같은 raw 패턴이어도 이 가드의 대상이 아니다(스크립트 docstring 사각지대③)."""
    src = "async def f(auth, repo):\n    await repo.create(assignee_id=uuid.UUID(auth.user_id))\n"
    assert _findings_in(src) == []


def test_attribute_access_value_is_not_flagged():
    """request body 필드처럼 값이 `<name>.attr` 형(Call도 tainted-Name도 아님)이면 오탐 0
    (실측: app/routers/workflow_line_config.py의 `actor_id=body.actor_id` 자리가 정확히
    이 형 — dry-run 검증용 파라미터일 뿐 auth 클레임이 아니다)."""
    src = "async def f(auth, body, repo):\n    await repo.create(actor_id=body.actor_id)\n"
    assert _findings_in(src) == []


def test_two_level_variable_chain_is_not_flagged():
    """2단 이상 alias 체인은 이 가드의 알려진 사각지대②(1단만 보장)."""
    src = (
        "async def f(auth, repo):\n"
        "    raw = uuid.UUID(auth.user_id)\n"
        "    tmp = raw\n"
        "    await repo.create(actor_id=tmp)\n"
    )
    assert _findings_in(src) == []


def test_wrapped_in_another_call_is_not_flagged():
    """`str(uuid.UUID(auth.user_id))`처럼 한 겹 더 감싼 표현식은 사각지대⑤ — kwarg 값이
    정확히 tainted Call 노드이거나 그 Call로 대입된 단순 Name이어야 매치한다."""
    src = "async def f(auth, repo):\n    await repo.create(actor_id=str(uuid.UUID(auth.user_id)))\n"
    assert _findings_in(src) == []


def test_different_attribute_than_user_id_is_not_flagged():
    """`.user_id`가 아닌 다른 속성(예: `.id`)에서 온 uuid.UUID(...)는 애초에 이 결함
    클래스(auth 클레임 원시값)가 아니므로 대상 밖."""
    src = "async def f(auth, repo):\n    await repo.create(actor_id=uuid.UUID(auth.id))\n"
    assert _findings_in(src) == []


# ─── 인라인 예외 마커(페드루 PO 지시 2026-09-11) ───────────────────────────────────


def test_exemption_marker_silences_direct_call():
    src = (
        "async def f(auth, repo):\n"
        "    await repo.create(actor_id=uuid.UUID(auth.user_id))  # member-id-lint: user-id-field — SSE payload\n"
    )
    assert findings_for_source(src) == []


def test_exemption_marker_silences_variable_indirection():
    src = (
        "async def f(auth, repo):\n"
        "    raw = uuid.UUID(auth.user_id)\n"
        "    await repo.create(\n"
        "        actor_id=raw,  # member-id-lint: user-id-field — audit blob\n"
        "    )\n"
    )
    assert findings_for_source(src) == []


def test_without_marker_same_shape_is_still_flagged():
    """마커가 없으면 그대로 잡힌다 — 마커 자체가 검사를 무력화하는 게 아니라 그 한 줄만
    지나가게 한다는 것을 대조로 확인."""
    src = "async def f(auth, repo):\n    await repo.create(actor_id=uuid.UUID(auth.user_id))\n"
    assert len(findings_for_source(src)) == 1


def test_marker_only_silences_its_own_line_not_sibling_violations():
    """한 함수 안에 마커 있는 줄과 없는 줄이 섞이면 마커 없는 쪽만 잡혀야 한다(마커가
    함수 전체를 꺼버리는 전역 스위치가 아님을 확인)."""
    src = (
        "async def f(auth, repo):\n"
        "    await repo.create(actor_id=uuid.UUID(auth.user_id))  # member-id-lint: user-id-field — ok\n"
        "    await repo.update(resolver_id=uuid.UUID(auth.user_id))\n"
    )
    findings = findings_for_source(src)
    assert len(findings) == 1
    assert findings[0][2] == "resolver_id"


# ─── story #3370 2차 CHANGES(페드루 2026-09-11) — 실 저장소 0건 통합 검증 ────────────
# 2026-09-11 사후 감사에서 baseline이 실제로는 14건이었다(agent_deployments 5·
# agent_personas 2·agent_routing_rules 1·agents 1·billing_keys 1은 genuine으로 판정돼
# resolve_member_db_verified()로 정정·dependencies.py 3·agent_sessions.py 1은 SSE
# payload/JSON 감사 블롭이라 인라인 마커로 처리) — 이 테스트는 그 정정이 실제로 반영된
# 뒤의 최종 상태(0건)를 고정한다.


# ─── 완전성 자기 확認(페드루 PO 조건부 PASS 조건1, 2026-09-11) ────────────────────
# scan_repo가 스캔 루트 부재·파일 0개를 "위반 0건"으로 조용히 흘리지 않고 ScanIncompleteError
# 로 즉시 실패하는지 고정한다(fails-silent 클래스 원천봉쇄 자체를 pin).


def test_scan_repo_raises_when_a_root_is_missing(tmp_path):
    (tmp_path / "app" / "routers").mkdir(parents=True)
    (tmp_path / "app" / "routers" / "x.py").write_text("async def f(auth, repo):\n    pass\n")
    (tmp_path / "app" / "services").mkdir(parents=True)
    (tmp_path / "app" / "services" / "y.py").write_text("async def f(auth, repo):\n    pass\n")
    # "ee" 루트를 아예 안 만든다 — 3개 중 하나 실종.
    with pytest.raises(ScanIncompleteError):
        scan_repo(scan_roots=["app/routers", "app/services", "ee"], backend_root=tmp_path)


def test_scan_repo_raises_when_zero_files_scanned(tmp_path):
    for root in ("app/routers", "app/services", "ee"):
        (tmp_path / root).mkdir(parents=True)
    # 세 루트 다 실존하지만 .py 파일이 하나도 없다.
    with pytest.raises(ScanIncompleteError):
        scan_repo(scan_roots=["app/routers", "app/services", "ee"], backend_root=tmp_path)


def test_scan_repo_succeeds_when_roots_exist_with_files(tmp_path):
    for root in ("app/routers", "app/services", "ee"):
        d = tmp_path / root
        d.mkdir(parents=True)
        (d / "x.py").write_text("async def f(auth, repo):\n    pass\n")
    # 예외 없이 정상 반환(빈 리스트 — 위반 0건과 "헛돎" 0건을 구분하는 정상 경로).
    assert scan_repo(scan_roots=["app/routers", "app/services", "ee"], backend_root=tmp_path) == []


def test_repo_has_zero_violations():
    findings = scan_repo()
    assert findings == [], (
        f"story #3370 회귀 클래스 위반 {len(findings)}건 — 각 자리를 resolve_member_db_verified()"
        "로 정정하거나(칸이 member id를 뜻하면) `# member-id-lint: user-id-field — <이유>` "
        "인라인 주석을 달 것(칸이 users.id를 뜻하면): " + repr(findings)
    )


# ─── 인스턴스 핀(페드루 지시 2026-09-11 — 고친 (a)마다 1개) ─────────────────────────
# 실 소스 파일을 import해 정정 後 실제 시그니처/값 축이 살아있는지 고정한다(합성 스니펫이
# 아니라 실 코드 대상 — "이 자리를 다시 되돌리면 잡힌다"가 아니라 "이 자리가 실제로
# resolve_member_db_verified를 거친다"는 것 자체를 pin).


def test_agent_deployments_create_uses_resolved_member_id():
    import inspect

    from app.routers import agent_deployments

    src = inspect.getsource(agent_deployments.create_deployment)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved.id" in src


def test_agent_deployments_preflight_uses_resolved_member_id():
    import inspect

    from app.routers import agent_deployments

    src = inspect.getsource(agent_deployments.run_preflight)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved.id" in src


def test_agent_deployments_patch_uses_resolved_member_id():
    import inspect

    from app.routers import agent_deployments

    src = inspect.getsource(agent_deployments.patch_deployment)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved.id" in src


def test_agent_deployments_delete_uses_resolved_member_id():
    import inspect

    from app.routers import agent_deployments

    src = inspect.getsource(agent_deployments.delete_deployment)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved.id" in src


def test_agent_deployments_complete_verification_uses_resolved_member_id():
    import inspect

    from app.routers import agent_deployments

    src = inspect.getsource(agent_deployments.complete_verification)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved.id" in src


def test_agent_personas_create_uses_resolved_member_id():
    import inspect

    from app.routers import agent_personas

    src = inspect.getsource(agent_personas.create_persona)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved.id" in src


def test_agent_personas_update_uses_resolved_member_id():
    import inspect

    from app.routers import agent_personas

    src = inspect.getsource(agent_personas.update_persona)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved.id" in src


def test_agent_routing_rules_create_uses_resolved_member_id():
    import inspect

    from app.routers import agent_routing_rules

    src = inspect.getsource(agent_routing_rules.create_rule)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved.id" in src


def test_agents_recruit_endpoint_uses_resolved_member_id():
    import inspect

    from app.routers import agents

    src = inspect.getsource(agents._recruit_agent_endpoint)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved.id" in src


def test_billing_keys_delete_uses_resolved_member_id():
    """prod-live 성립 자리(페드루 지시 2026-09-11) — revoke_billing_key()가 이 값을
    ActivityLogService.record(actor_id=...)로 넘겨 ActivityLog.actor_id로 영속한다.
    activity_logs.py가 이미 확定한 "그 칸=resolve_member().id" 계약과 같은 축(별도
    회귀 pin — 상세 사유는 라우터 인라인 주석 참고)."""
    import inspect

    from app.routers import billing_keys

    src = inspect.getsource(billing_keys.delete_billing_key)
    assert "resolve_member_db_verified" in src
    assert "actor_id=resolved_actor_id" in src
