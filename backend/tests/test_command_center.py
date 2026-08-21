"""E-MODERN Track C: 커맨드 센터 CC-BE.1 단위(산티아고 혼합-scope checklist).

커버: /my-actions action_queue(member-private·gate_approval+review_merge·caller member_id) / attention(org
agent_stuck·enum/summary·raw 비노출) scope label 분리 · /overview org(fleet total 실·breakdown pending_data·
epics/outcome/recent 실·risk/cycle/contribution/cost pending_data) · invalid member 400 · mock 0.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_A = uuid.uuid4()
MEMBER = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _r_scalars(rows):
    r = MagicMock()
    r.scalars.return_value.all.return_value = list(rows)
    return r


def _r_scalar(val):
    r = MagicMock()
    r.scalar_one.return_value = val
    return r


def _r_all(rows):
    r = MagicMock()
    r.all.return_value = list(rows)
    return r


def _r_one(tup):
    r = MagicMock()
    r.one.return_value = tup
    return r


async def _get(path, *, execute_seq, member=MEMBER, org=ORG_A, resolve_raises=None):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.main import app as fastapi_app
    from app.routers import command_center as mod

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=list(execute_seq))

    async def override_db():
        yield session

    from tests.conftest import override_db_and_read
    # story #2451(§6 Phase3 root-fix): get_db+get_read_db 항상 같이 거는 공용
    # 헬퍼 — legacy alias(예: /api/v2/epics=goals.router 재마운트) 누락 재발 차단.
    override_db_and_read(fastapi_app, override_db)
    fastapi_app.dependency_overrides[get_verified_org_id] = lambda: org
    # ⭐auth.user_id 를 일부러 member 와 다른 값(=users.id 모사)으로 둬, 엔드포인트가 raw user_id 가 아니라
    # canonical resolve_member 로 member.id 를 쓰는지 증명(HIGH1). resolve_member 는 patch.
    fastapi_app.dependency_overrides[get_current_user] = lambda: MagicMock(user_id=str(uuid.uuid4()))
    if resolve_raises is not None:
        resolver = AsyncMock(side_effect=resolve_raises)
    else:
        resolver = AsyncMock(return_value=MagicMock(id=member))
    try:
        with patch.object(mod, "resolve_member", new=resolver):
            async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://test") as c:
                resp = await c.get(path)
        return resp, session, resolver
    finally:
        fastapi_app.dependency_overrides.clear()


def _data(resp):
    body = resp.json()
    return body.get("data", body) if isinstance(body, dict) else {}


# my-actions 쿼리 순서: approvals(.all, gate_type 조인) → [approval_group_counts, approvals
# 비어있지 않을 때만·명세2 무게] → reviews → my_tasks(명세1, 항상 실행) → my_blockers(.all) →
# [blocker_weight_counts, my_blockers 비어있지 않을 때만·명세2 무게] → waiting_on_others(.all) →
# agent_stuck → stalled(.all) → unanswered(.all).
# ⛔approvals는 story #2288 BE 명세3(gate_type 패스스루)로 WorkflowLineStepRun과 조인해 이제
# (approval, gate_type) 튜플을 낸다 — 단일 ORM 엔티티가 아니므로 scalars() 대신 .all().
# ⛔명세2(무게) 배치 쿼리 둘은 **조건부**(원본 리스트가 비면 DB 왕복 자체를 스킵) — 그래서
# 이 헬퍼도 고정 리스트가 아니라 그 조건을 그대로 반영해 순서를 조립한다(안 그러면 approvals/
# my_blockers를 채운 테스트만 다음 호출들이 전부 밀려 엉뚱한 mock을 받는다).
def _ma_seq(
    approvals=(), reviews=(), my_blockers=(), waiting=(), stuck=(), stalled=(), unanswered=(),
    my_tasks=(), approval_group_counts=(), blocker_weight_counts=(), falsified=(),
    overdue_hyps=(), overdue_goals=(), done_no_outcome_goals=(), measure_plan_missing_goal_count=0,
    loop_overdue_hypothesis_count=None, loop_overdue_goal_count=None, loop_outcome_missing_goal_count=None,
    unmeasurable_goal_count=0, project_slugs=(), auth_failures=(),
):
    seq = [_r_all(approvals)]
    if approvals:
        seq.append(_r_all(approval_group_counts))
    seq.append(_r_scalars(reviews))
    seq.append(_r_all(my_tasks))
    seq.append(_r_all(my_blockers))
    if my_blockers:
        seq.append(_r_all(blocker_weight_counts))
    seq.append(_r_all(waiting))
    seq.append(_r_scalars(stuck))
    # story #2836 — 에이전트 401 연속 windowed-COUNT(agent_stuck 바로 뒤·stalled 前).
    seq.append(_r_all(auth_failures))
    seq.append(_r_all(stalled))
    seq.append(_r_all(unanswered))
    seq.append(_r_all(falsified))  # story #2539
    # story #2829(loop-closure P0) — 「닫히지 않은 루프」 3쿼리 + 미설정 goal 카운트 1쿼리 +
    # PO 리뷰 보완①(#3253) 류별 total count 3쿼리(items[]와 별개로 항상 참값).
    seq.append(_r_all(overdue_hyps))
    seq.append(_r_all(overdue_goals))
    seq.append(_r_all(done_no_outcome_goals))
    seq.append(_r_scalar(measure_plan_missing_goal_count))
    seq.append(_r_scalar(
        loop_overdue_hypothesis_count if loop_overdue_hypothesis_count is not None else len(overdue_hyps)
    ))
    seq.append(_r_scalar(
        loop_overdue_goal_count if loop_overdue_goal_count is not None else len(overdue_goals)
    ))
    seq.append(_r_scalar(
        loop_outcome_missing_goal_count if loop_outcome_missing_goal_count is not None else len(done_no_outcome_goals)
    ))
    # story #2843(PO AC②) — unmeasurable_goal_count 스칼라 신설(#3262 CI 판독·Pedro 처방).
    seq.append(_r_scalar(unmeasurable_goal_count))
    # 0b17472c — attention.items[] project_slug 배치 조회. resolve_project_slugs는 project_id
    # 집합이 비면 DB 왕복 자체를 스킵(조기 return) — stalled/unanswered/falsified/overdue_*/
    # done_no_outcome_goals 중 하나라도 있어야(그 항목들에 project_id가 실려 있어야) 이 쿼리가
    # 발생한다(approval_group_counts/blocker_weight_counts와 동형 조건부 패턴). command_center.py
    # 실 순서상 unmeasurable_goal_count(#2843) 스칼라 뒤에 이 배치가 온다(rebase 시 확認).
    if stalled or unanswered or falsified or overdue_hyps or overdue_goals or done_no_outcome_goals:
        seq.append(_r_all(project_slugs))
    return seq


_DT = datetime(2026, 6, 23, tzinfo=timezone.utc)
_OLD = datetime(2026, 6, 1, tzinfo=timezone.utc)  # 충분히 과거(정체/age 판정용).


# ── /my-actions ─────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_my_actions_scope_separation_and_items():
    approval = MagicMock(gate_id=uuid.uuid4(), approval_group_id=uuid.uuid4(), kind="approver", created_at=_DT)
    review = MagicMock(id=uuid.uuid4(), title="Ship login", status="in-review", updated_at=_DT)
    stuck = MagicMock(entity_type="story", entity_id=uuid.uuid4(), effective_gate_type="merge",
                      started_at=_DT, failure_message="SECRET raw error")
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(approvals=[(approval, "merge")], reviews=[review], stuck=[stuck]))
    assert resp.status_code == 200
    d = _data(resp)
    assert d["action_queue"]["scope"] == "member"      # ⭐member-private.
    assert d["attention"]["scope"] == "org"            # ⭐org.
    assert {i["type"] for i in d["action_queue"]["items"]} == {"gate_approval", "review_merge"}
    assert d["attention"]["items"][0]["type"] == "agent_stuck" and d["attention"]["items"][0]["auto_detected"]
    assert "SECRET raw error" not in resp.text          # ⭐민감 텍스트 비노출.
    assert d["attention"]["pending"] == ["time_sensitive"]  # CC-BE.2서 나머지 채움(my_blockers→큐로 이동).


# ── story #2288(E-CONNECT) BE 명세3+4 ────────────────────────────────────────
@pytest.mark.anyio
async def test_gate_approval_carries_gate_type_passthrough():
    """BE 명세3(§3-1㉢·§4-1): gate_approval 항목의 context에 gate_type이 WorkflowLineStepRun.
    effective_gate_type 그대로 실린다(값을 새로 만들지 않고 기존 SSOT를 조인해 패스스루)."""
    approval = MagicMock(gate_id=uuid.uuid4(), approval_group_id=uuid.uuid4(), kind="approver", created_at=_DT)
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(approvals=[(approval, "merge")]))
    assert resp.status_code == 200
    items = _data(resp)["action_queue"]["items"]
    ga = next(i for i in items if i["type"] == "gate_approval")
    assert ga["context"]["gate_type"] == "merge"


@pytest.mark.anyio
async def test_gate_approval_gate_type_null_when_run_has_none():
    approval = MagicMock(gate_id=uuid.uuid4(), approval_group_id=uuid.uuid4(), kind="approver", created_at=_DT)
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(approvals=[(approval, None)]))
    assert resp.status_code == 200
    items = _data(resp)["action_queue"]["items"]
    ga = next(i for i in items if i["type"] == "gate_approval")
    assert ga["context"]["gate_type"] is None


@pytest.mark.anyio
async def test_waiting_on_others_item_shape_and_priority():
    """BE 명세4: 내 담당 story인데 승인 대기가 남에게 있으면 waiting_on_others(§3-1㉢) —
    priority=info(danger/warn류 행동촉구 축과 안 섞는다, 버튼 없는 자리)."""
    story_id = uuid.uuid4()
    approver_id = uuid.uuid4()
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(waiting=[(story_id, "merge", approver_id)]))
    assert resp.status_code == 200
    items = _data(resp)["action_queue"]["items"]
    w = next(i for i in items if i["type"] == "waiting_on_others")
    assert w["priority"] == "info"
    assert w["context"] == {
        "story_id": str(story_id), "gate_type": "merge", "approver_member_id": str(approver_id),
    }


@pytest.mark.anyio
async def test_waiting_on_others_dedupes_multi_approver_story_to_one_item():
    """한 story에 승인자가 여럿(quorum)이어도 waiting_on_others는 story당 한 항목만."""
    story_id = uuid.uuid4()
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(waiting=[
            (story_id, "merge", uuid.uuid4()),
            (story_id, "merge", uuid.uuid4()),
        ]),
    )
    assert resp.status_code == 200
    items = [i for i in _data(resp)["action_queue"]["items"] if i["type"] == "waiting_on_others"]
    assert len(items) == 1


@pytest.mark.anyio
async def test_waiting_on_others_query_scopes_by_assignee_and_excludes_self_as_approver():
    """⛔뮤테이션 자가검증 축 대신 쿼리 자체를 직접 읽어 확인(모킹 세션이라 SQL 실행은 못함) —
    approver_member_id != member_id 조건과 assignee_id == member_id 조건이 둘 다 WHERE에
    있는지 확인한다. 순서: approvals(0)·reviews(1)·my_tasks(2)·my_blockers(3)·waiting(4)
    — story #2288 BE 명세1(my_tasks)이 my_blockers 앞에 삽입되며 인덱스가 밀렸다."""
    resp, session, resolver = await _get("/api/v2/command-center/my-actions", execute_seq=_ma_seq())
    assert resp.status_code == 200
    waiting_call_sql = str(session.execute.await_args_list[4].args[0])
    assert "assignee_id" in waiting_call_sql
    assert "approver_member_id" in waiting_call_sql


