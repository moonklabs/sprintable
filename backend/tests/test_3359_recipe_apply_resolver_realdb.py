"""story #3359 — apply_recipe_role_bindings의 정적 capability 경고가 하드코딩이 아니라
resolve_connector_key_for_channel 리졸버를 실제로 거친다는 증거(realdb). test_3317b의
세팅 헬퍼(_seed_org_project/_seed_agent/_seed_definition/_register_connector_from_
fixture/_auth)를 재사용한다(중복 재발명 금지, 이 파일과 동형 관례)."""
from __future__ import annotations

import uuid

import pytest

from tests.test_3317b_recipe_capability_apply_check import (
    _STIBEE_FIXTURE,
    _THREADS_FIXTURE,
    _auth,
    _realdb_session,
    _register_connector_from_fixture,
    _seed_agent,
    _seed_definition,
    _seed_org_project,
)

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = [pytest.mark.destructive_schema, pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_org_override_changes_which_connector_the_warning_checks():
    """뮤테이션 킬 — capability.connector_key="threads"인데 org가 channel_connector_map으로
    threads→stibee를 override했으면, 경고는 threads가 아니라 stibee 등록 여부를 본다(리졸버를
    실제로 거친다는 증거 — 하드코딩이면 이 override는 무시되고 여전히 threads를 본다)."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings
    from app.services.content_rules import put_org_content_rules

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c3359a")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            # threads는 등록(충족), stibee는 미등록 — override 전이면 threads라 경고 0.
            await _register_connector_from_fixture(s, org_id, _THREADS_FIXTURE)
            await put_org_content_rules(
                s, org_id=org_id, rules={"channel_connector_map": {"threads": "stibee"}},
                expected_version=0, updated_by_member_id=None,
            )

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c3359a.recipe_cap",
                stage_metadata={
                    "publish": {
                        "role": "Agent", "action": "발행",
                        "capability": {"kind": "publish", "connector_key": "threads"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "stibee" in resp.warnings[0]
            assert "connector_key='stibee'" in resp.warnings[0] or "stibee" in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_unmapped_alias_states_missing_mapping_not_registered():
    """capability.connector_key="blog"(레지스트리 어디에도 없는 별칭, org override도
    없음) → 옛 "커넥터가 등록돼 있지 않습니다"가 아니라 "channel=blog에 대한 커넥터
    매핑이 없습니다"로 원인이 다르게 명시된다(등록 문제와 매핑 문제를 안 섞는다)."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c3359b")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c3359b.recipe_cap",
                stage_metadata={
                    "publish": {
                        "role": "Agent", "action": "발행",
                        "capability": {"kind": "publish", "connector_key": "blog"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "channel='blog'" in resp.warnings[0]
            assert "매핑이 없습니다" in resp.warnings[0]
            assert "등록돼 있지" not in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
async def test_org_override_resolving_alias_to_registered_connector_yields_no_warning():
    """org가 blog→site_git을 등록하고 site_git 커넥터가 실제로 이 org에 완전 등록돼
    있으면 경고 0 — 별칭도 org override를 거치면 정상 통과한다는 증거."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings
    from app.services.connector_registry import set_org_connector_schema
    from app.services.content_rules import put_org_content_rules

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c3359c")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")

            # site_git은 org_config 필드가 없어(자격증명은 조직 저장소 좌표라 실제로는
            # source='org_config' 필드가 있지만 이 테스트는 등록 자체만 본다) fields=[]
            # 로도 missing_required_org_config가 빈 목록을 낸다 — 경고 0 확인용 최소셋.
            await set_org_connector_schema(
                s, org_id=org_id, connector_key="site_git", version="1.0.0", channel="site_git",
                fields=[], requires_env=[], kinds=["publish"], created_by=None,
            )

            await put_org_content_rules(
                s, org_id=org_id, rules={"channel_connector_map": {"blog": "site_git"}},
                expected_version=0, updated_by_member_id=None,
            )

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c3359c.recipe_cap",
                stage_metadata={
                    "publish": {
                        "role": "Agent", "action": "발행",
                        "capability": {"kind": "publish", "connector_key": "blog"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.warnings == []
    finally:
        await engine.dispose()
