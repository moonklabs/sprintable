"""story #4251 — 원시 발행 경로(에이전트 `publish_event` · «레시피 시작» · 조직 «테스트 발행»)의 레시피 stage 순서 · 권한 검증.

PO 판정(4251 Q1~Q6)을 규칙마다 «허용 1 · 거부 1»로 고정한다. 거부는 아무것도 발행하지 않고(이벤트 0 · 게이트 0), 본문은 사람과
에이전트가 읽는 로케일 문장(무엇이 막혔나 · 지금 stage와 담당)이다. 검사는 4249와 같은 한 원천
(`recipe_stage_completion.validate_raw_stage_publish`)이다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import select, update

from tests.test_3312_approve_stage_gate_auto_creation import _fake_request, _seed_story
from tests.test_3475_publishing_metrics import _seed_human
from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _seed_org, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

# draft(작가) → review(작가가 내면 승인 게이트가 열린다) → revise(수정 담당) → publish(채널 연결 · 서버) → measure(분석)
_STAGES = ["draft", "review", "revise", "publish", "measure"]
_META = {
    "draft": {"role": "Writer", "action": "초안"},
    "review": {"role": "Director", "action": "검토", "gate": {"type": "external_publish", "approver": "org_owner"}},
    "revise": {"role": "Editor", "action": "수정"},
    "publish": {"role": "Publisher", "action": "게시", "capability": {"target": "channel_connection"}},
    "measure": {"role": "Analyst", "action": "측정"},
}
# brief → live_generation(연산 커넥터 · crew가 스스로 낸다) → check
_GEN_STAGES = ["brief", "live_generation", "check"]
_GEN_META = {
    "brief": {"role": "Writer", "action": "기획"},
    "live_generation": {"role": "Generator", "action": "생성", "capability": {"target": "generation_connector"}},
    "check": {"role": "Checker", "action": "확인"},
}
_ROUTING = {"broadcast": {"kind": "recipe_role_binding"}, "escalation": {"kind": "server_derived", "target": "none"}}


def _schema(stages: list[str], *, work_item_required: bool = True) -> dict:
    return {
        "type": "object", "additionalProperties": False,
        "required": ["stage", "work_item_type", "work_item_id"] if work_item_required else ["stage"],
        "properties": {
            "stage": {"type": "string", "enum": stages},
            "work_item_type": {"type": "string"}, "work_item_id": {"type": "string", "format": "uuid"},
        },
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


def _agent_auth(member_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext

    return AuthContext(
        user_id=str(member_id), email=None, claims={"app_metadata": {"api_key_id": "t4251"}}, org_id=str(org_id),
    )


async def _world(Session, *, stages=None, meta=None, bindings=None, routing=None, work_item_required=True):
    """에이전트 넷(writer · editor · analyst · outsider)과 사람 둘(owner · 프로젝트 밖 사람은 없음 — owner는 org 전역 접근).
    bindings: stage → 멤버 키(없으면 기본 배치)."""
    from app.models.event_definition import EventDefinition
    from app.models.project import OrgMember
    from app.models.recipe_role_binding import RecipeRoleBinding

    stages = stages or _STAGES
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_user = await _seed_human(s, org_id, role="owner")
        owner = (await s.execute(select(OrgMember.id).where(OrgMember.user_id == owner_user))).scalar_one()
        members = {key: await _seed_agent(s, org_id, project_id) for key in ("writer", "editor", "analyst", "outsider")}
        story_id = await _seed_story(s, org_id, project_id)
        definition = EventDefinition(
            id=uuid.uuid4(), key=f"org.t4251{uuid.uuid4().hex[:6]}.recipe", org_id=org_id, name="레시피",
            payload_schema=_schema(stages, work_item_required=work_item_required), routing=routing or _ROUTING,
            stage_metadata=meta or _META,
        )
        s.add(definition)
        default = {"draft": "writer", "review": "writer", "revise": "editor", "measure": "analyst"}
        for stage, key in (bindings if bindings is not None else default).items():
            s.add(RecipeRoleBinding(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, event_definition_key=definition.key,
                stage=stage, agent_member_id=members[key],
            ))
        await s.commit()
    return {
        "org_id": org_id, "project_id": project_id, "owner_user": owner_user, "owner": owner, "story_id": story_id,
        "definition": definition, **members,
    }


async def _publish(Session, w, stage: str, *, as_member: str | None = None, as_human: bool = False, payload=None):
    from app.routers.events import EventPublishRequest, publish_registry_event

    auth = _human_auth(w["owner_user"], w["org_id"]) if as_human else _agent_auth(w[as_member], w["org_id"])
    async with Session() as s:
        result = await publish_registry_event(
            EventPublishRequest(definition_key=w["definition"].key, payload=payload or {
                "stage": stage, "work_item_type": "story", "work_item_id": str(w["story_id"]),
            }),
            BackgroundTasks(), _fake_request(), db=s, auth=auth, org_id=w["org_id"],
        )
        await s.commit()
        return result


async def _rejected(Session, w, stage: str, **kwargs) -> dict:
    """거부를 확認하고 detail을 돌려준다 — 그 stage 이벤트가 새로 나지 않았는지도 본다."""
    before = await _stage_count(Session, w, stage)
    with pytest.raises(HTTPException) as info:
        await _publish(Session, w, stage, **kwargs)
    assert await _stage_count(Session, w, stage) == before, "거부됐는데 이벤트가 남았다"
    detail = info.value.detail
    assert isinstance(detail, dict) and detail["message"], detail
    return {**detail, "status": info.value.status_code}


async def _stage_count(Session, w, stage: str) -> int:
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text(
            "SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id "
            "WHERE c.org_id = :org AND m.metadata->'event'->>'event_key' = :key "
            "AND m.metadata->'event'->'payload'->>'stage' = :stage"
        ), {"org": w["org_id"], "key": w["definition"].key, "stage": stage})).scalar_one()


async def _set_gate(Session, w, status: str) -> None:
    from app.models.gate import Gate

    async with Session() as s:
        await s.execute(update(Gate).where(Gate.org_id == w["org_id"], Gate.work_item_id == w["story_id"]).values(status=status))
        await s.commit()


# ── Q1 첫 stage ────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_first_stage_by_a_person_with_project_access_or_the_bound_member_only():
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        d = await _rejected(Session, w, "draft", as_member="outsider")
        assert (d["status"], d["code"], d["current_stage"]) == (403, "NOT_STAGE_ASSIGNEE", None)
        assert d["allowed_member_ids"] == [str(w["writer"])]
        await _publish(Session, w, "draft", as_human=True)  # «레시피 시작» — 누르는 사람이 바인딩 멤버가 아니어도
        assert await _stage_count(Session, w, "draft") == 1

        w2 = await _world(Session)
        await _publish(Session, w2, "draft", as_member="writer")  # 첫 stage에 바인딩된 에이전트가 스스로 시작
        assert await _stage_count(Session, w2, "draft") == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_recipe_cannot_start_from_a_later_stage():
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        d = await _rejected(Session, w, "revise", as_human=True)
        assert (d["status"], d["code"], d["next_stage"]) == (409, "STAGE_NOT_NEXT", "draft")
        assert "draft(Writer)" in d["message"] and "시작 전" in d["message"]
    finally:
        await engine.dispose()


# ── 순서 · 담당 ─────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_next_stage_only_by_the_current_stage_member_and_never_skipping():
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _publish(Session, w, "draft", as_member="writer")
        d = await _rejected(Session, w, "review", as_member="outsider")
        assert (d["status"], d["code"], d["current_stage"]) == (403, "NOT_STAGE_ASSIGNEE", "draft")
        d = await _rejected(Session, w, "revise", as_member="writer")  # review 건너뛰기
        assert (d["status"], d["code"], d["next_stage"]) == (409, "STAGE_NOT_NEXT", "review")
        await _publish(Session, w, "review", as_member="writer")
        d = await _rejected(Session, w, "draft", as_member="writer")  # 되돌아가기
        assert d["code"] == "STAGE_NOT_NEXT"
    finally:
        await engine.dispose()


# ── Q2 게이트 승인 뒤 다음 stage ────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_after_a_gate_the_next_stage_waits_for_approval_then_the_requester_may_continue():
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _publish(Session, w, "draft", as_member="writer")
        await _publish(Session, w, "review", as_member="writer")  # 게이트가 열린다(요청자 = writer)
        d = await _rejected(Session, w, "revise", as_member="writer")
        assert (d["status"], d["code"]) == (409, "PREVIOUS_STAGE_NOT_APPROVED")
        await _set_gate(Session, w, "approved")
        d = await _rejected(Session, w, "revise", as_member="outsider")
        assert d["code"] == "NOT_STAGE_ASSIGNEE"
        assert set(d["allowed_member_ids"]) == {str(w["writer"]), str(w["editor"])}
        await _publish(Session, w, "revise", as_member="writer")  # 게이트 행의 요청자
        assert await _stage_count(Session, w, "revise") == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_after_an_approved_gate_the_next_stage_member_may_continue():
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _publish(Session, w, "draft", as_member="writer")
        await _publish(Session, w, "review", as_member="writer")
        await _set_gate(Session, w, "approved")
        await _publish(Session, w, "revise", as_member="editor")
        assert await _stage_count(Session, w, "revise") == 1
    finally:
        await engine.dispose()


# ── Q3 서버 stage ───────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_a_member_cannot_publish_a_server_stage():
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _publish(Session, w, "draft", as_member="writer")
        await _publish(Session, w, "review", as_member="writer")
        await _set_gate(Session, w, "approved")
        await _publish(Session, w, "revise", as_member="editor")
        d = await _rejected(Session, w, "publish", as_member="editor")
        assert (d["status"], d["code"]) == (409, "STAGE_SERVER_DRIVEN")
        assert "서버가 내요 — 직접 내지 마세요" in d["message"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_after_a_server_advancing_gate_the_member_does_not_publish_the_next_stage():
    """4254 결함 클래스 — 발송 게이트(`SERVER_ADVANCING_GATE_TYPES`) 뒤 다음 stage는 서버가 발송하고 낸다. 멤버가 먼저 내면 거부."""
    from app.services.recipe_gate_hooks import SERVER_ADVANCING_GATE_TYPES

    gate_type = sorted(SERVER_ADVANCING_GATE_TYPES)[0]
    stages = ["draft", "send_requested", "send_checked"]
    meta = {
        "draft": {"role": "Writer", "action": "초안"},
        "send_requested": {"role": "Publisher", "action": "발송 요청", "gate": {"type": gate_type, "approver": "org_owner"}},
        "send_checked": {"role": "Publisher", "action": "발송 확인"},
    }
    engine, Session = await _session_factory()
    try:
        w = await _world(
            Session, stages=stages, meta=meta, bindings={"draft": "writer", "send_requested": "editor", "send_checked": "editor"},
        )
        await _publish(Session, w, "draft", as_member="writer")
        # 발송 요청 stage는 봉인 값이 필요하다 — 이 테스트는 그 뒤를 본다(지금 stage를 발송 요청으로 바로 깐다).
        from app.routers.events import _find_existing_stage_publish

        async with Session() as s:
            msg = await _find_existing_stage_publish(
                s, org_id=w["org_id"], definition_key=w["definition"].key, work_item_type="story",
                work_item_id=str(w["story_id"]), stage="draft",
            )
            metadata = dict(msg.msg_metadata)
            metadata["event"] = {**metadata["event"], "payload": {**metadata["event"]["payload"], "stage": "send_requested"}}
            msg.msg_metadata = metadata
            await s.commit()
        d = await _rejected(Session, w, "send_checked", as_member="editor")
        assert (d["status"], d["code"], d["current_stage"]) == (409, "STAGE_SERVER_DRIVEN", "send_requested")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_crew_publishes_a_generation_connector_stage_itself():
    """PO 4251 Q3 — 연산 커넥터 stage(`live_generation`)는 crew(이 레시피에 바인딩된 에이전트)가 스스로 낸다(4110 폴백과 같은
    규칙). crew 밖 에이전트는 거부."""
    engine, Session = await _session_factory()
    try:
        w = await _world(
            Session, stages=_GEN_STAGES, meta=_GEN_META, bindings={"brief": "writer", "check": "analyst"},
        )
        await _publish(Session, w, "brief", as_member="writer")
        d = await _rejected(Session, w, "live_generation", as_member="outsider")
        assert d["code"] == "NOT_STAGE_ASSIGNEE"
        await _publish(Session, w, "live_generation", as_member="analyst")  # crew(check 담당)
        # 연산 커넥터 뒤 다음 stage — 그 stage 담당 또는 crew.
        await _publish(Session, w, "check", as_member="writer")
        assert await _stage_count(Session, w, "check") == 1
    finally:
        await engine.dispose()


# ── Q4 같은 stage 재발행 ────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_same_stage_republish_by_its_member_or_the_gate_requester_only():
    engine, Session = await _session_factory()
    try:
        w = await _world(Session, bindings={"draft": "writer", "review": "analyst", "revise": "editor", "measure": "analyst"})
        await _publish(Session, w, "draft", as_member="writer")
        await _publish(Session, w, "draft", as_member="writer")  # 첫 stage 재발행은 중복 방지(기존 발행을 돌려준다)
        await _publish(Session, w, "review", as_member="writer")  # 게이트 요청자 = writer(review 담당은 analyst)
        await _set_gate(Session, w, "rejected")
        d = await _rejected(Session, w, "review", as_member="outsider")
        assert d["code"] == "NOT_STAGE_ASSIGNEE"
        await _publish(Session, w, "review", as_member="writer")  # 반려 뒤 원 요청자가 다시 올린다(게이트 재개)
        await _publish(Session, w, "review", as_member="analyst")  # 그 stage 담당도
        assert await _stage_count(Session, w, "review") == 3
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_rework_republish_of_a_gateless_stage_by_its_bound_member_only():
    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _publish(Session, w, "draft", as_member="writer")
        await _publish(Session, w, "review", as_member="writer")
        await _set_gate(Session, w, "approved")
        await _publish(Session, w, "revise", as_member="editor")
        d = await _rejected(Session, w, "revise", as_member="writer")  # 앞 stage 요청자라도 게이트 없는 stage 재발행은 담당만
        assert (d["code"], d["allowed_member_ids"]) == ("NOT_STAGE_ASSIGNEE", [str(w["editor"])])
        await _publish(Session, w, "revise", as_member="editor")
        assert await _stage_count(Session, w, "revise") == 2
    finally:
        await engine.dispose()


# ── Q5 · Q6 범위 ───────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_a_payload_without_a_work_item_is_not_checked():
    engine, Session = await _session_factory()
    try:
        w = await _world(Session, work_item_required=False)
        await _publish(Session, w, "revise", as_member="outsider", payload={"stage": "revise"})
        assert await _stage_count(Session, w, "revise") == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_definitions_not_routed_by_recipe_role_bindings_are_not_checked():
    engine, Session = await _session_factory()
    try:
        w = await _world(
            Session,
            routing={"broadcast": {"kind": "server_derived", "target": "work_item_stakeholders"},
                     "escalation": {"kind": "server_derived", "target": "none"}},
        )
        await _publish(Session, w, "revise", as_member="outsider")
        assert await _stage_count(Session, w, "revise") == 1
    finally:
        await engine.dispose()


# ── 거부 본문 · 면제 인자 ───────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_the_rejection_names_the_current_stage_its_assignee_and_what_to_do_in_the_request_locale():
    from app.models.team import TeamMember

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _publish(Session, w, "draft", as_member="writer")
        async with Session() as s:
            writer_name = (await s.execute(select(TeamMember.name).where(TeamMember.id == w["writer"]))).scalar_one()
        d = await _rejected(Session, w, "review", as_member="outsider")
        assert "review(Director)" in d["message"] and f"지금 단계: draft(Writer) · 담당: {writer_name}" in d["message"]
        assert "직접 내지 말고" in d["message"]

        from app.routers.events import _stage_publish_rejection_detail
        from app.services.recipe_stage_completion import StagePublishRejection

        async with Session() as s:
            en = await _stage_publish_rejection_detail(s, w["definition"], StagePublishRejection(
                code="STAGE_NOT_NEXT", status=409, org_id=w["org_id"], stage="revise", current="draft", next_stage="review",
                current_assignee=w["writer"],
            ), "en")
        assert en["message"].startswith("The revise(Editor) stage can't be published now") and en["message"].endswith(
            f"Next stage to publish: review(Director)\nCurrent stage: draft(Writer) · assigned to: {writer_name}"
        )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_http_request_cannot_carry_the_internal_exemption():
    """PO 4251 — 면제 인자(`stage_origin`)는 내부 호출만 넘긴다. HTTP 본문에 실어도(요청 모델 밖 키 · payload 안 키) 검사를 받는다."""
    from pydantic import ValidationError

    from app.routers.events import EventPublishRequest

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        try:
            request = EventPublishRequest(
                definition_key=w["definition"].key, stage_origin="server",
                payload={"stage": "revise", "work_item_type": "story", "work_item_id": str(w["story_id"])},
            )
        except ValidationError:
            request = None
        if request is not None:
            assert not hasattr(request, "stage_origin") or getattr(request, "stage_origin", None) is None
        d = await _rejected(Session, w, "revise", as_member="outsider", payload={
            "stage": "revise", "work_item_type": "story", "work_item_id": str(w["story_id"]), "stage_origin": "server",
        })
        assert d["status"] in (400, 409)  # 스키마 밖 키(400) 또는 순서 거부(409) — 어느 쪽이든 발행 0
    finally:
        await engine.dispose()