@pytest.mark.anyio
async def test_my_actions_my_blockers_member_private():
    """CC-BE.2: 내가 풀 블로커(내 담당이 막은 open 스토리)가 action_queue(member-private·danger)에."""
    blocker_id, blocked_id = uuid.uuid4(), uuid.uuid4()
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(my_blockers=[(blocker_id, blocked_id)]))
    assert resp.status_code == 200
    items = _data(resp)["action_queue"]["items"]
    mb = [i for i in items if i["type"] == "my_blockers"]
    assert len(mb) == 1 and mb[0]["priority"] == "danger"
    assert mb[0]["context"]["blocked_story_id"] == str(blocked_id)


@pytest.mark.anyio
async def test_my_actions_stalled_and_unanswered_blocker_enum_only():
    """CC-BE.2 이상감지: story_stalled + unanswered_blocker(org attention·enum/ids/age·raw text 0).

    story #2538: title 추가(FE "제목+N일" 구별용) — 가설과 무관한 카피 오라벨링 정정의
    전제 데이터."""
    sid, blocker_id, blocked_id, pid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(
            stalled=[(sid, _OLD, "정체된 스토리", pid)],
            unanswered=[(blocker_id, blocked_id, _OLD, "막힌 스토리", pid)],
            project_slugs=[(pid, "acme")],
        ))
    assert resp.status_code == 200
    types = {i["type"] for i in _data(resp)["attention"]["items"]}
    assert {"story_stalled", "unanswered_blocker"} <= types
    items = _data(resp)["attention"]["items"]
    stalled_item = next(i for i in items if i["type"] == "story_stalled")
    assert stalled_item["story_id"] == str(sid) and isinstance(stalled_item["stalled_days"], int)
    assert stalled_item["title"] == "정체된 스토리"
    # 0b17472c — project_id/project_slug 배치 부착 확認.
    assert stalled_item["project_id"] == str(pid)
    assert stalled_item["project_slug"] == "acme"
    ub = next(i for i in items if i["type"] == "unanswered_blocker")
    assert ub["blocked_story_title"] == "막힌 스토리"
    assert ub["blocked_story_id"] == str(blocked_id) and isinstance(ub["age_days"], int)
    assert ub["project_id"] == str(pid)
    assert ub["project_slug"] == "acme"


