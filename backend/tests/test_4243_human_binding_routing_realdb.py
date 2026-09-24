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
    _STAGE_METADATA,
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


async def _declare_approval_elsewhere(session, org_id, *, stage: str, kind: str | None, capability_target: str | None = None):
    """그 stage에 `approval.surface`(승인이 stage 밖)를 선언하고, 그 역할을 `kind`로 선언한다(None = 선언 없음).
    `capability_target`을 주면 그 stage를 채널 연결 · 연산 커넥터 stage로 만든다(멤버 종류 없음)."""
    from sqlalchemy import select

    from app.models.event_definition import EventDefinition

    d = (await session.execute(
        select(EventDefinition).where(EventDefinition.key == _DEFINITION_KEY, EventDefinition.org_id == org_id)
    )).scalar_one()
    meta = {k: dict(v) for k, v in _STAGE_METADATA.items()}
    meta[stage]["approval"] = {"surface": "draft_gate"}
    if capability_target:
        meta[stage]["capability"] = {"kind": "publish", "target": capability_target}
    d.stage_metadata = meta
    d.role_actor_kinds = {meta[stage]["role"]: kind} if kind else None
    await session.commit()


@pytest.mark.anyio
@pytest.mark.parametrize("kind, capability_target, expect_routed", [
    ("human", None, False), ("either", None, False), ("agent", None, True), (None, None, True),
    # 까디르 4606 델타 P2 — FE와 같은 판정: 연결 stage는 멤버 종류가 없어(에이전트 아님) 역할 선언과 무관하게 승인 자리다.
    ("agent", "generation_connector", False),
])
async def test_old_binding_on_an_approval_elsewhere_stage_is_not_a_recipient(kind, capability_target, expect_routed):
    """까디르 4606 렌즈 · PO ⓑ — 승인이 stage 밖(approval.surface)인 사람 · either 역할 stage에 **옛 바인딩 행**이 남아 있어도
    그 stage 이벤트 수신자로 잡지 않는다(적용 API는 빠진 stage를 지우지 않아 4594 전에 적용한 조직엔 행이 남는다). 에이전트
    역할 · 선언 없는 역할(= 에이전트)은 그 stage가 멤버 자리라 예전처럼 바인딩대로 간다.
    뮤테이션: 리졸버의 제외 분기를 지우면 human · either 두 건이 옛 사람에게 가 RED."""
    from app.models.team import TeamMember

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug=f"e4243-{uuid.uuid4().hex[:6]}")
            await _seed_definition(s, org_id)
            await _declare_approval_elsewhere(s, org_id, stage="approve", kind=kind, capability_target=capability_target)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            old = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human", name="옛 승인자", is_active=True)
            s.add(old)
            await s.commit()
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_binding(s, org_id, project_id, stage="approve", agent_id=old.id)

            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="approve")

            assert resp["broadcast_member_ids"] == ([str(old.id)] if expect_routed else [])
    finally:
        await engine.dispose()
