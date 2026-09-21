"""story #4119([E-RECIPE-1] apply 준비 경고 {kind} 한글 라벨) — #4108이 stage_metadata
[stage].role을 한글 라벨로 바꿨지만 capability.kind는 영어 식별자(publish/collect)
그대로 화면에 실렸다(유나 #4115 앵커 비차단 지적). capability.kind는 열린 값이라
(event_definition_registry.py 49행 — 판별 기준으로 못 씀) stage_role과 동형으로 닫힌
라벨 집합(events.py `_CAPABILITY_KIND_LABEL_KEYS`, 현재 publish/collect) + 미등재
raw pass-through로 고친다.

세팅 헬퍼는 test_3317b_recipe_capability_apply_check.py의 확립된 하네스(발명 0)를
재사용 — kind-only(target="agent" 기본값, org_connectors 레지스트리가 실제 준비 축인)
stage에 레지스트리 0건으로 「등록 안 됨」 경고(apply_kind_connector_not_registered)를
유도해 그 문장의 {kind} 치환값을 pin한다."""
from __future__ import annotations

import pytest

from tests.test_3317b_recipe_capability_apply_check import (
    _auth,
    _realdb_session,
    _seed_agent,
    _seed_definition,
    _seed_org_project,
)

pytestmark = [pytest.mark.destructive_schema, pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.skipif(
    not (__import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")),
    reason="real Postgres 필요",
)
async def test_registered_kind_publish_renders_korean_label_not_raw_identifier():
    """story #4119 AC1 등재 상태① — kind="publish"는 `_CAPABILITY_KIND_LABEL_KEYS`에
    있으므로 경고 문장의 {kind} 자리가 raw "publish"가 아니라 카탈로그 한글 라벨
    "발행"을 받아야 한다."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c4119a")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c4119a.recipe_cap",
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
            assert "발행" in resp.warnings[0]
            assert "publish" not in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(
    not (__import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")),
    reason="real Postgres 필요",
)
async def test_registered_kind_collect_renders_korean_label_not_raw_identifier():
    """story #4119 AC1 등재 상태② — kind="collect"도 같은 닫힌 집합의 두 번째 항목."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c4119b")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c4119b.recipe_cap",
                stage_metadata={
                    "monitor": {"role": "Agent", "action": "수집", "capability": {"kind": "collect"}},
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"monitor": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "수집" in resp.warnings[0]
            assert "collect" not in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(
    not (__import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")),
    reason="real Postgres 필요",
)
async def test_unregistered_kind_falls_back_to_raw_passthrough():
    """story #4119 AC1 미등재 상태 — capability.kind는 열린 값이라(닫힌 enum 아님)
    `_CAPABILITY_KIND_LABEL_KEYS`(publish/collect)에 없는 kind는 #4108의 role 규칙과
    동형으로 raw pass-through해야 한다(존재하지 않는 라벨을 지어내지 않는다)."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="c4119c")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")

            definition = await _seed_definition(
                s, org_id=org_id, key="org.c4119c.recipe_cap",
                stage_metadata={
                    "hook": {"role": "Agent", "action": "훅", "capability": {"kind": "webhook"}},
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"hook": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "webhook" in resp.warnings[0]
    finally:
        await engine.dispose()