@pytest.mark.anyio
async def test_my_actions_hypothesis_falsified_result_notification():
    """story #2539: 최근 falsified 가설 결과 통보(in-flight 이상감지 아님 — severity=info,
    story_stalled/unanswered_blocker의 severity=warn과 의도적으로 다름)."""
    hyp_id, succ_id, pid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    outcome = {"metric": "signups", "target": 100, "actual": 42, "direction": "increase"}
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(
            falsified=[(hyp_id, "체크아웃 2단계면 가입 늘 것", outcome, _OLD, succ_id, pid)],
            project_slugs=[(pid, "acme")],
        ))
    assert resp.status_code == 200
    items = _data(resp)["attention"]["items"]
    hf = next(i for i in items if i["type"] == "hypothesis_falsified")
    assert hf["severity"] == "info"
    assert hf["hypothesis_id"] == str(hyp_id)
    assert hf["statement"] == "체크아웃 2단계면 가입 늘 것"
    assert hf["outcome_result"] == outcome
    assert isinstance(hf["falsified_days"], int)
    assert hf["superseded_by_hypothesis_id"] == str(succ_id)


@pytest.mark.anyio
async def test_my_actions_hypothesis_falsified_superseded_by_null_when_unconfirmed():
    """AC — 확認된 대체 페어 없으면 superseded_by_hypothesis_id는 None(지어내지 않는다)."""
    hyp_id, pid = uuid.uuid4(), uuid.uuid4()
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(
            falsified=[(hyp_id, "S", None, _OLD, None, pid)],
            project_slugs=[(pid, "acme")],
        ))
    assert resp.status_code == 200
    items = _data(resp)["attention"]["items"]
    hf = next(i for i in items if i["type"] == "hypothesis_falsified")
    assert hf["superseded_by_hypothesis_id"] is None
    assert hf["outcome_result"] is None


