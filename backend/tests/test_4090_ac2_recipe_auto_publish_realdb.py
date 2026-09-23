"""story #4090([E-RECIPE-1] Publisher 슬롯) AC2(페드루 PO 確定 2026-09-21) — 레시피
`pending_approval`(external_publish, scope_key="") 게이트가 승인되면, 바인딩된 채널로
사람 클릭 0으로 실제 발행까지 잇는다(test_4069의 "발행은 여전히 사람이 /publish를
직접 눌러야" 관측을 대체 — 단, capability.target="channel_connection"이 선언된 정의
에서만. #4069 자체 픽스처(target 미선언)는 test_4069_recipe_single_destination_auto_
satisfy_realdb.py에서 그대로 회귀 0 확認됐다).

호출 지점 둘(순서 무관) — ① 승인-뒤-제출(gate_service.py::transition_gate approved
분기에 접힌 #4069 훅B + AC2 훅) ② 제출-뒤-승인(channel_posts.py::submit_channel_post_
draft의 #4069 자동충족 분기 + AC2 훅). 이 파일은 test_4069의 하네스(seed 헬퍼·ASGI
클라이언트 관례)를 그대로 복제하되 stage_metadata만 0387(AC1)의 `_NEW_STAGE_METADATA`
(published stage에 capability.target 선언)로 바꾼다 — 별도 EventDefinition.key라
test_4069와 DB 레벨에서 겹치지 않는다."""
from __future__ import annotations

import os
import uuid

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


_MIG_0381 = _load_migration_module("0381_preset_marketing_video_production_recipe.py", "_m0381_4090ac2")
_MIG_0387 = _load_migration_module(
    "0387_recipe_role_binding_channel_connection.py", "_m0387_4090ac2",
)

# story #4090 AC2 — 0382의 _NEW_PAYLOAD_SCHEMA(stage enum 등)는 0387이 안 건드리므로
# 그대로 재사용, stage_metadata만 0387._NEW_STAGE_METADATA(published에 capability.target
# 선언)로 교체 — 별도 key라 test_4069(0382 기반)와 겹치지 않는다.
_MIG_0382 = _load_migration_module(
    "0382_recipe_video_production_structure_and_budget_gates.py", "_m0382_4090ac2",
)
_KEY = "preset.4090ac2.video_production"
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
        # story #4090 AC2 — 이 파일이 처음으로 _get_or_create_system_publisher를 실제
        # 실행하는 realdb 하네스라(test_4069는 자동발행 자체가 없어 안 걸림) 0258의
        # 부분 유니크 인덱스(raw-SQL 마이그, create_all이 못 세움) 갭이 여기서 처음
        # 드러났다 — 위 entity_references와 동형 하네스 보정(제품 결함 아님).
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE runtime_type = 'system-publisher' AND type = 'agent'"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_with_owner(session, *, slug):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="Org4090AC2", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_user_id = uuid.uuid4()
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user_id, role="owner")
    session.add(owner_member)
    await session.commit()
    session.add(TeamMember(
        id=owner_member.id, org_id=org.id, project_id=project.id, type="human",
        name="org owner", is_active=True,
    ))
    await session.commit()
    return org.id, project.id, owner_member.id, owner_user_id


async def _seed_system_publisher_teammember_shim(session, org_id, project_id):
    """⛔그라운딩 갭 정정(2026-09-21, story #4093 작업 中 발견 — 발견 즉시 수정) —
    `team_members`는 실 DB에선 members/project_access 위 VIEW(0088+, `_get_or_create_
    system_publisher` 자신의 docstring도 이미 이 사실을 적어 뒀었다)지만, 이 파일의
    `Base.metadata.create_all()` 하네스는 raw op.execute로 정의된 그 VIEW를 못 만든다
    (ORM 메타데이터에 없음). 이 shim 없이는 `emit_recipe_published_stage_event`가
    published stage 이벤트 발행 內 `resolve_member`에서 "Team member not found"로
    조용히 실패해도(그 함수 자신의 try/except가 삼킨다, 승인/발행 자체는 안 막는다는
    설계 그대로) 이 파일의 기존 단언들(ChannelPublication·gate.publish_outcome)이
    전혀 못 잡았다 — 즉 지금까지 이 실측 3건 전부가 「published stage 이벤트가 실제로
    났다」는 한 번도 검증한 적이 없었다(test_3380_doc_nudge_system_sender_realdb.py의
    동형 선례를 이번에 #4093에서 재확인해 여기로 역이식). shim 자체는 test_3380과
    동형(시스템 발행자를 먼저 provision하고 그 id로 TeamMember shim 행을 심는다 —
    이후 코드의 재호출은 멱등 get-or-create라 충돌 없음)."""
    from app.models.team import TeamMember
    from app.routers.events import _get_or_create_system_publisher

    system_member = await _get_or_create_system_publisher(session, org_id)
    session.add(TeamMember(
        id=system_member.id, org_id=org_id, project_id=project_id, type="agent",
        name="시스템 발행", is_active=True,
    ))
    await session.commit()


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="AC2 자동발행"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=None, name="영상 제작(AC2 테스트)",
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


async def _seed_sandbox_connection(session, org_id, *, account_id=None):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="sandbox",
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="none", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential("sandbox-dummy-token"),
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _seed_recipe_channel_binding(session, org_id, connection_id):
    """story #4090 AC1 — published stage의 RecipeRoleBinding을 org 전역으로 직접 seed
    (apply_recipe_role_bindings 라우터 경유 없이 — AC1 자체 테스트가 그 경로는 이미
    커버, 여기선 AC2의 전제 조건만 최소로 세운다)."""
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


