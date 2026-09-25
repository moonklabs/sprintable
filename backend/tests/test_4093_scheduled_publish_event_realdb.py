"""story #4093([E-RECIPE-1] #4090 지름길 해소, 페드루 PO 確定 2026-09-21) — 예약 발행
(draft에 `scheduled_at` 있음)이 `_maybe_create_scheduled_publication_command`로
`publication_commands` 큐에 넘어간 뒤, 워커(`process_due_publication_commands`)가
실발행하는 시점에는 #4090 ②(즉시 발행 경로)가 잇던 레시피 published stage 이벤트를
아무도 발행하지 않던 갭 — 공통 훅(`channel_posts.py::emit_recipe_published_stage_event`)
을 워커의 성공/실패 두 분기 모두에 배선해 처방한다.

이 파일은 test_4090_ac2_recipe_auto_publish_realdb.py의 하네스(seed 헬퍼·픽스처
정의)를 그대로 복제한다 — 별도 EventDefinition.key라 다른 테스트 파일과 DB 레벨로
안 겹친다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.recipe_reviewed_draft import reviewed_draft_body_via, reviewed_draft_for
from fastapi import BackgroundTasks

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


_MIG_0381 = _load_migration_module("0381_preset_marketing_video_production_recipe.py", "_m0381_4093")
_MIG_0382 = _load_migration_module(
    "0382_recipe_video_production_structure_and_budget_gates.py", "_m0382_4093",
)
_MIG_0387 = _load_migration_module(
    "0387_recipe_role_binding_channel_connection.py", "_m0387_4093",
)
_KEY = "preset.4093.video_production"
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
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE runtime_type = 'system-publisher' AND type = 'agent'"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="AC2 예약발행"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=None, name="영상 제작(#4093 테스트)",
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


async def _seed_sandbox_connection(session, org_id, *, account_id=None, status="active"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="sandbox",
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status=status,
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


async def _seed_system_publisher_teammember_shim(session, org_id, project_id):
    """story #4093(그라운딩 갭, test_3380_doc_nudge_system_sender_realdb.py 선례와 동형) —
    `team_members`는 실 DB에선 members/project_access 위 VIEW(0088+)지만, 이 파일의
    `Base.metadata.create_all()` 하네스는 그 VIEW를 못 만든다(raw op.execute 정의라
    ORM 메타데이터에 없음, 실측 확認 — 미등재였으면 `_get_or_create_system_publisher`가
    쓴 신원을 `resolve_member`의 TeamMember 조회가 "Team member not found"로 못 찾는다).
    실 alembic 스키마 하네스(test_3380 선례)로 갈아타는 대신, 이 파일이 먼저 시스템
    발행자를 provision하고 그 id로 TeamMember shim 행을 하나 심어 둔다 — 이후 코드가
    다시 `_get_or_create_system_publisher`를 불러도 기존 Member 행을 그대로 반환할
    뿐이라(멱등, get-or-create) 이 shim과 충돌하지 않는다."""
    from app.models.team import TeamMember
    from app.routers.events import _get_or_create_system_publisher

    system_member = await _get_or_create_system_publisher(session, org_id)
    session.add(TeamMember(
        id=system_member.id, org_id=org_id, project_id=project_id, type="agent",
        name="시스템 발행", is_active=True,
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

    # story #4251 — 원시 발행은 stage 순서 · 담당을 검증한다. 각 stage를 그 담당이 순서대로 내도록 담당을 실제 바인딩으로
    # 깐다(Creator stage = 크리에이터 · Director의 structure_passed = org owner · live_generation도 크리에이터 — 리허설 1호에서
    # 댄이 스스로 이어간 형상). 게이트 뒤 stage는 «승인 뒤 요청자가 낸다»로 잇는다(animatic · live_generation).
    from app.models.pm import Story
    from app.models.recipe_role_binding import RecipeRoleBinding

    project_id = (await s.get(Story, story_id)).project_id
    for bound_stage, member_id in (
        ("draft", creator_id), ("structure_passed", owner_member_id), ("live_generation", creator_id),
        ("verification", creator_id), ("editing", creator_id),
    ):
        s.add(RecipeRoleBinding(
            id=uuid.uuid4(), org_id=org_id, project_id=project_id, event_definition_key=_KEY,
            stage=bound_stage, agent_member_id=member_id,
        ))
    await s.commit()

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

    # story #4251 — ⓒ 뒤 pending_approval로 바로 건너뛸 수 없다(STAGE_NOT_NEXT). 사이 stage를 순서대로 낸다(test_4050 관통과 같은 순서).
    await _publish("live_generation", actor_id=owner_member_id)
    await _publish("verification", actor_id=creator_id)
    await _publish("editing", actor_id=creator_id)
    await _publish("pending_approval", actor_id=creator_id)
    gate_d = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish", Gate.scope_key == "")
    )).scalar_one()
    assert gate_d.status == "pending"
    return gate_d.id


async def _approve_and_schedule_submit(s, *, org_id, story_id, creator_id, owner_member_id, connection_id):
    """채널 포스트 초안 생성+**예약 제출**(scheduled_at=+5분) → ⓓ 승인 → 캐스케이드 승계(훅B)+AC2 훅이 예약
    큐잉(gate.publish_outcome="scheduled")까지. 반환: (gate_d_id, scoped_gate_id, draft_id).

    정정(story #4190, PO 판정 2026-09-23) — 옛 순서(ⓓ 먼저 승인 → 초안 제출, 훅A 자동충족)는 ⓓ 승인 화면에 없던
    초안이라 이제 승계되지 않는다. 이 파일이 재는 것은 워커 경로(#4093)라 승계 순서만 draft 선제출로 바꾼다."""
    from app.services.channel_posts import create_channel_post_draft_version, submit_channel_post_draft
    from app.services.gate_service import transition_gate

    gate_d_id = await _walk_to_pending_approval_with_abc_approved(
        s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
    )

    version, _channel, _violations = await create_channel_post_draft_version(
        s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
        text="예약 발행 본문", link_url=None, author_member_id=creator_id, author_kind="agent",
    )
    scoped_gate, _version_id = await submit_channel_post_draft(
        s, org_id=org_id, draft_id=version.draft_id, version_id=None, requester_member_id=creator_id,
        scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )
    assert scoped_gate.status == "pending"
    scoped_gate_id = scoped_gate.id

    await transition_gate(s, org_id, gate_d_id, "approved", owner_member_id, "ⓓ 발행 승인", reviewed_draft=await reviewed_draft_for(s, org_id=org_id, work_item_id=story_id))
    await s.commit()

    from app.models.gate import Gate

    scoped_gate = await s.get(Gate, scoped_gate_id)
    await s.refresh(scoped_gate)
    assert scoped_gate.status == "approved", "캐스케이드 승계가 안 먹었다"
    return gate_d_id, scoped_gate_id, version.draft_id


@pytest.mark.anyio
async def test_ac1_worker_due_publish_emits_recipe_published_stage_event_once():
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.routers.events import _find_existing_stage_publish
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            from tests.conftest import seed_org_with_human_owner

            org_id, project_id, owner_member_id = await seed_org_with_human_owner(s, slug="4093a", org_name="Org4093")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

            gate_d_id, scoped_gate_id, draft_id = await _approve_and_schedule_submit(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
                connection_id=connection_id,
            )

            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.publish_outcome == "scheduled", f"예약 큐잉 outcome 갱신 안 됨: {gate_d.publish_outcome!r}"

            # 아직 워커가 안 돌았으므로 published 이벤트 0건.
            not_yet = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert not_yet is None

        async with Session() as s:
            # due 시각 경과 후 워커 tick.
            counts = await process_due_publication_commands(s, now=datetime.now(timezone.utc) + timedelta(minutes=10))
            assert counts["completed"] == 1, f"워커가 완료로 안 셈: {counts}"

        async with Session() as s:
            publication = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            assert publication is not None and publication.status == "published"

            published_event = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert published_event is not None, "워커 실발행 뒤 레시피 published stage 이벤트가 안 났다"

            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.publish_outcome == "published", (
                f"워커 발행 성공 뒤 publish_outcome이 갱신 안 됨: {gate_d.publish_outcome!r}"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_worker_publish_failure_emits_zero_events_and_records_machine_outcome():
    """음성 대조 — 워커가 실제로 발행에 실패하면(연결 비활성) published 이벤트 0·
    gate.publish_outcome은 실패 사유(기계 필드)만, 승인자 본인 resolution_note는
    무변."""
    from app.models.channel_connection import ChannelConnection
    from app.models.gate import Gate
    from app.routers.events import _find_existing_stage_publish
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            from tests.conftest import seed_org_with_human_owner

            org_id, project_id, owner_member_id = await seed_org_with_human_owner(s, slug="4093b", org_name="Org4093")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

            gate_d_id, scoped_gate_id, draft_id = await _approve_and_schedule_submit(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
                connection_id=connection_id,
            )

            # 예약 대기 中 연결이 비활성화됨(실사고 재현 — 토큰 만료 등).
            connection = await s.get(ChannelConnection, connection_id)
            connection.status = "expired"
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s, now=datetime.now(timezone.utc) + timedelta(minutes=10))
            assert counts["completed"] == 0, f"실패해야 하는데 완료로 셈: {counts}"

        async with Session() as s:
            published_event = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert published_event is None, "발행 실패했는데 published 이벤트가 났다"

            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.publish_outcome is not None and gate_d.publish_outcome.startswith("publish_failed:"), (
                f"실패 사유 코드가 publish_outcome에 안 남음: {gate_d.publish_outcome!r}"
            )
            assert gate_d.resolution_note == "ⓓ 발행 승인", "AC2 훅이 승인자 본인 resolution_note를 건드렸다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac3_duplicate_worker_tick_does_not_duplicate_published_event():
    """중복 발행 0 — 같은 command가 이미 completed인 상태에서(겹친 tick 재현: 워커
    성공 처리부를 한 번 더 직접 호출) 재실행돼도 published 이벤트는 1건 그대로."""
    from app.models.gate import Gate
    from app.routers.events import _find_existing_stage_publish
    from app.services.channel_posts import (
        emit_recipe_published_stage_event, resolve_recipe_context_for_scheduled_publication,
    )
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import func, select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            from tests.conftest import seed_org_with_human_owner

            org_id, project_id, owner_member_id = await seed_org_with_human_owner(s, slug="4093c", org_name="Org4093")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

            gate_d_id, scoped_gate_id, draft_id = await _approve_and_schedule_submit(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
                connection_id=connection_id,
            )

        async with Session() as s:
            counts = await process_due_publication_commands(s, now=datetime.now(timezone.utc) + timedelta(minutes=10))
            assert counts["completed"] == 1

        # 겹친 tick 재현 — 이미 completed된 뒤 같은 work_item/connection에 대해 훅을
        # 한 번 더 직접 호출(process_due_publication_commands 자체는 status='pending'만
        # 집으므로 같은 command를 재처리 안 하지만, emit 훅 자체의 멱등성을 직접 잰다).
        async with Session() as s:
            from app.models.pm import Story  # noqa: F401 (경로 확인용, 미사용 억제)

            recipe_ctx = await resolve_recipe_context_for_scheduled_publication(
                s, org_id=org_id, work_item_id=story_id, connection_id=connection_id,
            )
            assert recipe_ctx is not None
            _gate, definition_key, next_stage = recipe_ctx
            assert _gate.work_item_type == "story"
            await emit_recipe_published_stage_event(
                s, org_id=org_id, work_item_type=_gate.work_item_type, work_item_id=story_id,
                definition_key=definition_key, next_stage=next_stage,
            )
            await s.commit()

        async with Session() as s:
            from app.models.conversation import Conversation, ConversationMessage

            count = (await s.execute(
                select(func.count(ConversationMessage.id))
                .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
                .where(
                    Conversation.org_id == org_id,
                    ConversationMessage.msg_metadata["event"]["event_key"].astext == _KEY,
                    ConversationMessage.msg_metadata["event"]["payload"]["stage"].astext == "published",
                )
            )).scalar_one()
            assert count == 1, f"published 이벤트가 중복 발행됐다: {count}건"
    finally:
        await engine.dispose()
