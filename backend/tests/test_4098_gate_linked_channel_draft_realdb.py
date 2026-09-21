"""story #4098([E-RECIPE-1], 페드루 PO 確定 2026-09-21) — 레시피 unscoped external_publish
게이트(scope_key="") 상세에 "이 승인으로 발행될 채널 초안" 미리보기를 싣는다. #4090 AC2로
그 게이트 승인이 곧 자동발행인데, 게이트 상세엔 실제로 나갈 초안(본문·이미지·영상·목적지·
예약)이 하나도 안 보이던 갭 — 승인자가 실물을 안 보고 딸깍하는 자리.

`channel_posts.py::find_ready_recipe_channel_drafts`(publish_recipe_approved_draft가
실제 자동발행 실행에 쓰는 그 선택 함수, #4090에서 추출)를 `gates.py::to_gate_response()`
안에서 재사용 — 두 표면이 절대 다른 draft를 가리키지 않는다(뮤테이션 킬 대상)."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import select

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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


def _load_migration_module(filename: str, alias: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        alias, os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", filename),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG_0381 = _load_migration_module("0381_preset_marketing_video_production_recipe.py", "_m0381_4098")
_MIG_0382 = _load_migration_module(
    "0382_recipe_video_production_structure_and_budget_gates.py", "_m0382_4098",
)
_MIG_0387 = _load_migration_module(
    "0387_recipe_role_binding_channel_connection.py", "_m0387_4098",
)
_KEY = "preset.4098.video_production"
_PAYLOAD_SCHEMA = _MIG_0382._NEW_PAYLOAD_SCHEMA
_ROUTING = _MIG_0381._ROUTING
_STAGE_METADATA = _MIG_0387._NEW_STAGE_METADATA


async def _realdb_session():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_references_non_proof "
            "ON entity_references (source_type, source_field, source_id, target_type, target_id, form, relation) "
            "WHERE form <> 'proof'"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="AC4098"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=None, name="영상 제작(#4098 테스트)",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_sandbox_connection(session, org_id, *, account_id=None, account_label=None):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="sandbox",
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", account_label=account_label, status="active",
        credential_kind="none", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential("sandbox-dummy-token"),
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _seed_recipe_channel_binding(session, org_id, connection_id):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=None, event_definition_key=_KEY,
        stage="published", channel_connection_id=connection_id,
    ))
    await session.commit()


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext

    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest

    return StarletteRequest(scope={"type": "http", "headers": []})


async def _walk_to_pending_approval_with_abc_approved(s, *, org_id, story_id, creator_id, owner_member_id):
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.gate_service import transition_gate

    async def _publish(stage: str, *, actor_id: uuid.UUID, extra: dict | None = None):
        payload = {"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)}
        if extra:
            payload.update(extra)
        await publish_registry_event(
            EventPublishRequest(definition_key=_KEY, payload=payload),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(actor_id, org_id), org_id=org_id,
        )

    await _publish("draft", actor_id=creator_id)
    await _publish("concept_confirmed", actor_id=creator_id)
    gate_a = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "concept_approval")
    )).scalar_one()
    await transition_gate(s, org_id, gate_a.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("animatic", actor_id=creator_id)
    gate_b = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "structure_approval")
    )).scalar_one()
    await transition_gate(s, org_id, gate_b.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("structure_passed", actor_id=owner_member_id, extra={"estimated_cost_minor": 80_000})
    gate_c = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "generation_budget")
    )).scalar_one()
    await transition_gate(s, org_id, gate_c.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("pending_approval", actor_id=creator_id)
    gate_d = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish", Gate.scope_key == "")
    )).scalar_one()
    assert gate_d.status == "pending"
    return gate_d.id


async def _submit_draft(s, *, org_id, story_id, connection_id, creator_id, text="AC4098 본문"):
    from app.services.channel_posts import create_channel_post_draft_version, submit_channel_post_draft

    version, _channel, _violations = await create_channel_post_draft_version(
        s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
        text=text, link_url=None, author_member_id=creator_id, author_kind="agent",
    )
    scoped_gate, _version_id = await submit_channel_post_draft(
        s, org_id=org_id, draft_id=version.draft_id, version_id=None, requester_member_id=creator_id,
        scheduled_at=None,
    )
    return version.draft_id, scoped_gate


@pytest.mark.anyio
async def test_ac1a_ready_draft_populates_linked_channel_draft():
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4098a")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id, account_label="공식 계정")
            await _seed_recipe_channel_binding(s, org_id, connection_id)

            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            draft_id, scoped_gate = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_id, creator_id=creator_id,
                text="AC4098 발행될 본문",
            )
            # ⓓ는 아직 미승인 상태로 둔다(이 스토리의 요지 자체가 "승인 前에 미리 본다") —
            # scoped 게이트만 직접 approved로(#4069 자동충족·#4090 실제 자동발행을 거치지
            # 않는다 — 거치면 이 테스트 안에서 진짜 발행이 일어나 already_published로
            # 걸러져 ready에서 빠진다, 순수 조회 함수만 검증하는 게 이 케이스의 범위).
            from app.models.gate import set_gate_status
            from datetime import datetime, timezone

            set_gate_status(scoped_gate, "approved", now=datetime.now(timezone.utc))
            scoped_gate.requires_human = False
            scoped_gate.resolver_id = owner_member_id
            await s.commit()

        async with Session() as s:
            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.status == "pending", "이 케이스는 ⓓ 승인 前 미리보기를 검증한다"
            resp = await to_gate_response(s, org_id, gate_d)
            assert resp.linked_channel_draft is not None, "ready draft가 있는데 linked_channel_draft가 비었다"
            assert resp.linked_channel_draft.draft_id == draft_id
            assert resp.linked_channel_draft.text == "AC4098 발행될 본문"
            assert resp.linked_channel_draft.account_label == "공식 계정"
            assert resp.linked_channel_draft.scoped_gate_status == "approved"
            assert resp.linked_channel_draft_pending is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac1b_no_draft_leaves_field_null():
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4098b")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )

        async with Session() as s:
            gate_d = await s.get(Gate, gate_d_id)
            resp = await to_gate_response(s, org_id, gate_d)
            assert resp.linked_channel_draft is None
            assert resp.linked_channel_draft_pending is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac1b2_pending_scoped_gate_sets_pending_flag_not_content():
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4098b2")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            # ⓓ 승인 前에 제출 — scoped 게이트는 pending 그대로(자동충족 조건 미달).
            await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_id, creator_id=creator_id,
            )

        async with Session() as s:
            gate_d = await s.get(Gate, gate_d_id)
            resp = await to_gate_response(s, org_id, gate_d)
            assert resp.linked_channel_draft is None, "아직 pending인 draft를 확정 콘텐츠로 노출했다"
            assert resp.linked_channel_draft_pending is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac1c_two_drafts_picks_same_target_as_publish_recipe_approved_draft():
    """뮤테이션 킬 대상(스토리 «판별» 명시) — find_ready_recipe_channel_drafts를 둘로
    갈라놓으면(예: 미리보기가 독자 정렬을 쓰면) 이 단언이 실패해야 한다."""
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4098c")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_a = await _seed_sandbox_connection(s, org_id, account_id="acct-a")
            connection_b = await _seed_sandbox_connection(s, org_id, account_id="acct-b")
            await _seed_recipe_channel_binding(s, org_id, connection_a)

            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            draft_a_id, scoped_gate_a = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_a, creator_id=creator_id,
                text="목적지 A",
            )
            draft_b_id, scoped_gate_b = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_b, creator_id=creator_id,
                text="목적지 B",
            )
            # 두 scoped 게이트를 직접 approved로(다중 목적지라 #4069 단일-목적지 자동충족
            # 조건이 원천적으로 성립 안 함 — 실제 발행 경로를 거치지 않고 "고를 후보가
            # 둘"인 순수 상태만 만든다, test_ac1a와 동일 원칙).
            from datetime import datetime, timezone

            from app.models.gate import set_gate_status

            for sg in (scoped_gate_a, scoped_gate_b):
                set_gate_status(sg, "approved", now=datetime.now(timezone.utc))
                sg.requires_human = False
                sg.resolver_id = owner_member_id
            await s.commit()

        async with Session() as s:
            from app.services.channel_posts import find_ready_recipe_channel_drafts

            gate_d = await s.get(Gate, gate_d_id)
            ready, _still_pending = await find_ready_recipe_channel_drafts(
                s, org_id=org_id, work_item_id=story_id, work_item_type="story",
            )
            assert len(ready) == 2, f"두 draft 다 ready여야 하는데: {len(ready)}"
            expected_draft_id = ready[0][0].id

            resp = await to_gate_response(s, org_id, gate_d)
            assert resp.linked_channel_draft is not None
            assert resp.linked_channel_draft.draft_id == expected_draft_id, (
                "미리보기가 publish_recipe_approved_draft와 다른 draft를 골랐다(선택 규칙 드리프트)"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac1d_other_gate_type_and_scoped_gate_leave_field_null():
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4098d")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            draft_id, scoped_gate = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_id, creator_id=creator_id,
            )
            scoped_gate_id = scoped_gate.id

            from app.models.gate import Gate as _GateModel
            concept_gate = (await s.execute(
                select(_GateModel).where(_GateModel.work_item_id == story_id, _GateModel.gate_type == "concept_approval")
            )).scalar_one()

        async with Session() as s:
            resp_concept = await to_gate_response(s, org_id, await s.get(Gate, concept_gate.id))
            assert resp_concept.linked_channel_draft is None
            assert resp_concept.linked_channel_draft_pending is False

            resp_scoped = await to_gate_response(s, org_id, await s.get(Gate, scoped_gate_id))
            assert resp_scoped.linked_channel_draft is None
            assert resp_scoped.linked_channel_draft_pending is False
    finally:
        await engine.dispose()


async def _seed_org_with_owner_shim(session, *, slug):
    """story #4098 — team_members VIEW/TABLE 갭(test_3380 선례, #4090/#4093과 동형)을
    #4468 공용 헬퍼(seed_org_with_human_owner)로 바로 처방 — 이 파일은 human-owner
    axis만 필요하고(agent shim 불요, publish_registry_event 호출이 시스템 발행자를
    안 씀) 별도 shim 없이 그 헬퍼 하나로 충분하다."""
    from tests.conftest import seed_org_with_human_owner

    return await seed_org_with_human_owner(session, slug=slug, org_name="Org4098")
