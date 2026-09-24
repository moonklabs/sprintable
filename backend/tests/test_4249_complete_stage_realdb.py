"""story #4249 — 사람이 워크플로 stage를 끝내는 행동(`POST /events/definitions/{id}/complete-stage`).

- AC1: 사람을 모든 역할에 묶은 두 단계 워크플로(two_step 모양)를 **화면 행동만으로** 처음부터 마지막 stage까지 진행한다 — 각 완료가 다음
  stage 이벤트를 요청자(사람) 명의로 낸다.
- AC2: 에이전트 발행과 같은 코어(스키마 · 게이트 훅)를 탄다 · 남의 stage는 못 끝낸다(403) · 지금 stage가 아니면 409 · 겹친 두 클릭은
  하나만 성공 · 게이트 있는 stage · 입력이 필요한 다음 stage · 마지막 stage는 이 행동 대상이 아니다.
- start-candidates가 지금 stage 담당(`current_bound_member_id`)과 완료 방식(`current_completion`)을 알려 준다.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import select

from tests.test_3312_approve_stage_gate_auto_creation import _fake_request, _seed_story
from tests.test_3475_publishing_metrics import _seed_human
from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _seed_org, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_STAGES = ["assign_step_1", "submit_step_1", "review_step_2"]  # 0260 two_step과 같은 배치
_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": _STAGES},
        "work_item_type": {"type": "string"}, "work_item_id": {"type": "string", "format": "uuid"},
    },
}
_ROUTING = {"broadcast": {"kind": "recipe_role_binding"}, "escalation": {"kind": "server_derived", "target": "none"}}
_META = {
    "assign_step_1": {"role": "Maker", "action": "배정"},
    "submit_step_1": {"role": "Maker", "action": "제출"},
    "review_step_2": {"role": "Reviewer", "action": "검토"},
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext

    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))


async def _world(Session, *, stage_metadata=None, stages=None):
    from app.models.event_definition import EventDefinition
    from app.models.project import OrgMember
    from app.models.recipe_role_binding import RecipeRoleBinding

    stages = stages or _STAGES
    schema = {**_SCHEMA, "properties": {**_SCHEMA["properties"], "stage": {"type": "string", "enum": stages}}}
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        me_user = await _seed_human(s, org_id, role="owner")
        other_user = await _seed_human(s, org_id, role="owner")
        me = (await s.execute(select(OrgMember.id).where(OrgMember.user_id == me_user))).scalar_one()
        other = (await s.execute(select(OrgMember.id).where(OrgMember.user_id == other_user))).scalar_one()
        agent = await _seed_agent(s, org_id, project_id)
        story_id = await _seed_story(s, org_id, project_id)
        definition = EventDefinition(
            id=uuid.uuid4(), key=f"org.t4249{uuid.uuid4().hex[:6]}.two_step", org_id=org_id, name="두 단계",
            payload_schema=schema, routing=_ROUTING, stage_metadata=stage_metadata or _META,
        )
        s.add(definition)
        for stage in stages:
            s.add(RecipeRoleBinding(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, event_definition_key=definition.key,
                stage=stage, agent_member_id=me,
            ))
        await s.commit()
    return {
        "org_id": org_id, "project_id": project_id, "me_user": me_user, "me": me, "other_user": other_user,
        "other": other, "agent": agent, "story_id": story_id, "definition": definition,
    }


async def _start(Session, w):
    """레시피 시작(첫 stage) — 스토리 «레시피 시작» 버튼과 같은 원시 발행을 사람 명의로."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    async with Session() as s:
        await publish_registry_event(
            EventPublishRequest(definition_key=w["definition"].key, payload={
                "stage": w["definition"].payload_schema["properties"]["stage"]["enum"][0],
                "work_item_type": "story", "work_item_id": str(w["story_id"]),
            }),
            BackgroundTasks(), _fake_request(), db=s, auth=_human_auth(w["me_user"], w["org_id"]), org_id=w["org_id"],
        )
        await s.commit()


async def _complete(Session, w, stage: str, *, user=None):
    from app.routers.events import CompleteStageRequest, complete_recipe_stage

    async with Session() as s:
        result = await complete_recipe_stage(
            w["definition"].id,
            CompleteStageRequest(project_id=w["project_id"], work_item_type="story", work_item_id=w["story_id"], stage=stage),
            BackgroundTasks(), _fake_request(), db=s, auth=_human_auth(user or w["me_user"], w["org_id"]), org_id=w["org_id"],
        )
        await s.commit()
        return result


async def _stage_sender(Session, w, stage: str):
    from app.routers.events import _find_existing_stage_publish

    async with Session() as s:
        msg = await _find_existing_stage_publish(
            s, org_id=w["org_id"], definition_key=w["definition"].key, work_item_type="story",
            work_item_id=str(w["story_id"]), stage=stage,
        )
        return msg.sender_id if msg else None