@pytest.mark.anyio
async def test_my_actions_loop_closure_items_and_measure_plan_missing_count():
    """story #2829: 「닫히지 않은 루프」 3타입(가설 도과·goal 도과·outcome 없는 done)이
    attention.items[]에 실리고, 측정계획 없는 active goal 수는 N에서 제외된 채 별도 스칼라
    필드로만 실린다(doc a8e73bdb §2 PO 확定 — 페드루 보완 지시)."""
    hyp_id, goal_id, done_goal_id, owner_id, pid = (
        uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    )
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(
            overdue_hyps=[(hyp_id, "체크아웃 개선 가설", _OLD, owner_id, pid)],
            overdue_goals=[(goal_id, "Q3 활성화", _OLD, owner_id, pid)],
            done_no_outcome_goals=[(done_goal_id, "런칭", _OLD, owner_id, pid)],
            measure_plan_missing_goal_count=40,
            # PO 리뷰 보완①(#3253) — items[]는 top-20 cap(위 각 1건뿐)인데 total count는
            # 참값(51)이어야 한다는 게 이 보완의 핵심 — 일부러 items 길이와 다르게 준다.
            loop_outcome_missing_goal_count=51,
            # story #2843(PO AC②) — unmeasurable(명시 선언)은 N에서 제외·별도 스칼라만.
            unmeasurable_goal_count=7,
            project_slugs=[(pid, "acme")],
        ))
    assert resp.status_code == 200
    body = _data(resp)
    items_by_type = {i["type"]: i for i in body["attention"]["items"]}
    oh = items_by_type["loop_overdue_hypothesis"]
    assert oh["hypothesis_id"] == str(hyp_id) and oh["owner_member_id"] == str(owner_id)
    assert oh["project_id"] == str(pid) and oh["project_slug"] == "acme"
    og = items_by_type["loop_overdue_goal"]
    assert og["goal_id"] == str(goal_id) and isinstance(og["overdue_days"], int)
    om = items_by_type["loop_outcome_missing_goal"]
    assert om["goal_id"] == str(done_goal_id) and isinstance(om["done_days"], int)
    # N(=items 카운트)에 measure_plan_missing 3건은 포함 안 됨(위 3개뿐) — 별도 스칼라만.
    assert body["attention"]["measure_plan_missing_goal_count"] == 40
    # PO 리뷰 보완① 핵심 단정 — items[]는 1건뿐이어도 total count는 51(cap과 무관한 참값).
    assert body["attention"]["loop_outcome_missing_goal_count"] == 51
    assert body["attention"]["loop_overdue_hypothesis_count"] == 1
    assert body["attention"]["loop_overdue_goal_count"] == 1
    assert body["attention"]["unmeasurable_goal_count"] == 7


