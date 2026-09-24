"""story #4255 — 마지막 단계가 서버의 채널 게시(published)인 레시피: 그 이벤트가 게시를 **실제로 승인한 사람**에게 간다.

예전엔 4242 규칙(채널 연결 stage → 다음 stage 담당)이 다음 stage가 없는 자리를 비워 수신자 0이었다 — 게시 결과가 아무에게도
안 갔다(4177 체인 실측). 확정 규칙(PO 07:19Z): 수신자 = ① 촉발 게이트(직전 stage가 연 이 레시피 게이트)를 실제로 승인한 사람
(resolver · 없으면 지정 승인자) ∪ ② 직전 stage에 바인딩된 에이전트. 본문엔 게시 주소 + «할 일 없음».

세팅: 실 SNS 텍스트 시드(0396 `_TEXT_POST` 상수 그대로) · 적용은 **화면이 보내는 매핑**(에이전트 자리 + 채널 연결 · 사람 승인
stage 바인딩 없음) · 사람 승인은 실 전이 엔드포인트. 하네스는 test_4090_ac2 그대로.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks

from tests.recipe_reviewed_draft import reviewed_draft_body_via
from tests.test_4090_ac2_recipe_auto_publish_realdb import (
    _auth,
    _client_for,
    _fake_request,
    _realdb_session,
    _seed_agent,
    _seed_default_role,
    _seed_org_with_owner,
    _seed_sandbox_connection,
    _seed_story,
    _seed_system_publisher_teammember_shim,
    _setup_org_scoped_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib

    from cryptography.fernet import Fernet

    import app.core.config as config_module

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module

    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


def _seed_module():
    import importlib.util
    from pathlib import Path

    path = next((Path(__file__).resolve().parents[1] / "alembic" / "versions").glob("0396_*.py"))
    spec = importlib.util.spec_from_file_location("_m0396_4255", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_SEED_MODULE = _seed_module()
_SEED = _SEED_MODULE._TEXT_POST
_KEY = _SEED["key"]


async def _world(Session, *, bind_agent_to_pending_approval: bool = False) -> dict:
    from app.models.event_definition import EventDefinition
    from app.models.recipe_role_binding import RecipeRoleBinding

    async with Session() as s:
        org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug=f"l4255-{uuid.uuid4().hex[:6]}")
        await _seed_default_role(s, org_id)
        await _seed_system_publisher_teammember_shim(s, org_id, project_id)
        creator_id = await _seed_agent(s, org_id, project_id, name="Creator")
        watcher_id = await _seed_agent(s, org_id, project_id, name="직전 단계 에이전트")
        story_id = await _seed_story(s, org_id, project_id, title="SNS 게시 회차")
        sandbox_id = await _seed_sandbox_connection(s, org_id)
        if (await s.execute(EventDefinition.__table__.select().where(EventDefinition.key == _KEY))).first() is None:
            s.add(EventDefinition(
                id=uuid.uuid4(), key=_KEY, org_id=None, name=_SEED["name"], description=_SEED["description"],
                payload_schema=_SEED["payload_schema"], routing=_SEED_MODULE._ROUTING,
                block_template=_SEED["block_template"], stage_metadata=_SEED["stage_metadata"],
                role_actor_kinds=_SEED["role_actor_kinds"], enabled=True, version=1,
            ))
        # 화면(마케팅 레시피 적용 창)이 보내는 매핑: 에이전트 자리 + 채널 연결. 사람 승인 stage(Director)는 싣지 않는다.
        bindings = {"draft": creator_id, "editing": creator_id}
        if bind_agent_to_pending_approval:
            # AC2 — 직전 stage에 에이전트가 묶인 정의(API로 묶은 경우)면 그 에이전트도 받는다.
            bindings["pending_approval"] = watcher_id
        for stage, member_id in bindings.items():
            s.add(RecipeRoleBinding(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, event_definition_key=_KEY,
                stage=stage, agent_member_id=member_id,
            ))
        s.add(RecipeRoleBinding(
            id=uuid.uuid4(), org_id=org_id, project_id=project_id, event_definition_key=_KEY,
            stage="published", channel_connection_id=sandbox_id,
        ))
        await s.commit()
    return {
        "org_id": org_id, "project_id": project_id, "owner_member_id": owner_member_id, "owner_user_id": owner_user_id,
        "creator_id": creator_id, "watcher_id": watcher_id, "story_id": story_id, "sandbox_id": sandbox_id,
    }


async def _publish(Session, w, stage: str) -> None:
    from app.routers.events import EventPublishRequest, publish_registry_event

    async with Session() as s:
        await publish_registry_event(
            EventPublishRequest(definition_key=_KEY, payload={
                "stage": stage, "work_item_type": "story", "work_item_id": str(w["story_id"]),
            }),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(w["creator_id"], w["org_id"]), org_id=w["org_id"],
        )
        await s.commit()


async def _gate_id(Session, w, gate_type: str) -> uuid.UUID:
    from sqlalchemy import select

    from app.models.gate import Gate

    async with Session() as s:
        return (await s.execute(
            select(Gate.id).where(Gate.work_item_id == w["story_id"], Gate.gate_type == gate_type, Gate.scope_key == "")
        )).scalar_one()


async def _approve_as_owner(app, Session, w, gate_id: uuid.UUID) -> None:
    body = await reviewed_draft_body_via(Session, org_id=w["org_id"], work_item_id=w["story_id"])
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["owner_user_id"], agent=False)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/gates/{gate_id}/transition", json={"status": "approved", "note": "승인", "evidence_viewed": True, **body},
        )
    assert r.status_code == 200, r.text


async def _run_to_published(app, Session, w) -> None:
    await _publish(Session, w, "draft")
    await _publish(Session, w, "concept_confirmed")
    await _approve_as_owner(app, Session, w, await _gate_id(Session, w, "concept_approval"))
    await _publish(Session, w, "editing")
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["creator_id"], agent=True)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/organizations/{w['org_id']}/channel-posts/drafts",
            json={"work_item_id": str(w["story_id"]), "connection_id": str(w["sandbox_id"]), "text": "게시 본문"},
        )
        assert r.status_code == 201, r.text
        r_submit = await client.post(
            f"/api/v2/organizations/{w['org_id']}/channel-posts/drafts/{r.json()['draft_id']}/submit", json={},
        )
        assert r_submit.status_code == 200, r_submit.text
    await _publish(Session, w, "pending_approval")
    await _approve_as_owner(app, Session, w, await _gate_id(Session, w, "external_publish"))


async def _published_recipients_and_message(Session, w):
    from app.routers.events import _find_existing_stage_publish
    from app.services.event_routing_resolver import _resolve_recipe_role_binding

    async with Session() as s:
        message = await _find_existing_stage_publish(
            s, org_id=w["org_id"], definition_key=_KEY, work_item_type="story", work_item_id=str(w["story_id"]),
            stage="published",
        )
        assert message is not None, "published 단계 이벤트가 안 났다"
        recipients = await _resolve_recipe_role_binding(
            s, org_id=w["org_id"], definition_key=_KEY,
            payload={"stage": "published", "work_item_type": "story", "work_item_id": str(w["story_id"])},
        )
    return recipients, message


async def _latest_permalink(Session, w) -> str | None:
    from app.routers.events import _latest_published_permalink

    async with Session() as s:
        return await _latest_published_permalink(
            s, org_id=w["org_id"], payload={"work_item_id": str(w["story_id"])},
        )


@pytest.mark.anyio
async def test_last_server_stage_reaches_the_person_who_approved_the_publish_gate_with_the_permalink():
    """⭐AC1 — 화면 매핑 그대로(사람 stage 바인딩 없음): published 이벤트 수신자 = 최종 발행 게이트를 승인한 owner 정확히 1 ·
    본문에 게시 주소 · «할 일 없음». 뮤테이션: 마지막 서버 stage 규칙을 지우면(예전 «0 그대로») 수신자 0 → RED."""
    from app.main import app
    from app.services.i18n_catalog import t

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        await _run_to_published(app, Session, w)

        recipients, message = await _published_recipients_and_message(Session, w)
        assert recipients == {w["owner_member_id"]}
        async with Session() as s:
            from sqlalchemy import select

            from app.models.conversation import ConversationParticipant

            participants = set((await s.execute(
                select(ConversationParticipant.member_id).where(ConversationParticipant.conversation_id == message.conversation_id)
            )).scalars().all())
        assert w["owner_member_id"] in participants, "게시를 승인한 사람이 결과 이벤트 대화에 없다"

        permalink = await _latest_permalink(Session, w)
        assert permalink, "sandbox 게시 주소가 비었다"
        assert t("events.stage_last_channel_published", "ko", permalink=permalink) in message.content, message.content
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_bound_to_the_previous_stage_also_receives_the_result():
    """AC2 — 직전 stage(pending_approval)에 에이전트가 묶여 있으면 그 에이전트도 받는다(승인자 ∪ 직전 stage 에이전트)."""
    from app.main import app

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session, bind_agent_to_pending_approval=True)
        await _run_to_published(app, Session, w)

        recipients, _message = await _published_recipients_and_message(Session, w)
        assert recipients == {w["owner_member_id"], w["watcher_id"]}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_old_human_binding_on_the_previous_stage_is_not_a_recipient():
    """AC2 — 직전 stage에 남은 **사람** 바인딩(옛 적용)은 수신자가 아니다(4606 ⓑ와 같은 결 — 사람 승인 stage는 바인딩으로
    받지 않는다). 받는 사람은 게이트를 실제로 승인한 사람뿐."""
    from app.main import app
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.models.team import TeamMember

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        async with Session() as s:
            old = TeamMember(
                id=uuid.uuid4(), org_id=w["org_id"], project_id=w["project_id"], type="human", name="옛 Director", is_active=True,
            )
            s.add(old)
            await s.commit()
            s.add(RecipeRoleBinding(
                id=uuid.uuid4(), org_id=w["org_id"], project_id=w["project_id"], event_definition_key=_KEY,
                stage="pending_approval", agent_member_id=old.id,
            ))
            await s.commit()
        await _run_to_published(app, Session, w)

        recipients, _message = await _published_recipients_and_message(Session, w)
        assert recipients == {w["owner_member_id"]}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── 까디르 4617 codex 넷(P1 · P2 · P2 · 테스트) ────────────────────────────────────────────────────────


async def _published_event_context(Session, w) -> tuple[dict, uuid.UUID]:
    """실제로 발행된 published 이벤트가 실어 보낸 문맥(refs)과 최종 발행 게이트 id."""
    _recipients, message = await _published_recipients_and_message(Session, w)
    refs = message.msg_metadata["event"]["refs"]
    return {k: refs[k] for k in ("trigger_gate_id", "publication_id") if k in refs}, await _gate_id(Session, w, "external_publish")


async def _resolve_published(Session, w, *, context: dict | None) -> set:
    from app.services.event_routing_resolver import _resolve_recipe_role_binding

    async with Session() as s:
        return await _resolve_recipe_role_binding(
            s, org_id=w["org_id"], definition_key=_KEY, context=context,
            payload={"stage": "published", "work_item_type": "story", "work_item_id": str(w["story_id"])},
        )


@pytest.mark.anyio
async def test_published_event_carries_the_trigger_gate_and_it_wins_over_a_later_approved_gate():
    """P1 — 서버가 낸 published 이벤트는 촉발 게이트 id를 문맥으로 싣고, 해소기는 그 id로 게이트를 집는다. 같은 작업 항목에
    더 늦게 승인된 게이트가 있어도(다음 회차 경합) 실어 보낸 게이트의 승인자가 이긴다. id가 없으면(옛 경로) 최신으로 폴백.
    뮤테이션: 해소기가 문맥 게이트를 무시하면 늦은 게이트의 승인자에게 가 RED."""
    from datetime import datetime, timedelta, timezone

    from app.main import app
    from app.models.gate import Gate
    from app.models.team import TeamMember

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        await _run_to_published(app, Session, w)
        context, gate_id = await _published_event_context(Session, w)
        assert context.get("trigger_gate_id") == str(gate_id), context
        assert context.get("publication_id"), context

        async with Session() as s:
            later = TeamMember(
                id=uuid.uuid4(), org_id=w["org_id"], project_id=w["project_id"], type="human", name="다음 회차 승인자", is_active=True,
            )
            s.add(later)
            first = await s.get(Gate, gate_id)
            s.add(Gate(
                id=uuid.uuid4(), org_id=w["org_id"], work_item_id=w["story_id"], work_item_type="story",
                gate_type=first.gate_type, scope_key=f"next-round-{uuid.uuid4().hex[:6]}", status="approved",
                resolver_id=later.id,
                resolved_at=datetime.now(timezone.utc) + timedelta(hours=1),
                neutral_facts={**(first.neutral_facts or {})},
            ))
            await s.commit()

        assert await _resolve_published(Session, w, context=context) == {w["owner_member_id"]}
        assert await _resolve_published(Session, w, context=None) == {later.id}  # 옛 경로 폴백(경고 로그)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_trigger_gate_without_resolver_falls_back_to_the_designated_approver():
    """촉발 게이트에 resolver가 비어 있으면 지정 승인자(designated)에게. 뮤테이션: 지정 승인자 폴백을 지우면 0 → RED."""
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        await _run_to_published(app, Session, w)
        context, gate_id = await _published_event_context(Session, w)
        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            assert gate.designated_approver_id == w["owner_member_id"]
            gate.resolver_id = None
            await s.commit()
        assert await _resolve_published(Session, w, context=context) == {w["owner_member_id"]}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_previous_stage_agent_binding_from_another_org_is_not_a_recipient():
    """P2 — 직전 stage 바인딩의 에이전트 판정은 이 조직의 멤버만. 다른 조직 에이전트를 가리키는 행은 빠진다.
    뮤테이션: 에이전트 판정 쿼리에서 조직 조건을 지우면 그 멤버가 섞여 RED."""
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.models.team import TeamMember

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        await _run_to_published(app, Session, w)
        context, _gate_id_value = await _published_event_context(Session, w)
        async with Session() as s:
            other_org = Organization(id=uuid.uuid4(), name="Other4255", slug=f"o4255-{uuid.uuid4().hex[:6]}")
            s.add(other_org)
            await s.commit()
            other_project = Project(id=uuid.uuid4(), org_id=other_org.id, name="P")
            s.add(other_project)
            await s.commit()
            stranger = TeamMember(
                id=uuid.uuid4(), org_id=other_org.id, project_id=other_project.id, type="agent", name="다른 조직 에이전트",
                is_active=True,
            )
            s.add(stranger)
            await s.commit()
            s.add(RecipeRoleBinding(
                id=uuid.uuid4(), org_id=w["org_id"], project_id=w["project_id"], event_definition_key=_KEY,
                stage="pending_approval", agent_member_id=stranger.id,
            ))
            await s.commit()
        assert await _resolve_published(Session, w, context=context) == {w["owner_member_id"]}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_old_agent_binding_on_the_channel_stage_does_not_bypass_the_rule():
    """P2 — 채널 연결 stage(published)에 0387 전의 옛 **에이전트** 바인딩이 남아 있어도(dev 실측 1행) 해소에 쓰지 않는다 —
    마지막 서버 stage 규칙(촉발 게이트 승인자)이 그대로 선다. 뮤테이션: stage 방식보다 바인딩을 먼저 보면 그 에이전트에게 가 RED."""
    from sqlalchemy import update

    from app.main import app
    from app.models.recipe_role_binding import RecipeRoleBinding

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        await _run_to_published(app, Session, w)
        context, _gate_id_value = await _published_event_context(Session, w)
        async with Session() as s:
            await s.execute(
                update(RecipeRoleBinding)
                .where(RecipeRoleBinding.org_id == w["org_id"], RecipeRoleBinding.stage == "published")
                .values(agent_member_id=w["creator_id"], channel_connection_id=None)
            )
            await s.commit()
        assert await _resolve_published(Session, w, context=context) == {w["owner_member_id"]}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_carried_gate_from_another_work_item_is_ignored():
    """PO 10:15Z — 실어 보낸 id의 게이트가 이 이벤트의 작업 항목이 아니면(다른 스토리의 승인 게이트) 쓰지 않는다 — 이 항목의
    게이트로 폴백해 그 승인자(owner)에게. 뮤테이션: 작업 항목 조건을 지우면 다른 스토리 승인자에게 새어 RED."""
    from datetime import datetime, timezone

    from app.main import app
    from app.models.gate import Gate
    from app.models.team import TeamMember
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _seed_story as _seed_other_story

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        await _run_to_published(app, Session, w)
        async with Session() as s:
            other_story_id = await _seed_other_story(s, w["org_id"], w["project_id"], title="다른 스토리")
            stranger = TeamMember(
                id=uuid.uuid4(), org_id=w["org_id"], project_id=w["project_id"], type="human", name="다른 항목 승인자", is_active=True,
            )
            s.add(stranger)
            other_gate = Gate(
                id=uuid.uuid4(), org_id=w["org_id"], work_item_id=other_story_id, work_item_type="story",
                gate_type="external_publish", scope_key="", status="approved", resolver_id=stranger.id,
                resolved_at=datetime.now(timezone.utc),
                neutral_facts={"stage": "pending_approval", "triggered_by_event": _KEY},
            )
            s.add(other_gate)
            await s.commit()
        assert await _resolve_published(Session, w, context={"trigger_gate_id": str(other_gate.id)}) == {w["owner_member_id"]}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
