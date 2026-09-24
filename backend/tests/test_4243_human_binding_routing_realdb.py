"""story #4243 — `either` 역할에 사람을 바인딩하면 그 stage 이벤트는 그 사람에게 간다(라우팅 실물 확인 · PO 요청).

바인딩 행은 `recipe_role_bindings.agent_member_id` 하나에 TeamMember id를 싣는다(열 이름과 달리 종류 무관). 적용 API는 그 id가
이 org의 TeamMember인지만 보고(type 필터 없음), 리졸버는 그 id를 그대로 수신자로 낸다 — 사람 바인딩이 구조상 이미 된다.
여기선 그것을 실 발행 경로(publish_registry_event)로 고정한다. 테스트 하네스는 test_m2_recipe_role_binding_routing_realdb 그대로.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_m2_recipe_role_binding_routing_realdb import (
    _DEFINITION_KEY,
    _publish_stage,
    _realdb_session,
    _seed_agent,
    _seed_binding,
    _seed_definition,
    _seed_org_project,
    _seed_story,
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


@pytest.mark.anyio
async def test_stage_bound_to_a_human_member_routes_to_that_person():
    from app.models.team import TeamMember

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug=f"h4243-{uuid.uuid4().hex[:6]}")
            await _seed_definition(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            person = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human", name="검수자", is_active=True)
            s.add(person)
            await s.commit()
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_binding(s, org_id, project_id, stage="approve", agent_id=person.id)

            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="approve")

            assert resp["broadcast_member_ids"] == [str(person.id)]
            assert _DEFINITION_KEY  # 같은 정의 모양(doc 069927ad §①) — m2 하네스 그대로
    finally:
        await engine.dispose()
