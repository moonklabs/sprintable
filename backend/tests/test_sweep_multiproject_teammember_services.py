"""광역 sweep 2차 — 라우터 외(services/repositories/dependencies)의 TeamMember.id scalar 잔여 site.

1차 sweep(#1581/#1583/#1585)이 라우터만 드릴다운해 놓친 site. multi-project SENDER(선생님=owner·N
projection 행)가 deliver_conversation_message_webhook 의 sender_name 조회(.limit 없음)서 MultipleResultsFound
→ 전 수신자 미수신(인앱 메시지 P0). exhaustive grep 으로 잔여 전수 봉쇄.

CRASH → .limit(1)(전 행 동형 컬럼 소비):
  - conversation_webhook.deliver_conversation_message_webhook  (sender name·P0)
  - workflow_executions.get_execution                          (agent name)
  - notifications._resolve_notification_user_id                (id/user_id)
  - ownership.assert_agent_owner                               (created_by ownership guard)

SAFE(project_id == 필터로 1행 확정·무변경):
  - reward.create_reward

ELIMINATED(#2216, 2026-07-27 재분류 — 지우지 않고 옮김): current_project.set_current_project는
더 이상 이 카탈로그의 대상이 아니다. 원래 "SAFE" 분류는 "TeamMember를 쓰되 project_id==필터로
1행 확정해서 안전"이었는데, #2216이 owner-floor 휴먼(명시 project_access grant 없이
has_project_access의 admin_branch로만 접근 — team_members뷰엔 행 자체가 없음)을 이 필터가
"멤버 아님"으로 오판하는 걸 발견해 TeamMember 조회 자체를 has_project_access 호출로 교체했다.
multi-project 행이 여러 개 잡힐 위험은 "필터로 좁혀서" 없앤 게 아니라 "그 조회 자체가 없어져서"
구조적으로 성립하지 않는다 — 옛 SAFE보다 강한 상태(TeamMember 스캔 대상에서 아예 이탈).
⚠️이 재분류가 못 보는 것: has_project_access로 갈아탄 자리는 이 스윕이 더는 감시하지 않는다 —
그쪽 판정(project_auth.py 4-branch)이 나중에 틀리면 이 가드는 침묵한다(별도 축 —
test_authz_project_scope_coverage.py가 그 축을 감시)."""
from __future__ import annotations

import inspect

import pytest


def _fns():
    from app.dependencies import ownership
    from app.routers import notifications, workflow_executions
    from app.services import conversation_webhook

    return {
        "conversation_webhook.deliver_conversation_message_webhook":
            conversation_webhook.deliver_conversation_message_webhook,
        "workflow_executions.get_execution": workflow_executions.get_execution,
        "notifications._resolve_notification_user_id": notifications._resolve_notification_user_id,
        "ownership.assert_agent_owner": ownership.assert_agent_owner,
    }


@pytest.mark.parametrize("name", [
    "conversation_webhook.deliver_conversation_message_webhook",
    "workflow_executions.get_execution",
    "notifications._resolve_notification_user_id",
    "ownership.assert_agent_owner",
])
def test_teammember_scalar_site_has_limit(name: str):
    """각 잔여 site 가 TeamMember.id scalar 조회에 .limit(1) — multi-project MultipleResultsFound 회귀 방지."""
    src = inspect.getsource(_fns()[name])
    assert "TeamMember" in src, f"{name}: TeamMember 쿼리 사라짐(테스트 갱신 필요)"
    assert ".limit(1)" in src, f"{name}: .limit(1) 누락 — multi-project 행에서 MultipleResultsFound 크래시"


@pytest.mark.parametrize("module,fn,expr", [
    ("app.repositories.reward", None, "TeamMember.project_id == project_id"),
])
def test_safe_sites_disambiguated_by_project_filter(module: str, fn: str, expr: str):
    """SAFE 분류 site 는 project_id == 필터로 1행 확정(disambig) — .limit 없이도 안전함을 박제."""
    import importlib

    mod = importlib.import_module(module)
    src = inspect.getsource(mod)
    assert expr in src, f"{module}: '{expr}' disambig 필터 사라짐 — 재분류 필요(이제 crash-prone)"


def test_current_project_set_current_project_no_longer_queries_team_member():
    """#2216 재분류 확인축 — set_current_project가 TeamMember를 아예 안 쓰는지 양성 확인.
    이게 다시 TeamMember 쿼리를 쓰게 되면(예: 누가 "일관성" 명목으로 되돌리면) multi-project
    disambig 위험이 재도입되므로 이 테스트가 잡아야 한다 — has_project_access 사용도 함께 고정."""
    from app.routers import current_project

    src = inspect.getsource(current_project.set_current_project)
    # select(TeamMember...) 실행 쿼리 부재만 본다 — docstring/주석의 "TeamMember" 단어 언급은
    # 오탐(#2216 재분류 사유를 설명하는 텍스트 그 자체가 "TeamMember"를 담고 있음).
    assert "select(TeamMember" not in src, (
        "set_current_project가 다시 TeamMember를 쿼리한다 — #2216 재분류 전제(TeamMember 조회 "
        "자체 이탈)가 깨졌다. multi-project disambig 위험이 재도입됐을 수 있으니 owner-floor "
        "가드(test_2216_current_project_owner_floor_realdb.py)까지 함께 재확인할 것."
    )
    assert "has_project_access" in src