@pytest.mark.anyio
async def test_my_actions_agent_auth_failure_item_shape():
    """story #2836 — 임계 도달한 에이전트 401 연속이 attention.items[]에 실린다. reason은
    서버가 아는 사실(④)만 — raw key 값은 이 응답 어디에도 없다(⑤, key_prefix조차 이 엔드포인트
    응답엔 안 실림 — command_center.py는 member_id/reason/count/시각만 노출)."""
    member_id = uuid.uuid4()
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(auth_failures=[(member_id, "revoked", 5, _OLD, _DT)]))
    assert resp.status_code == 200
    items = _data(resp)["attention"]["items"]
    af = next(i for i in items if i["type"] == "agent_auth_failure")
    assert af["member_id"] == str(member_id)
    assert af["reason"] == "revoked"
    assert af["failure_count"] == 5
    assert af["severity"] == "danger" and af["auto_detected"] is True


@pytest.mark.anyio
async def test_my_actions_uses_canonical_member_resolver():
    """HIGH1: auth.user_id(=users.id 모사·member 와 다름) 직사용 금지 → resolve_member 로 member.id 해소."""
    resp, session, resolver = await _get("/api/v2/command-center/my-actions", execute_seq=_ma_seq())
    assert resp.status_code == 200
    resolver.assert_awaited_once()


@pytest.mark.anyio
async def test_my_actions_agent_stuck_filters_to_agent():
    """HIGH2: agent_stuck 쿼리(story #2288 BE 명세1 my_tasks 삽입으로 6번째 execute로
    다시 밀림 — approvals(0)·reviews(1)·my_tasks(2)·my_blockers(3)·waiting(4)·stuck(5))가
    resolved_member_type=='agent' 로 필터."""
    resp, session, resolver = await _get("/api/v2/command-center/my-actions", execute_seq=_ma_seq())
    assert resp.status_code == 200
    assert "resolved_member_type" in str(session.execute.await_args_list[5].args[0])


