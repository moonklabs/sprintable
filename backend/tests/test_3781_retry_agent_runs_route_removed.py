"""story #3781(PO 判 2026-09-10 09:47Z, 은퇴) — `GET /api/v2/internal/cron/retry-agent-runs`
엔드포인트가 다시 등록되면(재발) 이 테스트가 RED로 잡는다.

그라운딩(미르코): `AgentRun.next_retry_at`을 non-null로 채우는 코드가 backend 전체에
0건이라 이 엔드포인트의 WHERE(`next_retry_at IS NOT NULL AND <= now`)는 대상 실행 존재
여부와 무관하게 원리적으로 영원히 0행을 골랐다("돌지만 절대 못 고른다"). dev DB 실측
(PO, 2026-09-10) `agent_runs.status='queued'` 0건 — 이 엔드포인트가 만드는 전이가 실제로
한 번도 성공한 적이 없다는 뜻이라 데이터 마이그레이션 없이 코드만 걷었다.

⛔이 카드가 «안 건드린» 것(경계 명시, 재발 시 실수로 같이 지우지 않도록):
  - `AgentRun.next_retry_at`/`retry_count`/`max_retries` 모델 컬럼 — `deployment_lifecycle.
    py::build_cards`가 읽어 실 API 응답(`DeploymentCardResponse.latest_failed_run`)에 싣는
    살아있는 소비처가 있다(그라운딩 확認). 컬럼은 그대로 둔다.
  - `deployment_lifecycle.py`의 `_hold_queued_runs`/`_resume_held_runs`/`_fail_queued_runs`
    (배포 suspend/activate/fail/terminate 생명주기의 `queued`↔`held`↔`failed` 전이) — 이
    은퇴 범위 밖, `status="queued"`가 이 엔드포인트 전용 개념이 아니었기 때문.
"""
from __future__ import annotations


def test_retry_agent_runs_route_is_gone_from_the_app():
    from app.main import app

    matching = [
        route for route in app.routes
        if getattr(route, "path", None) == "/api/v2/internal/cron/retry-agent-runs"
    ]
    assert matching == [], (
        "GET /api/v2/internal/cron/retry-agent-runs 라우트가 다시 등록됐다 — story #3781이 "
        "은퇴시킨 자리(위 docstring 그라운딩 참고). 재건이 의도된 것이면 next_retry_at을 "
        "실제로 채우는 producer부터 먼저 만들 것(story #3781 처방 판정 동일 조건)."
    )


def test_retry_agent_runs_symbol_is_gone_from_cron_module():
    """함수 심볼 자체도 없어야 한다 — 라우트 등록만 빠지고 함수가 죽은 채 남는 것(반쪽
    은퇴) 방지."""
    import app.routers.cron as cron_mod

    assert not hasattr(cron_mod, "retry_agent_runs")
