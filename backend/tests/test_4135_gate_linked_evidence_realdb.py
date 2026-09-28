"""story #4135([E-RECIPE-1·Phase 3 폴리시] 게이트 카드가 «확定 대상 실물»을 싣지 않는다) —
2호 게이트 1(concept_approval) 실사고(PO 실측 2026-09-22 00:33~00:42Z): 댄이 concept_brief
evidence를 먼저 등재했는데 `recipe_gate_hooks.py::_build_approval_neutral_facts`가 Evidence
테이블 자체를 한 번도 안 읽어(268-279행, 구판) draft_doc이 «미확認»으로 떨어졌다.

처방 검증 4건(AC4) + 뮤테이션:
- 게이트 생성 시점에 evidence가 있으면 neutral_facts.draft_doc_*이 채워진다.
- evidence가 없으면(entity_references도 없으면) «미확認» 그대로(거짓 참조 0).
- 게이트 생성 *뒤* 핀된 evidence도 GET 응답 linked_evidence[]엔 실린다(neutral_facts는
  생성 시점 스냅샷이라 그대로여도).
- 다른 work_item의 evidence는 안 섞인다.
- 뮤테이션: 참조 조회(resolve_stage_evidence_entries)를 빈 리스트로 되돌리면 1번째 케이스가
  정확히 RED(참조가 안 채워짐)로 이 PR이 보증한다는 걸 실측으로 pin."""
from __future__ import annotations

import datetime as dt
import uuid

import pytest
from fastapi import BackgroundTasks

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
    """test_3323_prev_output_doc_chain.py와 동일 이유(a05da51b) — publish_registry_event가
    전역 엔진(app.core.database.async_session_factory)을 쓰는 background task를 튄다."""
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


async def _seed_org_with_owner(session, *, slug="e4135"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org4135", slug=slug)
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


async def _seed_concept_brief_evidence(
    session, org_id, story_id, *, doc_id: uuid.UUID | None, note: str, created_by: uuid.UUID,
):
    from app.models.evidence import Evidence

    payload: dict = {"kind": "concept_brief"}
    if doc_id is not None:
        payload["doc"] = f"entity:doc:{doc_id}"
    ev = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
        type="report", ref="concept_brief", note=note, created_by=created_by, payload=payload,
    )
    session.add(ev)
    await session.commit()
    return ev.id


_CONCEPT_STAGE_META = {
    "concept_confirmed": {
        "role": "Director", "action": "컨셉 확定 승인",
        "gate": {"type": "concept_approval", "approver": "org_owner"},
    },
}
_RECIPE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["concept_confirmed"]},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "channel": {"type": "string"},
        "previous_output_doc_id": {"type": "string"},
    },
}
_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_definition(session, org_id, *, slug):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=f"org.{slug}.recipe_cycle", org_id=org_id, name="테스트 컨셉 레시피",
        payload_schema=_RECIPE_SCHEMA, routing=_ROUTING, stage_metadata=_CONCEPT_STAGE_META,
    )
    session.add(d)
    await session.commit()
    return d.key


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request():
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


async def _publish_concept_confirmed(session, *, definition_key, story_id, publisher_id, org_id):
    from app.routers.events import EventPublishRequest, publish_registry_event

    return await publish_registry_event(
        EventPublishRequest(
            definition_key=definition_key,
            payload={"stage": "concept_confirmed", "work_item_type": "story", "work_item_id": str(story_id)},
        ),
        BackgroundTasks(), _fake_request(), db=session, auth=_auth(publisher_id, org_id), org_id=org_id,
    )