@pytest.mark.anyio
async def test_my_actions_clear_state():
    resp, session, resolver = await _get("/api/v2/command-center/my-actions", execute_seq=_ma_seq())
    assert resp.status_code == 200
    assert _data(resp)["is_clear"] is True


@pytest.mark.anyio
async def test_my_actions_resolver_failure_propagates():
    """member resolve 실패 → resolve_member 가 raise → 큐 쿼리 0."""
    from fastapi import HTTPException
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions", execute_seq=[],
        resolve_raises=HTTPException(status_code=400, detail="member not found"))
    assert resp.status_code == 400
    session.execute.assert_not_awaited()


# ── story #2288(E-CONNECT) BE 명세1(태스크 줄)·명세2(무게)·명세5(담당 판정 확장) ──────────
@pytest.mark.anyio
async def test_my_task_item_from_incomplete_assigned_task():
    """BE 명세1(§1-1): 담당 미완료 Task가 my_task 항목으로 뜬다 — 스토리는 소속 표시만
    (별도 review_merge/story 항목으로 중복 안 남)."""
    story_id = uuid.uuid4()
    task = MagicMock(id=uuid.uuid4(), story_id=story_id, title="구현 마무리", updated_at=_DT)
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(my_tasks=[(task, "부모 스토리 제목")]))
    assert resp.status_code == 200
    items = _data(resp)["action_queue"]["items"]
    mt = next(i for i in items if i["type"] == "my_task")
    assert mt["title"] == "구현 마무리"
    assert mt["context"] == {
        "task_id": str(task.id), "story_id": str(story_id), "story_title": "부모 스토리 제목",
    }


@pytest.mark.anyio
async def test_gate_approval_waiting_count_excludes_self():
    """BE 명세2(§2③, 무게): 같은 approval_group에 총 3명 pending이면 waiting_count=2(나 제외)."""
    approval = MagicMock(gate_id=uuid.uuid4(), approval_group_id=uuid.uuid4(), kind="approver", created_at=_DT)
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(
            approvals=[(approval, "merge")],
            approval_group_counts=[(approval.approval_group_id, 3)],
        ),
    )
    assert resp.status_code == 200
    items = _data(resp)["action_queue"]["items"]
    ga = next(i for i in items if i["type"] == "gate_approval")
    assert ga["context"]["waiting_count_approx"] == 2


@pytest.mark.anyio
async def test_my_blockers_waiting_count_reflects_total_blocked():
    """BE 명세2(§2③, 무게): 이 blocker가 총 3개 open story를 막고 있으면 waiting_count=3."""
    blocker_id, blocked_id = uuid.uuid4(), uuid.uuid4()
    resp, session, resolver = await _get(
        "/api/v2/command-center/my-actions",
        execute_seq=_ma_seq(
            my_blockers=[(blocker_id, blocked_id)],
            blocker_weight_counts=[(blocker_id, 3)],
        ),
    )
    assert resp.status_code == 200
    items = _data(resp)["action_queue"]["items"]
    mb = next(i for i in items if i["type"] == "my_blockers")
    assert mb["context"]["waiting_count_approx"] == 3


@pytest.mark.anyio
async def test_review_merge_excludes_blocked_by_open_dependency_query_shape():
    """BE 명세5: review_merge 쿼리가 status!=done으로 넓어지고, 아직 안 풀린 blocks
    의존성이 있는 story는 제외하는 EXISTS 서브쿼리를 갖는지 SQL 문자열로 확인
    (모킹 세션이라 실행 결과는 test_2288 realdb가 증명 — 여긴 쿼리 shape만)."""
    resp, session, resolver = await _get("/api/v2/command-center/my-actions", execute_seq=_ma_seq())
    assert resp.status_code == 200
    reviews_sql = str(session.execute.await_args_list[1].args[0])
    assert "status" in reviews_sql
    assert "EXISTS" in reviews_sql.upper()