def _client_for(app):
    from httpx import ASGITransport, AsyncClient

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth_dep():
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth_dep


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


@pytest.mark.anyio
async def test_ac2_order_a_approve_then_submit_does_not_auto_publish():
    """순서A(승인 먼저·제출 나중) — 정정(story #4190, PO 판정 2026-09-23 «사람 승인은 그 사람이 본 내용에만
    유효하다»): ⓓ 승인 화면엔 아직 draft가 없었으므로 그 뒤 제출한 draft는 승계되지 않는다 → scoped 게이트
    pending(사람 승인) · 자동발행 0 · published stage 이벤트 0. 자동발행은 순서B(아래)로 유지된다."""
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="ac2a")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)
            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )

        # ⓓ 승인 — 아직 draft가 없으므로 「발행 안 됨」 outcome이 남아야 한다.
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/gates/{gate_d_id}/transition",
                json={"status": "approved", "note": "ⓓ 발행 승인", "evidence_viewed": True, **(await reviewed_draft_body_via(Session, org_id=org_id, work_item_id=story_id))},
            )
            assert r.status_code == 200, r.text
            assert r.json().get("publish_outcome") is not None, "승인 응답에 publish_outcome이 안 실렸다"
            assert r.json()["publish_outcome"] == "no_submitted_draft", "draft 없음 사유 코드가 승인 응답에 안 실렸다"

        # draft 제출 — ⓓ 승인이 이 draft를 본 적이 없으므로 승계 0(pending).
        _setup_org_scoped_app(app, Session, org_id, user_id=creator_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "AC2 발행 본문"},
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = uuid.UUID(r_draft.json()["draft_id"])

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            assert r_submit.json()["status"] == "pending", "ⓓ 승인 화면에 없던 draft가 승계됐다"
            scoped_gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            publication = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            assert publication is None, "사람이 본 적 없는 draft가 자동발행됐다"

            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.resolution_note == "ⓓ 발행 승인"

            from app.routers.events import _find_existing_stage_publish

            published_event = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert published_event is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_order_b_submit_then_approve_auto_publishes_without_manual_click():
    """순서B(제출 먼저·승인 나중) — draft 선제출(pending) 뒤 ⓓ 승인이 승계-승인+AC2
    자동발행까지 서비스층(gate_service.py::transition_gate, 라우터 경유 없이도)에서
    잇는지 — 라우터 훅B가 서비스층으로 접힌 것의 회귀 검증도 겸한다."""
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="ac2b")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)
            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=creator_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "AC2 선제출 본문"},
            )
            draft_id = uuid.UUID(r_draft.json()["draft_id"])
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.json()["status"] == "pending", "ⓓ 미승인 상태에서 잘못 자동충족됐다"
            scoped_gate_id = uuid.UUID(r_submit.json()["gate_id"])

        # ⓓ 승인 — 서비스 직접호출(transition_gate)로 라우터를 안 거친다. 훅B가 서비스층에
        # 있어야만 이 경로에서도 승계-승인+자동발행이 일어난다(회귀 검증 핵심).
        async with Session() as s:
            from app.services.gate_service import transition_gate

            await transition_gate(s, org_id, gate_d_id, "approved", owner_member_id, "ⓓ 발행 승인", reviewed_draft=await reviewed_draft_for(s, org_id=org_id, work_item_id=story_id))
            await s.commit()

        async with Session() as s:
            scoped_gate = await s.get(Gate, scoped_gate_id)
            assert scoped_gate.status == "approved", "서비스층 훅B가 draft 선제출 pending 게이트를 안 건드렸다"
            assert "auto_satisfied_by_recipe_external_publish_gate" in (scoped_gate.resolution_note or "")

            publication = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            assert publication is not None, "서비스 직접호출(라우터 우회) 경로에서 AC2 자동발행이 안 일어났다"
            assert publication.status == "published"

            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.publish_outcome == "published"

            from app.routers.events import _find_existing_stage_publish

            published_event = await _find_existing_stage_publish(
                s, org_id=org_id, definition_key=_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            )
            assert published_event is not None, "AC2 자동발행 뒤 레시피 published stage 이벤트가 안 났다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_no_submitted_draft_skips_with_machine_owned_outcome_not_resolution_note():
    """제출된 draft가 전혀 없으면 조용한 스킵이 아니라 `gate.publish_outcome`(기계 소유
    필드)에 사유가 남아야 하고, 승인자 본인 `resolution_note`는 절대 안 건드려야 한다
    (페드루 PO 確定 — 사람 글과 시스템 상태를 한 칸에 섞지 않는다)."""
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="ac2c")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)
            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/gates/{gate_d_id}/transition",
                json={"status": "approved", "note": "승인자의 본인 코멘트", "evidence_viewed": True},
            )
            assert r.status_code == 200, r.text
            assert r.json()["resolution_note"] == "승인자의 본인 코멘트", "AC2 훅이 승인자 note를 건드렸다"
            assert r.json().get("publish_outcome") == "no_submitted_draft", "no-draft 사유 코드가 승인 응답에 안 실렸다"

        async with Session() as s:
            gate_d = await s.get(Gate, gate_d_id)
            assert gate_d.resolution_note == "승인자의 본인 코멘트"
            assert gate_d.publish_outcome == "no_submitted_draft"

            no_publication = (await s.execute(select(ChannelPublication.id))).first()
            assert no_publication is None, "draft 없이도 ChannelPublication이 생겼다 — 생성 0 계약 위반"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
