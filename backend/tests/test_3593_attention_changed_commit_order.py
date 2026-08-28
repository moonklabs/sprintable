"""story #3180 후속(카디르 QA REQUEST_CHANGES, PR#3593) — attention.changed push가 caller의
commit 前에 나가면, 그 신호로 FE가 즉시 재조회할 때 아직 안 보이는(커밋 前) 상태를 읽는다.
폴백 폴링이 이 실패를 가려 조용히 넘어가던 것이 REQUEST_CHANGES 근거였다(get_db가 커밋을
핸들러 반환 後로 미루는 것 자체는 app/dependencies/database.py::get_db 참조 — 정상 설계이지만
핸들러 본문 안에서 push를 먼저 하면 그 지연 창을 실제로 밟는다).

이 파일은 4개 콜사이트를 commit-then-publish로 정렬한 것을 순서로 직접 pin한다:
  ① routers/dependencies.py — create/update/delete_dependency
  ② routers/goals.py::update_goal(measure_after 재계획)
  ③ routers/hypotheses.py::transition_hypothesis(직접 human 전이 — 유일하게 안전한 콜사이트)
  ④ services/hypothesis_scorer.py::score_hypotheses(더 이상 자체 push 안 함) +
     routers/cron.py::score_hypotheses_cron(호출자가 commit 後 push)

이미 안전했던 3곳(story_status_events·goal_events·agent_auth_failure)은 이 라운드에서
안 건드렸으므로 여기서 재검증하지 않는다(1라운드 테스트가 이미 다룸).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers import dependencies as deps_r
from app.routers import goals as goals_r
from app.routers import hypotheses as hyp_r
from app.schemas.dependency import DependencyCreate, DependencyUpdate
from app.schemas.goal import GoalUpdate
from app.schemas.hypothesis import HypothesisTransition


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _order_tracker():
    """commit/push 호출 순서를 기록하는 공유 리스트 — 두 mock의 side_effect가 여기에 append."""
    order: list[str] = []
    return order


def _auth_ctx(user_id: uuid.UUID) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.claims = {"app_metadata": {}}
    return ctx


# ── ① dependencies.py — create/update/delete ──────────────────────────────────

@pytest.mark.anyio
async def test_create_dependency_commits_before_push():
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    from_id, to_id = uuid.uuid4(), uuid.uuid4()
    order = _order_tracker()

    session = AsyncMock()
    session.commit = AsyncMock(side_effect=lambda: order.append("commit"))

    dep = SimpleNamespace(
        id=uuid.uuid4(), org_id=org_id, from_id=from_id, to_id=to_id,
        dep_type="blocks", item_type="story", created_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
    )
    fake_repo = MagicMock()
    fake_repo.exists = AsyncMock(return_value=False)
    fake_repo.create = AsyncMock(return_value=dep)

    body = DependencyCreate(from_id=from_id, to_id=to_id, dep_type="blocks", item_type="story")

    with patch.object(deps_r, "DependencyRepository", MagicMock(return_value=fake_repo)), \
         patch.object(deps_r, "_assert_item_project_access", AsyncMock()), \
         patch.object(deps_r, "would_create_cycle", AsyncMock(return_value=False)), \
         patch("app.services.trust_pipeline.compute_trust_facts", new=AsyncMock(return_value={"foo": "bar"})), \
         patch("app.services.trust_pipeline.maybe_emit_trust_stage_changed", new=AsyncMock()), \
         patch("app.services.attention_events.notify_attention_changed",
               new=AsyncMock(side_effect=lambda *a, **k: order.append("push"))) as push:
        await deps_r.create_dependency(body, session=session, org_id=org_id, auth=_auth_ctx(user_id))

    assert order == ["commit", "push"]
    push.assert_awaited_once_with(org_id)


@pytest.mark.anyio
async def test_update_dependency_commits_before_push():
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    order = _order_tracker()

    session = AsyncMock()
    session.commit = AsyncMock(side_effect=lambda: order.append("commit"))

    dep = SimpleNamespace(id=uuid.uuid4(), from_id=uuid.uuid4(), to_id=uuid.uuid4(), item_type="story", dep_type="blocks")
    updated = SimpleNamespace(
        id=dep.id, org_id=org_id, from_id=dep.from_id, to_id=dep.to_id, dep_type="depends_on",
        item_type="story", created_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
    )
    fake_repo = MagicMock()
    fake_repo.session = session
    fake_repo.org_id = org_id
    fake_repo.get = AsyncMock(return_value=dep)
    fake_repo.update_dep_type = AsyncMock(return_value=updated)

    body = DependencyUpdate(dep_type="depends_on")  # blocks→depends_on = 해소(old가 blocks라 게이팅 통과)

    with patch.object(deps_r, "_assert_item_project_access", AsyncMock()), \
         patch("app.services.trust_pipeline.compute_trust_facts", new=AsyncMock(return_value={"foo": "bar"})), \
         patch("app.services.trust_pipeline.maybe_emit_trust_stage_changed", new=AsyncMock()), \
         patch("app.services.attention_events.notify_attention_changed",
               new=AsyncMock(side_effect=lambda *a, **k: order.append("push"))) as push:
        await deps_r.update_dependency(dep.id, body, repo=fake_repo, auth=_auth_ctx(user_id))

    assert order == ["commit", "push"]
    push.assert_awaited_once_with(org_id)


@pytest.mark.anyio
async def test_delete_dependency_commits_before_push():
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    order = _order_tracker()

    session = AsyncMock()
    session.commit = AsyncMock(side_effect=lambda: order.append("commit"))

    dep = SimpleNamespace(id=uuid.uuid4(), from_id=uuid.uuid4(), to_id=uuid.uuid4(), item_type="story", dep_type="blocks")
    fake_repo = MagicMock()
    fake_repo.session = session
    fake_repo.org_id = org_id
    fake_repo.get = AsyncMock(return_value=dep)
    fake_repo.delete = AsyncMock(return_value=True)

    with patch.object(deps_r, "_assert_item_project_access", AsyncMock()), \
         patch("app.services.trust_pipeline.compute_trust_facts", new=AsyncMock(return_value={"foo": "bar"})), \
         patch("app.services.trust_pipeline.maybe_emit_trust_stage_changed", new=AsyncMock()), \
         patch("app.services.attention_events.notify_attention_changed",
               new=AsyncMock(side_effect=lambda *a, **k: order.append("push"))) as push:
        await deps_r.delete_dependency(dep.id, repo=fake_repo, auth=_auth_ctx(user_id))

    assert order == ["commit", "push"]
    push.assert_awaited_once_with(org_id)


# ── ② goals.py::update_goal ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_update_goal_measure_after_commits_before_push():
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    project_id = uuid.uuid4()
    order = _order_tracker()

    session = AsyncMock()
    session.commit = AsyncMock(side_effect=lambda: order.append("commit"))

    current = SimpleNamespace(
        id=uuid.uuid4(), project_id=project_id, status="active",
        metric_definition={"metric": "m"}, measure_after=None, outcome_status="n_a",
    )
    from datetime import datetime, timezone
    new_ma = datetime(2026, 12, 1, tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    updated = SimpleNamespace(
        id=current.id, project_id=project_id, org_id=org_id, assignee_id=None,
        title="g", status="active", priority="medium", description=None, objective=None,
        success_criteria=None, target_sp=None, target_date=None, success_hypothesis=None,
        metric_definition={"metric": "m"}, measure_after=new_ma, outcome_status="n_a",
        outcome_result=None, position=None, source_loop_id=None, created_at=now, updated_at=now,
    )

    fake_repo = MagicMock()
    fake_repo.session = session
    fake_repo.org_id = org_id
    fake_repo.get = AsyncMock(return_value=current)
    fake_repo.update = AsyncMock(return_value=updated)

    body = GoalUpdate(measure_after=new_ma)

    with patch.object(goals_r, "require_project_access", AsyncMock()), \
         patch.object(goals_r, "_attach_org_project_slugs", AsyncMock()), \
         patch("app.services.attention_events.notify_attention_changed",
               new=AsyncMock(side_effect=lambda *a, **k: order.append("push"))) as push:
        await goals_r.update_goal(current.id, body, repo=fake_repo, auth=_auth_ctx(user_id))

    assert order == ["commit", "push"]
    push.assert_awaited_once_with(org_id)


@pytest.mark.anyio
async def test_update_goal_without_measure_after_does_not_push():
    """회귀 방지 — measure_after 미포함 PATCH는 여전히 무발화(과다발화 가드 유지 확認)."""
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    project_id = uuid.uuid4()

    session = AsyncMock()
    current = SimpleNamespace(
        id=uuid.uuid4(), project_id=project_id, status="active",
        metric_definition=None, measure_after=None, outcome_status="n_a",
    )
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    updated = SimpleNamespace(
        id=current.id, project_id=project_id, org_id=org_id, assignee_id=None,
        title="new title", status="active", priority="medium", description=None, objective=None,
        success_criteria=None, target_sp=None, target_date=None, success_hypothesis=None,
        metric_definition=None, measure_after=None, outcome_status="n_a",
        outcome_result=None, position=None, source_loop_id=None, created_at=now, updated_at=now,
    )
    fake_repo = MagicMock()
    fake_repo.session = session
    fake_repo.org_id = org_id
    fake_repo.get = AsyncMock(return_value=current)
    fake_repo.update = AsyncMock(return_value=updated)

    body = GoalUpdate(title="new title")

    with patch.object(goals_r, "require_project_access", AsyncMock()), \
         patch.object(goals_r, "_attach_org_project_slugs", AsyncMock()), \
         patch("app.services.attention_events.notify_attention_changed", new=AsyncMock()) as push:
        await goals_r.update_goal(current.id, body, repo=fake_repo, auth=_auth_ctx(user_id))

    push.assert_not_awaited()
    session.commit.assert_not_awaited()  # 이 경로 자체는 여전히 get_db implicit commit에 위임


# ── ③ hypotheses.py::transition_hypothesis(라우터 — 유일하게 안전한 직접 human 전이 콜사이트) ──

@pytest.mark.anyio
async def test_transition_hypothesis_router_commits_before_push():
    org_id = uuid.uuid4()
    hyp_id = uuid.uuid4()
    caller_id = uuid.uuid4()
    order = _order_tracker()

    session = AsyncMock()
    session.commit = AsyncMock(side_effect=lambda: order.append("commit"))

    caller = SimpleNamespace(id=caller_id, user_id=caller_id, name="t", type="human", role="member", org_id=org_id)
    body = HypothesisTransition(status="killed", note="stop")
    canned_result = SimpleNamespace(id=hyp_id, status="killed")

    with patch.object(hyp_r, "_assert_hypothesis_project_access", AsyncMock()), \
         patch.object(hyp_r, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(hyp_r.svc, "transition_hypothesis", AsyncMock(return_value=canned_result)), \
         patch("app.services.attention_events.notify_attention_changed",
               new=AsyncMock(side_effect=lambda *a, **k: order.append("push"))) as push:
        result = await hyp_r.transition_hypothesis(
            hyp_id, body, session=session, auth=_auth_ctx(caller_id), org_id=org_id,
        )

    assert order == ["commit", "push"]
    push.assert_awaited_once_with(org_id)
    assert result is canned_result  # commit-then-publish 재배선이 반환값을 안 바꿈(회귀 없음)


@pytest.mark.anyio
async def test_transition_hypothesis_service_no_longer_pushes_itself():
    """services/hypothesis.py::transition_hypothesis 자체는 이제 push하지 않는다(4개
    콜사이트마다 커밋 시점이 달라 이 공유 함수 안에서 커밋을 강제하면 원자성이 깨짐 —
    gate 해소 등 "이후에도 쓰기가 남은" 호출자를 위한 안전장치). push 책임은 유일하게 안전한
    콜사이트(routers/hypotheses.py의 직접 human transition)로 옮겨졌다."""
    from app.services import hypothesis as hyp_svc
    from app.services.member_resolver import ResolvedMember

    org_id = uuid.uuid4()
    hyp_id = uuid.uuid4()
    caller_id = uuid.uuid4()
    caller = ResolvedMember(id=caller_id, user_id=caller_id, name="t", type="human", role="member", org_id=org_id)

    hyp = SimpleNamespace(id=hyp_id, status="killed", outcome_result=None)
    updated = SimpleNamespace(id=hyp_id, status="active")
    body = HypothesisTransition(status="active")

    fake_repo = MagicMock()
    fake_repo.get = AsyncMock(return_value=SimpleNamespace(id=hyp_id, status="proposed"))
    fake_repo.update = AsyncMock(return_value=updated)

    with patch.object(hyp_svc, "HypothesisRepository", MagicMock(return_value=fake_repo)), \
         patch.object(hyp_svc, "_to_response", AsyncMock(return_value=updated)), \
         patch("app.services.attention_events.notify_attention_changed", new=AsyncMock()) as push:
        await hyp_svc.transition_hypothesis(AsyncMock(), org_id, caller, hyp_id, body, via_gate=True)

    push.assert_not_awaited()


# ── ④ hypothesis_scorer.py::score_hypotheses + cron.py::score_hypotheses_cron ─────────────

@pytest.mark.anyio
async def test_score_hypotheses_does_not_push_but_reports_org_ids():
    """score_hypotheses 자신의 계약("호출자가 commit한다")대로, 여기선 push_to_org_members가
    한 번도 안 불리고 attention_org_ids만 반환한다."""
    from tests.test_hypothesis_scorer import _hyp, _run

    org = uuid.uuid4()
    h = _hyp(status="active", source="ga4", org_id=org)

    # test_hypothesis_scorer.py의 _mock_outcome_verdicts/_mock_loop_attribution(autouse)은 그
    # 파일 안 테스트에만 적용된다 — 여기서 _run()을 임포트해 부르는 경우엔 안 걸리므로 직접 격리.
    with patch("app.services.hypothesis_outcome_verdict.record_outcome_verdicts",
               new=AsyncMock(return_value={"skipped_reason": "no_linked_story", "bet": [], "execution": []})), \
         patch("app.services.loop_outcome_attribution.attribute_loop_outcome",
               new=AsyncMock(return_value={"skipped_reason": "no_measuring_loop", "attributed": []})), \
         patch("app.routers.events.push_to_org_members", new=AsyncMock()) as pub, \
         patch("app.services.attention_events.notify_attention_changed", new=AsyncMock()) as push:
        summary = await _run([h], ga4={"outcome_status": "hit", "outcome_result": {"actual": 1}})

    pub.assert_not_awaited()
    push.assert_not_awaited()
    assert summary["attention_org_ids"] == [str(org)]


@pytest.mark.anyio
async def test_score_hypotheses_cron_commits_before_push():
    from app.routers import cron as cron_r

    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    order = _order_tracker()

    session = AsyncMock()
    session.commit = AsyncMock(side_effect=lambda: order.append("commit"))

    canned_summary = {
        "to_measuring": [], "verified": [], "falsified": [], "pending": [], "failed": [], "total": 0,
        "verdicts_recorded": [], "loops_attributed": [], "verdicts_skipped": [],
        "attention_org_ids": [str(org_a), str(org_b)],
    }
    request = MagicMock()

    pushed: list[str] = []

    async def _fake_notify(org_id):
        order.append("push")
        pushed.append(str(org_id))

    with patch.object(cron_r, "verify_cron", MagicMock()), \
         patch("app.services.hypothesis_scorer.score_hypotheses", new=AsyncMock(return_value=canned_summary)), \
         patch("app.services.attention_events.notify_attention_changed", new=AsyncMock(side_effect=_fake_notify)):
        await cron_r.score_hypotheses_cron(request, session=session)

    # commit이 두 push 모두보다 먼저(순서 리스트 첫 원소) — 그 뒤 org별 1회씩.
    assert order[0] == "commit"
    assert order.count("push") == 2
    assert set(pushed) == {str(org_a), str(org_b)}