# ── /overview ─────────────────────────────────────────────────────────────────
# 쿼리 순서: total_agents→epic_rows→epics→hypothesis→events→contribution→cycle→cost→blocked→failed→fleet.
def _ov_seq(*, total_agents=0, epic_rows=(), epics=(), hyp=(0, 0), events=(),
            contrib=(), cycle=(None, 0), cost=(), blocked=0, failed=0, fleet=()):
    return [
        _r_scalar(total_agents), _r_all(epic_rows), _r_scalars(epics), _r_one(hyp),
        _r_scalars(events), _r_all(contrib), _r_one(cycle), _r_all(cost),
        _r_scalar(blocked), _r_scalar(failed), _r_all(fleet),
    ]


@pytest.mark.anyio
async def test_overview_real_aggregations():
    from datetime import date
    epic_id = uuid.uuid4()
    epic = MagicMock(id=epic_id, title="Auth epic", status="active")
    ev = MagicMock(verb="story.status_changed", object_type="story", object_id=uuid.uuid4(), occurred_at=_DT)
    resp, session, resolver = await _get(
        "/api/v2/command-center/overview",
        execute_seq=_ov_seq(
            total_agents=4, epic_rows=[(epic_id, 5, 2)], epics=[epic], hyp=(10, 3), events=[ev],
            contrib=[("agent", 7), ("human", 3), (None, 2)],
            cycle=(172800.0, 4),  # 2.0 days avg, sample 4
            cost=[(date(2026, 6, 23), 1.5, 1000)],
            blocked=2, failed=1, fleet=[("online", 3, 2), ("offline", 1, 0)],
        ),
    )
    assert resp.status_code == 200
    d = _data(resp)
    ps = d["project_status"]
    assert d["fleet"]["total_agents"] == 4
    assert d["fleet"]["status_breakdown"] == {"online": 3, "offline": 1, "working": 2}  # CC-BE.2 실.
    assert ps["epics"][0]["completion_pct"] == 40
    assert ps["outcome"] == {"hit": 3, "total": 10}
    assert ps["contribution"] == {"agent": 7, "human": 3, "unassigned": 2}  # aggregate(개인 0).
    assert ps["cycle_time"] == {"avg_days": 2.0, "sample": 4}
    assert ps["cost_trend"]["total_cost_usd"] == 1.5 and len(ps["cost_trend"]["points"]) == 1
    assert ps["risk"] == {"blocked": 2, "failed_runs": 1, "overdue": {"status": "pending_data"}}


@pytest.mark.anyio
async def test_overview_recent_changes_excludes_conversation():
    """recent_changes allowlist: conversation.* 등 저신호 제외·의미 verb 만(unknown 기본 제외)."""
    convo = MagicMock(verb="conversation.message_created", object_type="conversation",
                      object_id=uuid.uuid4(), occurred_at=_DT)
    story = MagicMock(verb="story.status_changed", object_type="story", object_id=uuid.uuid4(), occurred_at=_DT)
    unknown = MagicMock(verb="presence.tick", object_type=None, object_id=None, occurred_at=_DT)
    resp, session, resolver = await _get(
        "/api/v2/command-center/overview", execute_seq=_ov_seq(events=[convo, story, unknown]))
    assert resp.status_code == 200
    verbs = [r["verb"] for r in _data(resp)["project_status"]["recent_changes"]]
    assert verbs == ["story.status_changed"]  # conversation.*·presence.* 제외.


@pytest.mark.anyio
async def test_overview_cost_trend_empty_honest_and_cycle_null():
    """소스 없을 때: cost_trend=honest empty(가짜 0 아님)·cycle_time avg null·mock 0."""
    resp, session, resolver = await _get(
        "/api/v2/command-center/overview", execute_seq=_ov_seq(cost=[], cycle=(None, 0)))
    assert resp.status_code == 200
    ps = _data(resp)["project_status"]
    assert ps["cost_trend"] == {"points": [], "total_cost_usd": 0, "delta_pct": None}
    assert ps["cycle_time"] == {"avg_days": None, "sample": 0}
    # 신규 집계가 mock 가짜 수치를 내지 않음(빈 소스=정직한 empty/null).
