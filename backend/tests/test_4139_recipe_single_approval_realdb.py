"""story #4139([E-RECIPE-1] Phase3 폴리시, 페드루 PO 確定 2026-09-22) — 레시피 발행 단계에서
사람 승인이 «2회»가 되던 라이브 실측(2호, fef381ca·060ddf32) 처방.

그라운딩(착수 前 페드루 PO에 보고, 2026-09-22 02:11Z) — 스토리 원안의 "레시피가 초안 scoped
게이트를 «대신 결재»하는 경로가 없다"는 전제 자체가 틀렸다: story #4069(훅B, gate_service.py
::transition_gate approved 분기)가 정확히 그 메커니즘이다(레시피 unscoped external_publish
게이트가 approved로 전이되는 순간, 같은 work_item의 단일-목적지 pending scoped external_
publish 게이트를 같은 승인자·시각으로 승계-승인 + publish_recipe_approved_draft까지 같은
트랜잭션서 실행). 실측 2호가 그럼에도 «둘 다» 결재함에 떴던 진짜 원인은 **가시성**이었다 —
scoped 게이트가 create_gate 시점에 무조건 pending(requires_human=True)으로 열리고,
list_gates(결재함 인박스)는 Gate.status=='pending'만 볼 뿐 「곧 캐스케이드로 승계될 것」을
구분하지 않아 사람이 먼저 눌러버릴 수 있었다(기능은 안 깨지지만 클릭 수가 그대로 2).

페드루 PO 지시 방향(2026-09-22 02:14Z) — requires_human==(status=='pending') SSOT 불변식은
안 깨고, 새 status도 안 만든다. **파생값 + 인박스 필터**:
  ① GateResponse.deferred_to_gate_id(저장 컬럼 0·마이그 0) — 이 scoped 게이트가 레시피
     unscoped 게이트에 대신 결재되는 대상이면 그 레시피 게이트 id.
  ② list_gates의 assigned_to_me(인박스) 경로가 deferred_to_gate_id 있는 scoped 게이트를
     제외.
  ③ 게이트 상세는 「레시피 게이트에서 함께 결재돼요」+링크(액션 버튼 숨김·직접 승인은 안 막음
     — 멱등이라 위험 없음, FE gates/[id]/page.tsx).
  ④ 레시피 게이트 카드(find_ready_recipe_channel_drafts)가 단일-목적지 pending scoped도
     ready로 잡아 「승인해도 발행되지 않아요」 거짓 경고를 없앤다.
  ⑤ 훅B는 approved만 캐스케이드하므로 rejected도 같은 조건으로 동행 기록(신규).

이 파일은 ②(인박스 제외)·①(필드 값)·⑤(반려 동행)·비레시피 회귀를 pin한다. ④(콘텐츠
미리보기)는 test_4098_gate_linked_channel_draft_realdb.py가, 승인 캐스케이드 자체(#4069)는
test_4069_recipe_single_destination_auto_satisfy_realdb.py가 이미 pin한다(재구현 0)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
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


_MIG_0381 = _load_migration_module("0381_preset_marketing_video_production_recipe.py", "_m0381_4139")
_MIG_0382 = _load_migration_module(
    "0382_recipe_video_production_structure_and_budget_gates.py", "_m0382_4139",
)
_MIG_0387 = _load_migration_module(
    "0387_recipe_role_binding_channel_connection.py", "_m0387_4139",
)
_KEY = "preset.4139.video_production"
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


async def _seed_org_with_owner_shim(session, *, slug):
    from tests.conftest import seed_org_with_human_owner

    return await seed_org_with_human_owner(session, slug=slug, org_name="Org4139")


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="AC4139"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=None, name="영상 제작(#4139 테스트)",
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


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    """`_auth()`(위)는 항상 api_key claim을 실어 agent/API-key 해소 경로(TeamMember.id==
    auth.user_id)로 간다 — `list_gates`의 assigned_to_me(rule B, _non_doc_gate_approvable
    ::get_project_role)는 **JWT-휴먼 축**(org_members.user_id, `User.id`와 같은 공간)을
    본다(_non_doc_can_approve 문서화된 "user_id는 user 축·member 축과 다른 공간" 함정 —
    바로 그 축을 여기서 다시 밟지 않으려면 api_key claim 없는 순수 JWT 형태가 필요하다).
    claims에 app_metadata/api_key_id를 아예 안 실어 `is_api_key=False`로 강제."""
    from app.dependencies.auth import AuthContext

    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))


async def _owner_user_id(session, owner_member_id: uuid.UUID) -> uuid.UUID:
    from sqlalchemy import select

    from app.models.project import OrgMember

    return (await session.execute(
        select(OrgMember.user_id).where(OrgMember.id == owner_member_id)
    )).scalar_one()


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


async def _submit_draft(s, *, org_id, story_id, connection_id, creator_id, text="AC4139 본문"):
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
async def test_ac1_single_destination_deferred_scoped_gate_excluded_from_inbox_recipe_gate_stays():
    """AC1 — 레시피 문맥에서 제출된(단일 목적지) 채널 초안의 scoped 게이트는 사람 결재함
    (list_gates assigned_to_me=True)에 «추가로» 안 뜬다. 레시피 게이트 자신은 정상적으로
    뜬다(«①→② 두 번»이 아니라 «①만»)."""
    from app.models.gate import Gate
    from app.routers.gates import list_gates

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4139a")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            # ⓓ(레시피 게이트) 승인 前에 제출 — scoped 게이트가 pending으로 열린다.
            _draft_id, scoped_gate = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_id, creator_id=creator_id,
            )
            scoped_gate_id = scoped_gate.id

        async with Session() as s:
            owner_user_id = await _owner_user_id(s, owner_member_id)
            inbox = await list_gates(
                work_item_id=None, work_item_type=None, status="pending", sort=None,
                assigned_to_me=True, ids=None, gate_type=None, limit=None, offset=0,
                session=s, org_id=org_id, auth=_human_auth(owner_user_id, org_id),
            )
            inbox_ids = {r.id for r in inbox}
            assert scoped_gate_id not in inbox_ids, "레시피가 대신 결재하는 scoped 게이트가 인박스에 추가로 떴다(AC1 위반)"
            assert gate_d_id in inbox_ids, "레시피 게이트 자신은 여전히 인박스에 있어야 한다"

            gate_d = await s.get(Gate, gate_d_id)
            scoped_gate = await s.get(Gate, scoped_gate_id)
            assert gate_d.status == "pending"
            assert scoped_gate.status == "pending", "인박스에서만 빠질 뿐 실제 상태는 아직 pending이어야 한다(캐스케이드는 승인 시점)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac1_multi_destination_pending_scoped_gates_stay_in_inbox_regression():
    """AC4 — 목적지 2개면 #4069/#4139 단일-목적지 조건이 성립 안 해 캐스케이드 대상이
    아니다(#3478류, 각자 사람 승인 필요) — 둘 다 여전히 인박스에 정상적으로 뜬다(회귀
    가드, deferred_to_gate_id가 여기서 잘못 채워지면 두 목적지 모두 승인자 시야에서
    사라지는 훨씬 나쁜 사고가 된다)."""
    from app.routers.gates import list_gates

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4139b")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_a = await _seed_sandbox_connection(s, org_id, account_id="acct-a")
            connection_b = await _seed_sandbox_connection(s, org_id, account_id="acct-b")
            await _seed_recipe_channel_binding(s, org_id, connection_a)

            await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            _draft_a, scoped_gate_a = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_a, creator_id=creator_id,
                text="목적지 A",
            )
            _draft_b, scoped_gate_b = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_b, creator_id=creator_id,
                text="목적지 B",
            )
            scoped_gate_a_id, scoped_gate_b_id = scoped_gate_a.id, scoped_gate_b.id

        async with Session() as s:
            owner_user_id = await _owner_user_id(s, owner_member_id)
            inbox = await list_gates(
                work_item_id=None, work_item_type=None, status="pending", sort=None,
                assigned_to_me=True, ids=None, gate_type=None, limit=None, offset=0,
                session=s, org_id=org_id, auth=_human_auth(owner_user_id, org_id),
            )
            inbox_ids = {r.id for r in inbox}
            assert scoped_gate_a_id in inbox_ids
            assert scoped_gate_b_id in inbox_ids
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_deferred_to_gate_id_none_for_non_recipe_channel_post_regression():
    """비레시피 채널 포스트(레시피 문맥 자체가 없는 — 사람이 손으로 만든 채널 포스트)는
    linked_channel_draft/deferred_to_gate_id 축과 완전히 무관해야 한다(회귀 0). unscoped
    레시피 게이트가 애초에 없으므로 find_pending_recipe_external_publish_gate가 None을
    반환해 이 함수의 나머지 줄에 절대 안 들어간다."""
    from app.routers.gates import to_gate_response

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4139c")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="선생님 손")
            story_id = await _seed_story(s, org_id, project_id, title="비레시피 손작업 포스트")
            connection_id = await _seed_sandbox_connection(s, org_id)

            _draft_id, scoped_gate = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_id, creator_id=creator_id,
                text="레시피 무관 손작업 초안",
            )
            scoped_gate_id = scoped_gate.id

        async with Session() as s:
            from app.models.gate import Gate

            fetched = await s.get(Gate, scoped_gate_id)
            resp = await to_gate_response(s, org_id, fetched)
            assert resp.deferred_to_gate_id is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reject_cascade_single_destination_scoped_gate_rejected_together():
    """AC2(반려 동행) — 레시피 게이트가 반려되면, 단일 목적지의 pending scoped 게이트도
    같은 승인자·시각·사유로 같이 반려된다(승인 캐스케이드 #4069의 반려 대칭, story #4139
    신규) — 사람이 인박스에서 못 보는 그 게이트가 레시피 반려 뒤에도 영원히 pending으로
    남는 걸 막는다."""
    from app.models.gate import Gate
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4139d")
            await _seed_default_role(s, org_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)

            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )
            _draft_id, scoped_gate = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_id, creator_id=creator_id,
            )
            scoped_gate_id = scoped_gate.id

            await transition_gate(s, org_id, gate_d_id, "rejected", owner_member_id, "테스트 반려 사유")
            await s.commit()

        async with Session() as s:
            gate_d = await s.get(Gate, gate_d_id)
            scoped_gate = await s.get(Gate, scoped_gate_id)
            assert gate_d.status == "rejected"
            assert scoped_gate.status == "rejected", "레시피 게이트 반려가 단일 목적지 scoped 게이트에 동행하지 않았다"
            assert scoped_gate.resolver_id == gate_d.resolver_id
            assert scoped_gate.resolved_at == gate_d.resolved_at
            assert scoped_gate.resolution_note == (
                "auto_rejected_by_recipe_external_publish_gate: single destination (story #4139)"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reject_cascade_multi_destination_not_auto_rejected_regression():
    """반려 캐스케이드도 승인 캐스케이드와 동일하게 단일 목적지일 때만(#3478류, 2개
    이상은 각자 사람 판단 유지) — 다중 목적지는 레시피 반려에도 scoped 게이트들이
    그대로 pending으로 남아야 한다(자동 반려되면 사람이 검토할 기회 자체를 잃는다)."""
    from app.models.gate import Gate
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner_shim(s, slug="4139e")
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
            _draft_a, scoped_gate_a = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_a, creator_id=creator_id,
                text="목적지 A",
            )
            _draft_b, scoped_gate_b = await _submit_draft(
                s, org_id=org_id, story_id=story_id, connection_id=connection_b, creator_id=creator_id,
                text="목적지 B",
            )
            scoped_gate_a_id, scoped_gate_b_id = scoped_gate_a.id, scoped_gate_b.id

            await transition_gate(s, org_id, gate_d_id, "rejected", owner_member_id, "테스트 반려 사유")
            await s.commit()

        async with Session() as s:
            scoped_gate_a = await s.get(Gate, scoped_gate_a_id)
            scoped_gate_b = await s.get(Gate, scoped_gate_b_id)
            assert scoped_gate_a.status == "pending"
            assert scoped_gate_b.status == "pending"
    finally:
        await engine.dispose()
