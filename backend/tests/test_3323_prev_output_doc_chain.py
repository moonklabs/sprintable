"""story #3323(e62a02de) — 레시피 stage 산출물(직전 draft doc)이 다음 stage 알림·approve
승인 카드에 클릭 가능한 참조로 실리는지 검증.

AC1/AC3(렌더러, events.py::_render_event_message_content) — payload.previous_output_doc_id는
전용 레이블(«앞 단계 산출물»)로, 그 외 `*_doc_id` 키는 일반 규칙(존재하면 클릭 토큰, 없거나
파싱 불가면 raw 폴백)으로 렌더된다. previous_output_doc_id가 payload에 아예 없으면 줄 자체가
없다(지어내지 않음).

AC2(게이트, recipe_gate_hooks.py::_build_approval_neutral_facts) — draft doc 해소는
①payload.previous_output_doc_id ②entity_references 최신 링크 ③미확認 순."""
from __future__ import annotations

import datetime as dt
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


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


async def _seed_org_with_owner(session, *, slug="e3323"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3323", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(owner_user)
    await session.commit()
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user.id, role="owner")
    session.add(owner_member)
    await session.commit()
    session.add(TeamMember(
        id=owner_member.id, org_id=org.id, project_id=project.id, type="human", name="owner", is_active=True,
    ))
    await session.commit()
    return org.id, project.id, owner_member.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="레시피 산출물"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_doc(session, org_id, project_id, *, title):
    from app.models.doc import Doc

    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"doc-{uuid.uuid4().hex[:8]}", content=f"{title} 본문",
    )
    session.add(doc)
    await session.commit()
    return doc.id


_RECIPE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["draft", "approve", "publish"]},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "channel": {"type": "string"},
        "previous_output_doc_id": {"type": "string"},
        "source_doc_id": {"type": "string"},
    },
}
_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_definition(session, org_id, *, slug, stage_metadata):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=f"org.{slug}.recipe_cycle", org_id=org_id, name="테스트 레시피",
        payload_schema=_RECIPE_SCHEMA, routing=_ROUTING, stage_metadata=stage_metadata,
    )
    session.add(d)
    await session.commit()
    return d.key


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


async def _publish(session, *, definition_key, payload, publisher_id, org_id):
    from app.routers.events import EventPublishRequest, publish_registry_event

    return await publish_registry_event(
        EventPublishRequest(definition_key=definition_key, payload=payload),
        BackgroundTasks(), _fake_request(), db=session, auth=_auth(publisher_id, org_id), org_id=org_id,
    )


async def _content_of(session, resp):
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    msg = (await session.execute(
        select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
    )).scalar_one()
    return msg.content


_DRAFT_META = {"draft": {"role": "Writer", "action": "초안 작성"}}


