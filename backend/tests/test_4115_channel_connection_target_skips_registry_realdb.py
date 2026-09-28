"""story #4115([E-RECIPE-1] apply 준비 경고 — channel_connection-target stage 레지스트리
오검사) — 라이브 실사고(2026-09-21 14:58Z, 5회째 배포·PO Test Org db474a4e): v2 마케팅
적용 다이얼로그에서 발행자=«Instagram Sandbox»(활성 채널 연결 보유)를 골라도 apply
준비 경고 루프가 capability.kind만 보고 org_connectors 레지스트리(설정 스킬이 에이전트
손으로 등록하는 것 — connectors.py, 이 카드에서 코드로 확認)를 물어 «채널을 먼저
연결하세요»(이미 연결돼 있는데) 거짓 경고를 냈다.

세팅 헬퍼는 test_3317b_recipe_capability_apply_check.py의 확립된 하네스(발명 0)를
재사용."""
from __future__ import annotations

import uuid

import pytest

from tests.test_3317b_recipe_capability_apply_check import (
    _auth,
    _realdb_session,
    _register_connector_from_fixture,
    _seed_agent,
    _seed_definition,
    _seed_org_project,
    _STIBEE_FIXTURE,
)

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = [pytest.mark.destructive_schema, pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _configure_generation_connector_secret(monkeypatch):
    """test_4101_generation_connector_realdb.py의 crypto 시크릿 격리 관례 그대로 미러 —
    이 파일의 마지막 테스트(generation_connector-target 양성대조)가 커넥터를 암호화해
    등록해야 해서 필요."""
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(
        config_module.settings, "generation_connector_credential_encryption_key", Fernet.generate_key().decode(),
    )
    import app.services.generation_connector_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


async def _seed_channel_connection(session, org_id, *, channel="instagram", account_id="acct-sandbox", status="active"):
    from app.models.channel_connection import ChannelConnection

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel, account_id=account_id,
        account_label="Instagram Sandbox", status=status,
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _seed_generation_connector(session, org_id, *, status="active", label="v1"):
    from app.models.org_generation_connector import OrgGenerationConnector
    from app.services.generation_connector_credential_crypto import encrypt_generation_connector_credential

    c = OrgGenerationConnector(
        id=uuid.uuid4(), org_id=org_id, provider_key="vertex_gemini", label=label,
        model_config_json={"image": "gemini-2.5-flash-image"},
        encrypted_credentials=encrypt_generation_connector_credential("super-secret-api-key"),
        status=status,
    )
    session.add(c)
    await session.commit()
    return c.id


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_channel_connection_target_stage_yields_no_warning_with_zero_registry_rows():
    """story #4115 AC1 케이스①(경고 0) — 라이브 실사고 재현. Publisher stage(target=
    channel_connection)에 활성 채널 연결을 바인딩 — org_connectors 레지스트리는 0건이어도
    (레지스트리는 애초에 이 target의 준비 축이 아니다) warnings=[]이어야 한다."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c4115a")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            connection_id = await _seed_channel_connection(s, org_id)
            # org_connectors 레지스트리는 등록 0건(라이브 실사고 조건 그대로).

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c4115a.recipe_cap",
                stage_metadata={
                    "published": {
                        "role": "Publisher", "action": "발행",
                        "capability": {"kind": "publish", "target": "channel_connection"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"published": str(connection_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.ok
            assert resp.warnings == []
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_agent_target_kind_only_stage_still_warns_zero_registry_rows():
    """story #4115 AC1 케이스②(경고 1, 회귀 무변) — target="channel_connection"이 아닌
    (기본값 "agent") kind-only stage는 이 카드의 스킵 대상이 아니다 — 레지스트리가 실제로
    그 stage의 준비 축이므로 0건이면 여전히 경고 1건(test_3317b의 기존 계약과 동형,
    이 카드가 그 계약을 깨지 않는지 직접 재확認)."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c4115b")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c4115b.recipe_cap",
                stage_metadata={
                    "publish": {"role": "Agent", "action": "발행", "capability": {"kind": "publish"}},
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "publish" in resp.warnings[0] or "발행" in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_channel_connection_target_stage_still_no_warning_when_registry_also_has_rows():
    """story #4115 AC1 케이스③(경고 0, 뭉클랩형 회귀 무변) — 채널 연결과 org_connectors
    레지스트리가 둘 다 있는 org(뭉클랩 실물이 이 형태라 버그가 안 보였다)에서도
    channel_connection-target stage는 여전히 레지스트리를 안 본다 — 있든 없든 결과가
    같아야(스킵이 "우연히 통과"가 아니라 "그 축 자체를 안 봄"이라는 증거)."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c4115c")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            connection_id = await _seed_channel_connection(s, org_id, channel="stibee", account_id="acct-stibee")
            # 뭉클랩형 — org_connectors 레지스트리에도 같은 kind를 지원하는 커넥터가 등록됨.
            await _register_connector_from_fixture(s, org_id, _STIBEE_FIXTURE)

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c4115c.recipe_cap",
                stage_metadata={
                    "published": {
                        "role": "Publisher", "action": "발행",
                        "capability": {"kind": "publish", "target": "channel_connection"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"published": str(connection_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.warnings == []
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_remaining_warning_tails_point_to_publisher_agent_not_org_settings():
    """story #4115 AC2 — 남는 경고(레지스트리가 실제 준비 축인 kind-only stage) 문장의
    목적지가 "조직 설정에서 채널을 연결하세요"(틀린 세계) 대신 "담당 발행 에이전트가
    설정해야 해요"(실물 — connectors.py POST가 org member/에이전트 호출, owner/admin
    전용 아님을 코드로 확認)로 바뀌었는지 고정."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c4115d")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c4115d.recipe_cap",
                stage_metadata={
                    "publish": {"role": "Agent", "action": "발행", "capability": {"kind": "publish"}},
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "담당 발행 에이전트" in resp.warnings[0]
            assert "채널을 먼저 연결하세요" not in resp.warnings[0]
            assert "조직 설정" not in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_generation_connector_target_stage_with_non_agent_tool_kind_yields_no_warning():
    """story #4115 CHANGES(페드루 PO 리뷰, 2026-09-21) — 스킵을 channel_connection뿐
    아니라 generation_connector-target까지 넓힌 것의 양성대조. kind="publish"는
    _AGENT_TOOL_CAPABILITY_KINDS(attach_video/generate) **밖**이라 기존 kind 기반
    스킵으로는 안 걸린다 — target 기반 스킵이 이 카드에서 새로 추가되기 前엔 이
    케이스가 org_connectors(채널) 레지스트리를 오검사해 경고 1건을 냈을 것(넓히기
    前 RED가 이 양성대조의 핵심). 넓힌 뒤에는 target 자체로 걸러져 경고 0."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c4115e")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            connector_id = await _seed_generation_connector(s, org_id)
            # org_connectors(채널 레지스트리)는 0건 — generation_connector-target은
            # 애초에 그 레지스트리와 무관해야 한다(준비 판정은 apply 본문 422가 이미 함).

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c4115e.recipe_cap",
                stage_metadata={
                    "compute": {
                        "role": "Compute", "action": "생성 실행",
                        "capability": {"kind": "publish", "target": "generation_connector"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"compute": str(connector_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.warnings == []
    finally:
        await engine.dispose()
