"""story #4090([E-RECIPE-1] Publisher 슬롯) AC1 — capability.target="channel_connection"
인 stage(Publisher)는 role_mapping 값을 TeamMember가 아니라 ChannelConnection으로
검증·저장한다(alembic 0385, 페드루 PO 確定 2026-09-21).

판별축은 capability.**target**(닫힌 어휘)이지 capability.kind가 아니다 — kind는 열린
값이라 기존 정의(#3317 PR B, test_3317b/test_3359)가 "kind='publish' + agent 바인딩"을
이미 쓰고 있어 kind로 판별하면 그 계약을 깬다. 이 파일의 픽스처는 그래서 stage 이름과
capability.kind를 test_3288/test_3317b 관례와 다르게(퍼블리셔 stage) 잡고, target만
명시로 선언한다 — 기존 회귀 7건(무변으로 남긴)과는 겹치지 않는 별도 클래스."""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

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


async def _realdb_session():
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
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session, *, slug="e4090"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4090", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human_caller(session, org_id, project_id, *, name="caller"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_channel_connection(session, org_id, *, channel="sandbox", account_id="acct-1"):
    from app.models.channel_connection import ChannelConnection

    c = ChannelConnection(id=uuid.uuid4(), org_id=org_id, channel=channel, account_id=account_id)
    session.add(c)
    await session.commit()
    return c.id


_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["creation", "release"]},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
    },
}
_ROUTING = {
    "escalation": {"kind": "recipe_role_binding"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}
_STAGE_METADATA = {
    "creation": {"role": "Creator", "action": "만든다"},
    "release": {
        "role": "Publisher", "action": "승인된 채널에 실 게시",
        "capability": {"kind": "publish", "target": "channel_connection"},
    },
}


async def _seed_definition(session, *, key="preset.e4090.release"):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=None, payload_schema=_PAYLOAD_SCHEMA,
        routing=_ROUTING, stage_metadata=_STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d


def _auth(caller_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(caller_id), email=None, claims={}, org_id=str(org_id))


@pytest.mark.anyio
async def test_apply_binds_channel_connection_for_publish_target_stage():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            connection_id = await _seed_channel_connection(s, org_id)

            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"release": str(connection_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.ok and resp.bindings_upserted == 1

            from sqlalchemy import select
            from app.models.recipe_role_binding import RecipeRoleBinding
            row = (await s.execute(
                select(RecipeRoleBinding).where(
                    RecipeRoleBinding.org_id == org_id, RecipeRoleBinding.event_definition_key == definition.key,
                    RecipeRoleBinding.stage == "release",
                )
            )).scalar_one()
            assert row.channel_connection_id == connection_id
            assert row.agent_member_id is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_rejects_channel_connection_from_other_org():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e4090-a")
            other_org_id, _ = await _seed_org_project(s, slug="e4090-b")
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            other_connection_id = await _seed_channel_connection(s, other_org_id)

            with pytest.raises(HTTPException) as exc_info:
                await apply_recipe_role_bindings(
                    definition.id,
                    ApplyRecipeRoleBindingsRequest(
                        project_id=project_id, role_mapping={"release": str(other_connection_id)},
                    ),
                    db=s, auth=_auth(caller_id, org_id), org_id=org_id,
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_rejects_agent_id_for_channel_target_stage():
    """agent_id를 channel-대상 stage에 넣으면 ChannelConnection 테이블에서 안 찾아져
    (다른 테이블 PK라 우연히 겹칠 확률 0에 가깝다) 422 — 사일런트 오배선 방지."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            agent_id = await _seed_agent(s, org_id, project_id)

            with pytest.raises(HTTPException) as exc_info:
                await apply_recipe_role_bindings(
                    definition.id,
                    ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"release": str(agent_id)}),
                    db=s, auth=_auth(caller_id, org_id), org_id=org_id,
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_mixed_agent_and_channel_stages_in_same_request():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            agent_id = await _seed_agent(s, org_id, project_id, name="creator")
            connection_id = await _seed_channel_connection(s, org_id)

            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(
                    project_id=project_id,
                    role_mapping={"creation": str(agent_id), "release": str(connection_id)},
                ),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.ok and resp.bindings_upserted == 2

            from app.routers.events import get_recipe_role_bindings
            read = await get_recipe_role_bindings(
                definition.id, project_id=project_id, db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert read.bindings == {"creation": str(agent_id), "release": str(connection_id)}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reapply_channel_stage_upsert_does_not_violate_check_constraint():
    """재-apply(같은 stage를 다른 channel_connection으로 교체)가 기존 행의
    channel_connection_id만 갈아치우고 agent_member_id는 계속 NULL로 남아야 한다 —
    한쪽만 setattr하면 XOR CHECK가 깨진다(events.py 주석의 그 위험을 직접 실행해 확認)."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            connection_a = await _seed_channel_connection(s, org_id, account_id="acct-a")
            connection_b = await _seed_channel_connection(s, org_id, account_id="acct-b")

            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"release": str(connection_a)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            resp2 = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"release": str(connection_b)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp2.ok and resp2.bindings_upserted == 1

            from sqlalchemy import select
            from app.models.recipe_role_binding import RecipeRoleBinding
            rows = (await s.execute(
                select(RecipeRoleBinding).where(
                    RecipeRoleBinding.org_id == org_id, RecipeRoleBinding.event_definition_key == definition.key,
                    RecipeRoleBinding.stage == "release",
                )
            )).scalars().all()
            assert len(rows) == 1, "재-apply는 새 행이 아니라 기존 행을 갱신해야 한다(upsert)"
            assert rows[0].channel_connection_id == connection_b
            assert rows[0].agent_member_id is None
    finally:
        await engine.dispose()