# ─── AC1/AC3 — 렌더러(events.py) ────────────────────────────────────────────


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_previous_output_doc_id_renders_dedicated_labeled_token():
    """⭐AC1 핵심 — previous_output_doc_id가 해소되면 «앞 단계 산출물» 전용 레이블로 클릭
    토큰이 실린다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3323a")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id, title="캠페인 초안 v1")
            definition_key = await _seed_definition(s, org_id, slug="e3323a", stage_metadata=_DRAFT_META)

            resp = await _publish(
                s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_id,
                payload={
                    "stage": "draft", "work_item_type": "story", "work_item_id": str(story_id),
                    "previous_output_doc_id": str(doc_id),
                },
            )
            content = await _content_of(s, resp)
            assert f"- 앞 단계 산출물: [캠페인 초안 v1](entity:doc:{doc_id})" in content
            # raw 키명 "- previous_output_doc_id: ..." 불릿 줄은 없어야(전용 레이블로 대체) —
            # 「다음 단계로 넘기는 발행 예시」JSON 골격 안의 키 언급(다음 stage가 채울 자리를
            # 보여주는 것 자체가 의도)까지 금지하는 건 아니므로 불릿 줄 단위로만 검사한다.
            assert not any(
                line.startswith("- previous_output_doc_id:") for line in content.splitlines()
            )
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_previous_output_doc_id_absent_no_line_at_all():
    """AC1 — payload에 previous_output_doc_id 자체가 없으면 그 줄이 아예 없다(지어내지 않음)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3323b")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(s, org_id, slug="e3323b", stage_metadata=_DRAFT_META)

            resp = await _publish(
                s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_id,
                payload={"stage": "draft", "work_item_type": "story", "work_item_id": str(story_id)},
            )
            content = await _content_of(s, resp)
            assert "앞 단계 산출물" not in content
            assert "previous_output_doc_id" not in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_previous_output_doc_id_unresolvable_falls_back_to_raw():
    """AC3 — previous_output_doc_id가 있지만 존재하지 않는 doc(또는 파싱 불가)이면 클릭
    토큰 대신 raw 값을 그대로 남긴다(정보 손실 없음, 지어내지 않음)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3323c")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(s, org_id, slug="e3323c", stage_metadata=_DRAFT_META)
            ghost_id = str(uuid.uuid4())

            resp = await _publish(
                s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_id,
                payload={
                    "stage": "draft", "work_item_type": "story", "work_item_id": str(story_id),
                    "previous_output_doc_id": ghost_id,
                },
            )
            content = await _content_of(s, resp)
            assert f"- previous_output_doc_id: {ghost_id}" in content
            assert "entity:doc:" not in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_generic_doc_id_key_tokenized_under_its_own_name():
    """AC3 — previous_output_doc_id 말고도 `*_doc_id` 패턴 키(예: source_doc_id)는 존재하면
    그 키 이름 그대로 클릭 토큰화된다(전용 레이블은 previous_output_doc_id만)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3323d")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id, title="구독 소스 문서")
            definition_key = await _seed_definition(s, org_id, slug="e3323d", stage_metadata=_DRAFT_META)

            resp = await _publish(
                s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_id,
                payload={
                    "stage": "draft", "work_item_type": "story", "work_item_id": str(story_id),
                    "source_doc_id": str(doc_id),
                },
            )
            content = await _content_of(s, resp)
            assert f"- source_doc_id: [구독 소스 문서](entity:doc:{doc_id})" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_generic_doc_id_key_unresolvable_falls_back_to_raw():
    """AC3 — 일반 `*_doc_id` 키도 존재하지 않는 doc이면 raw 폴백(회귀 0 — #3313 시절 그대로)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3323e")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(s, org_id, slug="e3323e", stage_metadata=_DRAFT_META)
            ghost_id = str(uuid.uuid4())

            resp = await _publish(
                s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_id,
                payload={
                    "stage": "draft", "work_item_type": "story", "work_item_id": str(story_id),
                    "source_doc_id": ghost_id,
                },
            )
            content = await _content_of(s, resp)
            assert f"- source_doc_id: {ghost_id}" in content
    finally:
        await engine.dispose()


# ─── AC2 — 게이트 neutral_facts 3경로(recipe_gate_hooks.py) ────────────────────


_APPROVE_META = {
    "approve": {
        "role": "Approver", "action": "승인",
        "gate": {"type": "external_publish", "approver": "org_owner"},
    },
}


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_gate_draft_doc_prefers_payload_previous_output_doc_id_over_references():
    """⭐AC2 핵심 — payload.previous_output_doc_id가 있으면, entity_references에 이미 다른
    doc이 링크돼 있어도 payload 값이 1순위로 채택된다(발행자가 이번 stage 산출물을 직접
    지목한 값이 가장 정확 — #3312 원래 경로보다 우선)."""
    from app.models.gate import Gate
    from app.models.reference import Reference
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3323f")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

            stale_doc_id = await _seed_doc(s, org_id, project_id, title="오래된 링크 doc")
            fresh_doc_id = await _seed_doc(s, org_id, project_id, title="이번 바퀴 산출물")
            s.add(Reference(
                id=uuid.uuid4(), org_id=org_id,
                source_type="doc", source_field="body", source_id=stale_doc_id,
                target_type="story", target_id=story_id,
                form="mention", relation="none", created_at=dt.datetime.now(dt.timezone.utc),
            ))
            await s.commit()

            definition_key = await _seed_definition(s, org_id, slug="e3323f", stage_metadata=_APPROVE_META)
            await _publish(
                s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_id,
                payload={
                    "stage": "approve", "work_item_type": "story", "work_item_id": str(story_id),
                    "previous_output_doc_id": str(fresh_doc_id),
                },
            )

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            facts = gate.neutral_facts
            assert facts["draft_doc_reference_token"] == f"[이번 바퀴 산출물](entity:doc:{fresh_doc_id})"
            assert "오래된" not in facts["draft_doc_summary"]
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_gate_draft_doc_falls_back_to_references_when_payload_absent():
    """AC2 2순위 — payload에 previous_output_doc_id가 없으면 기존 entity_references 최신
    링크로 폴백(#3312 원래 경로, 회귀 0)."""
    from app.models.gate import Gate
    from app.models.reference import Reference
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3323g")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            linked_doc_id = await _seed_doc(s, org_id, project_id, title="링크된 doc")
            s.add(Reference(
                id=uuid.uuid4(), org_id=org_id,
                source_type="doc", source_field="body", source_id=linked_doc_id,
                target_type="story", target_id=story_id,
                form="mention", relation="none", created_at=dt.datetime.now(dt.timezone.utc),
            ))
            await s.commit()

            definition_key = await _seed_definition(s, org_id, slug="e3323g", stage_metadata=_APPROVE_META)
            await _publish(
                s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_id,
                payload={"stage": "approve", "work_item_type": "story", "work_item_id": str(story_id)},
            )

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            assert gate.neutral_facts["draft_doc_reference_token"] == f"[링크된 doc](entity:doc:{linked_doc_id})"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_gate_draft_doc_unconfirmed_when_both_paths_absent():
    """AC2 3순위 — payload에도, entity_references에도 없으면 미확認(지어내지 않음, #3312
    기존 pin 재확인)."""
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3323h")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(s, org_id, slug="e3323h", stage_metadata=_APPROVE_META)

            await _publish(
                s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_id,
                payload={"stage": "approve", "work_item_type": "story", "work_item_id": str(story_id)},
            )

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            assert gate.neutral_facts["draft_doc_reference_token"] == "미확認"
            assert gate.neutral_facts["draft_doc_summary"] == "미확認"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_gate_draft_doc_payload_id_from_other_org_does_not_leak():
    """AC2 경계 — previous_output_doc_id가 다른 org의 실 doc을 가리켜도 org 스코프 밖이라
    해소되지 않고(0건) references 폴백으로 안전히 넘어간다(IDOR류 누수 없음)."""
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_a_id, project_a_id, _owner_a = await _seed_org_with_owner(s, slug="e3323i-a")
            org_b_id, project_b_id, _owner_b = await _seed_org_with_owner(s, slug="e3323i-b")
            other_org_doc_id = await _seed_doc(s, org_b_id, project_b_id, title="다른 org 문서")

            publisher_id = await _seed_agent(s, org_a_id, project_a_id)
            story_id = await _seed_story(s, org_a_id, project_a_id)
            definition_key = await _seed_definition(s, org_a_id, slug="e3323i", stage_metadata=_APPROVE_META)

            await _publish(
                s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_a_id,
                payload={
                    "stage": "approve", "work_item_type": "story", "work_item_id": str(story_id),
                    "previous_output_doc_id": str(other_org_doc_id),
                },
            )

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            assert gate.neutral_facts["draft_doc_reference_token"] == "미확認"
    finally:
        await engine.dispose()
