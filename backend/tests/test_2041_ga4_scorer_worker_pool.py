"""story #2041(그라운딩 doc 67b44d1e, PR-C) — GA4 채점 크론 2종(score-ga4-outcomes·
score-hypotheses) 회귀가드.

핵심 검증축:
①두 크론 라우터 엔드포인트가 `get_db`(요청 primary pool)가 아니라 `get_worker_db`(전용
  소형 풀)를 의존한다 — FastAPI 의존성 그래프 검사로 직접 고정(런타임 커넥션 소스 실측
  대안 없이도 배선 자체를 확実히 잡는다).
②`score_ga4_outcome` 호출이 메인 이벤트루프 스레드가 아니라 별도 스레드(asyncio.to_thread)
  에서 실행된다 — 이벤트루프 블록 해소가 실제로 걸렸는지 스레드 식별로 직접 증명.
"""
from __future__ import annotations

import asyncio
import threading
from unittest.mock import patch

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_score_ga4_outcomes_endpoint_depends_on_worker_db():
    from app.dependencies.database import get_worker_db
    from app.routers.cron import score_ga4_outcomes

    deps = {p.name: p.default for p in __import__("inspect").signature(score_ga4_outcomes).parameters.values()}
    session_default = deps["session"]
    assert session_default.dependency is get_worker_db, (
        "score_ga4_outcomes가 여전히 get_db(요청 primary pool)를 쓰면 story #2041의 GA4 "
        "외부 I/O 커넥션 예산 이관이 회귀한다"
    )


def test_score_hypotheses_cron_endpoint_depends_on_worker_db():
    from app.dependencies.database import get_worker_db
    from app.routers.cron import score_hypotheses_cron

    deps = {p.name: p.default for p in __import__("inspect").signature(score_hypotheses_cron).parameters.values()}
    session_default = deps["session"]
    assert session_default.dependency is get_worker_db


async def test_score_hypotheses_ga4_branch_runs_off_event_loop_thread():
    """②— score_hypotheses가 GA4 채점을 to_thread로 넘기는지, 메인 루프 스레드 식별로 직접 증명."""
    from app.services import hypothesis_scorer as sc

    main_thread = threading.current_thread()
    seen_threads: list[threading.Thread] = []

    def _fake_score_ga4_outcome(md):
        seen_threads.append(threading.current_thread())
        return {"outcome_status": "hit", "outcome_result": {"actual": 1, "metric": "x", "scored_at": None}}

    hyp = type("H", (), {})()
    hyp.id = "hyp-1"
    hyp.status = "active"
    hyp.metric_definition = {"source": "ga4", "metric": "signups", "target": 1, "direction": "up"}
    hyp.outcome_result = None

    class _FakeSession:
        def begin_nested(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def execute(self, *a, **kw):
            class _R:
                def scalars(self_inner):
                    class _S:
                        def all(self_inner2):
                            return [hyp]
                    return _S()
            return _R()

    async def _async_record(*a, **kw):
        return {"skipped_reason": "no_linked_story", "bet": [], "execution": []}

    async def _async_attribute(*a, **kw):
        return {"skipped_reason": "no_measuring_loop", "attributed": []}

    with patch.object(sc, "score_ga4_outcome", side_effect=_fake_score_ga4_outcome), \
         patch("app.services.hypothesis_outcome_verdict.record_outcome_verdicts", new=_async_record), \
         patch("app.services.loop_outcome_attribution.attribute_loop_outcome", new=_async_attribute):
        await sc.score_hypotheses(_FakeSession())

    assert len(seen_threads) == 1, "score_ga4_outcome이 정확히 1회 호출돼야 한다"
    assert seen_threads[0] is not main_thread, (
        "score_ga4_outcome이 메인 이벤트루프 스레드에서 그대로 실행됨 — "
        "asyncio.to_thread 포장이 빠졌거나 회귀했다(story #2041 재발)"
    )
