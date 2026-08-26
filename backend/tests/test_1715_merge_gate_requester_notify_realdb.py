"""story #1715(PO 판정 2026-08-24) — merge gate 해소(승인/반려) 시 상신자(requested_by_
member_id=participation.member_id, evaluate_merge_gate가 이미 계산해두던 값 stash) 회신.
기존 doc/agent_decision_request 전용이던 _notify_doc_gate_requester를 gate_type 스위치가
아니라 requested_by_member_id **유무**로 게이팅하도록 정정 + 호출점을 transition_gate의
if/else(line-bound·else) 분기 이전 단일 자리로 옮겨(이중발송 구조적 불가) merge gate까지
편입한다.

핵심 검증축: ①merge gate 해소가 dispatch_approval_result_reply를 실제로 태워 상신자 DM에
회신 메시지가 실제로 남는지(end-to-end) ②self-resolve(해소자==상신자) 억제(PO ⓑ)
③_notify_doc_gate_requester가 transition_gate 안에서 정확히 1곳에서만 불려 line-bound·
else 두 경로가 구조적으로 이중발송 불가능함(PO ⓐ). 로컬 PG 미설정 시 skip(CI 관례 동일)."""
from __future__ import annotations

import inspect
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.activity_log  # noqa: F401 — #2662: app.models 벌크 import 밖(create_all 전 명시 필요).

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org1715", slug=f"org1715-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, project_id, *, name="member"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human",
        name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="머지 대상 스토리"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="in-review")
    session.add(story)
    await session.commit()
    return story


async def _seed_merge_gate(session, org_id, story_id, *, requested_by_member_id):
    from app.models.gate import Gate

    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
        gate_type="merge", status="pending",
        neutral_facts={"requested_by_member_id": str(requested_by_member_id)},
    )
    session.add(gate)
    await session.commit()
    return gate


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_merge_gate_resolve_notifies_requester_end_to_end():
    from app.services.gate_service import transition_gate
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="implementer")
            resolver_id = await _seed_human(s, org_id, project_id, name="reviewer")
            story = await _seed_story(s, org_id, project_id)
            gate = await _seed_merge_gate(s, org_id, story.id, requested_by_member_id=requester_id)

        async with Session() as s:
            await transition_gate(s, org_id, gate.id, "approved", resolver_id, "LGTM")
            await s.commit()

        async with Session() as s:
            msgs = (await s.execute(
                select(ConversationMessage).where(
                    ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(gate.id),
                )
            )).scalars().all()
            result_msgs = [m for m in msgs if m.msg_metadata.get("activation", {}).get("kind") == "result"]
            assert len(result_msgs) == 1
            assert requester_id in [uuid.UUID(str(x)) for x in (result_msgs[0].mentioned_ids or [])]
            assert result_msgs[0].msg_metadata["approval_target"]["decision"] == "approved"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_merge_gate_self_resolve_skips_notification():
    """PO ⓑ — 해소자==상신자면 자기 알림은 무의미하다(dispatch_approval_result_reply
    기존 가드 재사용, merge 경로도 우회 없이 동일하게 억제되는지 end-to-end 확認)."""
    from app.services.gate_service import transition_gate
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            same_person_id = await _seed_human(s, org_id, project_id, name="solo-implementer-reviewer")
            story = await _seed_story(s, org_id, project_id)
            gate = await _seed_merge_gate(s, org_id, story.id, requested_by_member_id=same_person_id)

        async with Session() as s:
            await transition_gate(s, org_id, gate.id, "approved", same_person_id, None)
            await s.commit()

        async with Session() as s:
            msgs = (await s.execute(
                select(ConversationMessage).where(
                    ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(gate.id),
                )
            )).scalars().all()
            result_msgs = [m for m in msgs if m.msg_metadata.get("activation", {}).get("kind") == "result"]
            assert result_msgs == []
    finally:
        await engine.dispose()


def test_notify_doc_gate_requester_has_exactly_one_call_site_in_transition_gate():
    """PO ⓐ — 두 해소 경로(line-bound·else)가 각자 알림을 심으면 "구조적으로 배타적"이라는
    주장이 두 코드 위치의 일치에 의존하게 된다(누가 한쪽만 고치면 조용히 깨지는 자리). 이
    소스 검사가 그 구조를 직접 고정한다 — if/else 분기가 갈리기 前 단일 호출점이어야
    이중발송이 원리적으로 불가능."""
    from app.services.gate_service import transition_gate

    source = inspect.getsource(transition_gate)
    assert source.count("_notify_doc_gate_requester(") == 1