async def _get_gate(session, story_id, org_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    return (await session.execute(
        select(Gate).where(
            Gate.work_item_id == story_id, Gate.org_id == org_id, Gate.gate_type == "concept_approval",
        )
    )).scalar_one()


# ─── AC4-1: evidence 있는 상태에서 게이트 생성 → 참조 채워짐 ──────────────────


@pytest.mark.anyio
async def test_gate_creation_with_existing_evidence_fills_draft_doc_reference():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e4135a")
            publisher_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            doc_id = await _seed_doc(s, org_id, project_id, title="컨셉 브리프")
            await _seed_concept_brief_evidence(
                s, org_id, story_id, doc_id=doc_id, note="컨셉 브리프 전문 링크", created_by=publisher_id,
            )
            definition_key = await _seed_definition(s, org_id, slug="e4135a")

            await _publish_concept_confirmed(
                s, definition_key=definition_key, story_id=story_id, publisher_id=publisher_id, org_id=org_id,
            )

            gate = await _get_gate(s, story_id, org_id)
            facts = gate.neutral_facts
            assert facts["draft_doc_reference_token"] == f"[컨셉 브리프](entity:doc:{doc_id})"
            assert facts["draft_doc_summary"] == "컨셉 브리프 전문 링크"
    finally:
        await engine.dispose()


# ─── AC4-2: evidence 없이 생성 → «미확認» 유지(거짓 참조 0) ───────────────────


@pytest.mark.anyio
async def test_gate_creation_without_evidence_stays_unconfirmed():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e4135b")
            publisher_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(s, org_id, slug="e4135b")

            await _publish_concept_confirmed(
                s, definition_key=definition_key, story_id=story_id, publisher_id=publisher_id, org_id=org_id,
            )

            gate = await _get_gate(s, story_id, org_id)
            facts = gate.neutral_facts
            assert facts["draft_doc_reference_token"] == "미확認"
            assert facts["draft_doc_summary"] == "미확認"
    finally:
        await engine.dispose()


# ─── AC4-3: 생성 뒤 evidence 핀 → 조회 응답 linked_evidence 1 ─────────────────


@pytest.mark.anyio
async def test_evidence_pinned_after_gate_creation_appears_in_linked_evidence_on_read():
    from app.routers.gates import to_gate_response

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e4135c")
            publisher_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(s, org_id, slug="e4135c")

            # 게이트를 evidence 없이 먼저 만든다(2호 실사고와 동형 순서).
            await _publish_concept_confirmed(
                s, definition_key=definition_key, story_id=story_id, publisher_id=publisher_id, org_id=org_id,
            )
            gate = await _get_gate(s, story_id, org_id)
            assert gate.neutral_facts["draft_doc_reference_token"] == "미확認"  # 전제 확認

            # 게이트 생성 *뒤* evidence를 핀 — 댄이 00:39Z에 artifact를 붙인 것과 동형 순서.
            doc_id = await _seed_doc(s, org_id, project_id, title="뒤늦게 붙은 브리프")
            await _seed_concept_brief_evidence(
                s, org_id, story_id, doc_id=doc_id, note="뒤늦게 붙은 근거", created_by=publisher_id,
            )

            resp = await to_gate_response(s, org_id, gate)

            # neutral_facts는 생성 시점 스냅샷이라 그대로(회귀 확認 — 이 테스트가 손대는 값이
            # 아니라는 걸 pin) — linked_evidence[]가 조회 시점 보강을 담당한다.
            assert gate.neutral_facts["draft_doc_reference_token"] == "미확認"
            assert len(resp.linked_evidence) == 1
            assert resp.linked_evidence[0].kind == "concept_brief"
            assert resp.linked_evidence[0].reference_token == f"[뒤늦게 붙은 브리프](entity:doc:{doc_id})"
    finally:
        await engine.dispose()


# ─── AC4-4: 다른 work_item의 evidence는 안 섞임 ───────────────────────────────


@pytest.mark.anyio
async def test_other_work_item_evidence_does_not_leak_into_linked_evidence():
    from app.routers.gates import to_gate_response

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e4135d")
            publisher_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id, title="게이트 대상 스토리")
            other_story_id = await _seed_story(s, org_id, project_id, title="다른 스토리")
            definition_key = await _seed_definition(s, org_id, slug="e4135d")

            other_doc_id = await _seed_doc(s, org_id, project_id, title="다른 스토리 브리프")
            await _seed_concept_brief_evidence(
                s, org_id, other_story_id, doc_id=other_doc_id, note="다른 스토리 근거", created_by=publisher_id,
            )

            await _publish_concept_confirmed(
                s, definition_key=definition_key, story_id=story_id, publisher_id=publisher_id, org_id=org_id,
            )
            gate = await _get_gate(s, story_id, org_id)

            assert gate.neutral_facts["draft_doc_reference_token"] == "미확認"  # 다른 story evidence는 안 새듯

            resp = await to_gate_response(s, org_id, gate)
            assert resp.linked_evidence == []
    finally:
        await engine.dispose()