async def _candidate(Session, w):
    from app.routers.events import get_recipe_start_candidates

    async with Session() as s:
        resp = await get_recipe_start_candidates(
            w["project_id"], work_item_type="story", work_item_id=w["story_id"], db=s,
            auth=_human_auth(w["me_user"], w["org_id"]), org_id=w["org_id"],
        )
    return next(c for c in resp.candidates if c.key == w["definition"].key)


@pytest.mark.anyio
async def test_a_person_runs_the_whole_workflow_from_the_screen_action_alone():
    """AC1 — 시작 → 완료 → 완료 → 마지막 stage(완료 행동 없음). 각 다음 stage 이벤트의 발신자는 사람이다."""
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _start(Session, w)
        c = await _candidate(Session, w)
        assert (c.current_stage, c.current_bound_member_id, c.current_completion) == ("assign_step_1", str(w["me"]), "complete")

        r1 = await _complete(Session, w, "assign_step_1")
        assert (r1["completed_stage"], r1["next_stage"]) == ("assign_step_1", "submit_step_1")
        r2 = await _complete(Session, w, "submit_step_1")
        assert r2["next_stage"] == "review_step_2"
        for stage in _STAGES:
            assert await _stage_sender(Session, w, stage) == w["me"], stage
        # 유나 design ⑥ — 카드가 담당에게만 «스토리 보기»를 그리도록 발행 시점의 stage 담당이 refs에 실린다.
        from app.routers.events import _find_existing_stage_publish

        async with Session() as s:
            msg = await _find_existing_stage_publish(
                s, org_id=w["org_id"], definition_key=w["definition"].key, work_item_type="story",
                work_item_id=str(w["story_id"]), stage="submit_step_1",
            )
        assert msg.msg_metadata["event"]["refs"]["stage_assignee"] == str(w["me"])
        # PO 4623 리뷰 — 카드 링크가 «항목 자기 프로젝트»를 싣도록 이벤트 refs에 작업 항목의 프로젝트.
        assert msg.msg_metadata["event"]["refs"]["project_id"] == str(w["project_id"])

        c = await _candidate(Session, w)
        assert (c.current_stage, c.current_completion) == ("review_step_2", "last_stage")
        with pytest.raises(HTTPException) as info:
            await _complete(Session, w, "review_step_2")
        assert info.value.status_code == 409 and info.value.detail["mode"] == "last_stage"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_only_the_assigned_member_can_complete_and_only_the_current_stage():
    """AC2 — 남의 stage(바인딩이 다른 사람) → 403 · 지금 stage가 아닌 stage → 409 · 아무것도 발행되지 않는다."""
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _start(Session, w)
        with pytest.raises(HTTPException) as info:
            await _complete(Session, w, "assign_step_1", user=w["other_user"])
        assert info.value.status_code == 403 and info.value.detail["code"] == "NOT_STAGE_ASSIGNEE"
        with pytest.raises(HTTPException) as info:
            await _complete(Session, w, "submit_step_1")
        assert info.value.status_code == 409 and info.value.detail["code"] == "STAGE_NOT_CURRENT"
        assert info.value.detail["current_stage"] == "assign_step_1"
        assert await _stage_sender(Session, w, "submit_step_1") is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_two_overlapping_clicks_publish_the_next_stage_once():
    """AC2 — 같은 stage 완료 두 번이 겹쳐도(advisory lock) 다음 stage는 한 번 · 뒤 요청은 «지금 stage가 아님»."""
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _start(Session, w)
        results = await asyncio.gather(
            _complete(Session, w, "assign_step_1"), _complete(Session, w, "assign_step_1"), return_exceptions=True,
        )
        ok = [r for r in results if isinstance(r, dict)]
        refused = [r for r in results if isinstance(r, HTTPException)]
        assert len(ok) == 1 and len(refused) == 1, results
        assert refused[0].detail["code"] == "STAGE_NOT_CURRENT"

        from app.models.conversation import ConversationMessage
        from sqlalchemy import text

        async with Session() as s:
            count = (await s.execute(
                select(ConversationMessage.id).where(
                    text("conversation_messages.metadata->'event'->>'event_key' = :k"),
                    text("conversation_messages.metadata->'event'->'payload'->>'stage' = 'submit_step_1'"),
                ).params(k=w["definition"].key)
            )).scalars().all()
        assert len(count) == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gated_stage_and_stage_needing_fields_are_not_completable_by_this_action():
    """게이트 있는 stage는 결재함 승인이 사람 몫(`gate_approval`) · 다음 stage가 봉인 필드를 요구하면 `needs_fields`(422) —
    둘 다 이 행동으로는 안 끝난다(발행 0)."""
    engine, Session = await _session_factory()
    try:
        meta = {
            "draft": {"role": "Maker", "action": "초안"},
            "review": {"role": "Maker", "action": "검토", "gate": {"type": "concept_approval", "approver": "org_owner"}},
            "budget": {"role": "Maker", "action": "예산", "gate": {"type": "generation_budget", "approver": "org_owner"}},
        }
        w = await _world(Session, stage_metadata=meta, stages=["draft", "review", "budget"])
        # 봉인 필드(estimated_cost_minor)를 받을 수 있게 스키마를 연다.
        from app.models.event_definition import EventDefinition

        async with Session() as s:
            d = await s.get(EventDefinition, w["definition"].id)
            d.payload_schema = {**d.payload_schema, "properties": {**d.payload_schema["properties"], "estimated_cost_minor": {"type": "integer"}}}
            await s.commit()
            w["definition"] = d

        await _start(Session, w)
        r = await _complete(Session, w, "draft")  # draft → review(게이트 · 봉인 필드 없음) — 게이트가 열린다
        assert r["next_stage"] == "review"
        with pytest.raises(HTTPException) as info:
            await _complete(Session, w, "review")
        assert info.value.status_code == 409 and info.value.detail["mode"] == "gate_approval"
        assert await _stage_sender(Session, w, "budget") is None

        from app.services.recipe_stage_completion import completion_mode

        # review가 게이트가 아니라면 다음 stage(budget)의 봉인 필드 때문에 needs_fields(422)다.
        async with Session() as s:
            d = await s.get(EventDefinition, w["definition"].id)
            d.stage_metadata = {**d.stage_metadata, "review": {"role": "Maker", "action": "검토"}}
            await s.commit()
            assert completion_mode(d, "review") == "needs_fields"
        w["definition"] = d
        with pytest.raises(HTTPException) as info:
            await _complete(Session, w, "review")
        assert info.value.status_code == 422 and info.value.detail["mode"] == "needs_fields"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_start_candidates_expose_the_current_assignee_even_when_it_is_an_agent():
    """start-candidates — 지금 stage 담당이 에이전트면 그 id(FE는 나와 달라 «완료»를 안 그린다)."""
    from app.models.recipe_role_binding import RecipeRoleBinding

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        async with Session() as s:
            row = (await s.execute(select(RecipeRoleBinding).where(
                RecipeRoleBinding.event_definition_key == w["definition"].key, RecipeRoleBinding.stage == "assign_step_1",
            ))).scalar_one()
            row.agent_member_id = w["agent"]
            await s.commit()
        await _start(Session, w)
        c = await _candidate(Session, w)
        assert c.current_bound_member_id == str(w["agent"])
        with pytest.raises(HTTPException) as info:
            await _complete(Session, w, "assign_step_1")
        assert info.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_after_the_gate_is_approved_the_next_assignee_starts_their_stage():
    """PO 4249 빈틈 — 게이트 stage(`gate_approval`)가 승인되면 판정 알림을 받은 다음 stage 담당이 이어 간다. 담당이 사람이면
    «내 단계 시작»(action=start)으로 자기 stage를 사람 명의로 낸다. 승인 전 · 남의 stage면 거절."""
    from app.models.gate import Gate
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.services.gate_service import transition_gate

    meta = {
        "draft": {"role": "Maker", "action": "초안"},
        "review": {"role": "Director", "action": "검토", "gate": {"type": "concept_approval", "approver": "org_owner"}},
        "write": {"role": "Writer", "action": "작성"},
    }
    engine, Session = await _session_factory()
    try:
        w = await _world(Session, stage_metadata=meta, stages=["draft", "review", "write"])
        await _start(Session, w)
        await _complete(Session, w, "draft")  # → review(게이트 열림)

        async def _start_mine(user=None):
            from app.routers.events import CompleteStageRequest, complete_recipe_stage

            async with Session() as s:
                r = await complete_recipe_stage(
                    w["definition"].id,
                    CompleteStageRequest(
                        project_id=w["project_id"], work_item_type="story", work_item_id=w["story_id"], stage="write", action="start",
                    ),
                    BackgroundTasks(), _fake_request(), db=s, auth=_human_auth(user or w["me_user"], w["org_id"]), org_id=w["org_id"],
                )
                await s.commit()
                return r

        c = await _candidate(Session, w)
        assert (c.current_stage, c.current_completion, c.current_gate_status, c.next_bound_member_id) == (
            "review", "gate_approval", "pending", str(w["me"]),
        )
        with pytest.raises(HTTPException) as info:
            await _start_mine()
        assert info.value.status_code == 409 and info.value.detail["code"] == "PREVIOUS_STAGE_NOT_APPROVED"

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.work_item_id == w["story_id"], Gate.gate_type == "concept_approval"))).scalar_one()
            await transition_gate(s, w["org_id"], gate.id, "approved", w["other"], None)
            await s.commit()
        c = await _candidate(Session, w)
        assert c.current_gate_status == "approved"

        with pytest.raises(HTTPException) as info:
            await _start_mine(user=w["other_user"])
        assert info.value.status_code == 403

        r = await _start_mine()
        assert (r["completed_stage"], r["next_stage"]) == (None, "write")
        assert await _stage_sender(Session, w, "write") == w["me"]
        # 다시 누르면 «바로 앞 stage가 지금 stage가 아님»
        with pytest.raises(HTTPException) as info:
            await _start_mine()
        assert info.value.detail["code"] == "STAGE_NOT_NEXT"
        assert RecipeRoleBinding  # 바인딩은 _world가 전 stage를 나에게
    finally:
        await engine.dispose()
