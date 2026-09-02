"""story #3312(M1→M3·마케팅자동화) — recipe의 approve stage 이벤트 발행이 external_publish
게이트를 자동 생성하는지(AC1) 실왕복 검증. 멱등(AC2)·무선언 회귀 0(AC3)·approver 역할참조
어휘 강제(등록 시점)도 같이 고정한다.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── 단위 축 — validate_stage_metadata의 gate shape 강제(DB 불요) ──────────────────


def test_validate_stage_metadata_accepts_valid_gate_declaration():
    from app.services.event_definition_registry import validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["draft", "approve", "publish"]}}}
    validate_stage_metadata(schema, {
        "approve": {"role": "Approver", "action": "승인", "gate": {"type": "external_publish", "approver": "org_owner"}},
    })  # raise 없으면 통과


def test_validate_stage_metadata_rejects_gate_not_object():
    from app.services.event_definition_registry import InvalidStageMetadataError, validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["approve"]}}}
    with pytest.raises(InvalidStageMetadataError):
        validate_stage_metadata(schema, {"approve": {"role": "R", "action": "A", "gate": "external_publish"}})


def test_validate_stage_metadata_rejects_empty_gate_type():
    from app.services.event_definition_registry import InvalidStageMetadataError, validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["approve"]}}}
    with pytest.raises(InvalidStageMetadataError):
        validate_stage_metadata(schema, {
            "approve": {"role": "R", "action": "A", "gate": {"type": "", "approver": "org_owner"}},
        })


def test_validate_stage_metadata_rejects_unknown_approver_role():
    """오타(예: "org-owner", "owner") 재현 — 닫힌 어휘 밖은 등록 시점에 거부돼야 나중에
    recipe_gate_hooks가 조용히 no-op(게이트가 영원히 안 생김)하는 사고를 막는다."""
    from app.services.event_definition_registry import InvalidStageMetadataError, validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["approve"]}}}
    with pytest.raises(InvalidStageMetadataError):
        validate_stage_metadata(schema, {
            "approve": {"role": "R", "action": "A", "gate": {"type": "external_publish", "approver": "owner"}},
        })


def test_recipe_gate_hooks_resolver_vocabulary_matches_registry():
    """recipe_gate_hooks._APPROVER_ROLE_RESOLVERS 완결성 assert가 모듈 로드 시점에 이미
    돌지만(import 자체가 실패하면 이 테스트 파일 전체가 collection 단계에서 죽는다), 어휘가
    실제로 비어있지 않은지도 한 번 더 pin — 어휘를 실수로 빈 집합으로 되돌리면 이 테스트가
    (import는 통과해도) 잡는다."""
    from app.services.event_definition_registry import APPROVER_ROLE_REFERENCES
    from app.services.recipe_gate_hooks import _APPROVER_ROLE_RESOLVERS

    assert APPROVER_ROLE_REFERENCES == {"org_owner"}
    assert set(_APPROVER_ROLE_RESOLVERS) == APPROVER_ROLE_REFERENCES


# ─── 실행 축(realdb) — AC1/AC2/AC3 실왕복 ──────────────────────────────────────


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


async def _seed_org_with_owner(session, *, slug="acme3312"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project

    org = Organization(id=uuid.uuid4(), name="Org3312", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_user_id = uuid.uuid4()
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user_id, role="owner")
    session.add(owner_member)
    await session.commit()
    return org.id, project.id, owner_member.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="레시피 산출물")
    session.add(story)
    await session.commit()
    return story.id


_CYCLE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["draft", "approve", "publish"]},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "channel": {"type": "string"},
    },
}
_CYCLE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_recipe_definition(session, org_id, *, slug, stage_metadata):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=f"org.{slug}.recipe_cycle", org_id=org_id, name="테스트 레시피",
        payload_schema=_CYCLE_SCHEMA, routing=_CYCLE_ROUTING, stage_metadata=stage_metadata,
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


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_approve_stage_event_auto_creates_external_publish_gate():
    """⭐AC1 핵심 — stage_metadata.approve.gate 선언이 있는 정의의 approve stage 이벤트를
    발행하면, 그 work item에 pending external_publish 게이트가 designated_approver=org owner로
    자동 생성된다."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner(s)
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_recipe_definition(
                s, org_id, slug="acme3312a",
                stage_metadata={
                    "draft": {"role": "Writer", "action": "초안 작성"},
                    "approve": {
                        "role": "Approver", "action": "승인",
                        "gate": {"type": "external_publish", "approver": "org_owner"},
                    },
                    "publish": {"role": "Publisher", "action": "게시"},
                },
            )

            body = EventPublishRequest(
                definition_key=definition_key,
                payload={"stage": "approve", "work_item_type": "story", "work_item_id": str(story_id)},
            )
            await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )

            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalars().all()
            assert len(gates) == 1
            gate = gates[0]
            assert gate.status == "pending"
            assert gate.designated_approver_id == owner_member_id
            assert gate.org_id == org_id

            # PO 변경요청①(2026-09-02) — neutral_facts가 카드에서 «무엇을 승인하는지» 보이게.
            # 이 케이스는 channel/링크된 draft doc이 없으므로 그 둘은 «미확認»이어야 한다
            # (지어내지 않음 — 다음 테스트가 값 있는 happy-path를 커버).
            facts = gate.neutral_facts
            assert facts["work_item_title"] == "레시피 산출물"
            assert facts["work_item_reference_token"] == f"[레시피 산출물](entity:story:{story_id})"
            assert facts["channel"] == "미확認"
            assert facts["draft_doc_reference_token"] == "미확認"
            assert facts["draft_doc_summary"] == "미확認"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_approve_stage_event_neutral_facts_surface_channel_and_linked_draft_doc():
    """PO 변경요청① happy-path — payload에 channel이 있고 그 story에 draft doc이(entity_references
    로) 링크돼 있으면 카드가 실 채널·doc 참조 토큰·본문 첫 300자를 담는다."""
    import datetime as dt

    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.doc import Doc
    from app.models.gate import Gate
    from app.models.reference import Reference
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_member_id = await _seed_org_with_owner(s, slug="acme3312d")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

            doc = Doc(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="9월 캠페인 초안",
                slug=f"campaign-draft-{uuid.uuid4().hex[:8]}", content="X" * 400,  # 300자 잘림 확인용
            )
            s.add(doc)
            await s.commit()
            s.add(Reference(
                id=uuid.uuid4(), org_id=org_id,
                source_type="doc", source_field="body", source_id=doc.id,
                target_type="story", target_id=story_id,
                form="mention", relation="none", created_at=dt.datetime.now(dt.timezone.utc),
            ))
            await s.commit()

            definition_key = await _seed_recipe_definition(
                s, org_id, slug="acme3312d",
                stage_metadata={
                    "approve": {
                        "role": "Approver", "action": "승인",
                        "gate": {"type": "external_publish", "approver": "org_owner"},
                    },
                },
            )
            body = EventPublishRequest(
                definition_key=definition_key,
                payload={
                    "stage": "approve", "work_item_type": "story", "work_item_id": str(story_id),
                    "channel": "twitter",
                },
            )
            await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            facts = gate.neutral_facts
            assert facts["channel"] == "twitter"
            assert facts["draft_doc_reference_token"] == f"[9월 캠페인 초안](entity:doc:{doc.id})"
            assert facts["draft_doc_summary"] == "X" * 300
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_approve_stage_event_republish_is_idempotent():
    """AC2 — 같은 work item에 approve stage 이벤트가 다시 발행돼도(재시도·재발행류) pending
    게이트가 1건으로 유지된다(create_gate의 기존 멱등 재사용)."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_member_id = await _seed_org_with_owner(s, slug="acme3312b")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_recipe_definition(
                s, org_id, slug="acme3312b",
                stage_metadata={
                    "approve": {
                        "role": "Approver", "action": "승인",
                        "gate": {"type": "external_publish", "approver": "org_owner"},
                    },
                },
            )
            body = EventPublishRequest(
                definition_key=definition_key,
                payload={"stage": "approve", "work_item_type": "story", "work_item_id": str(story_id)},
            )
            for _ in range(2):
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(), db=s,
                    auth=_auth(publisher_id, org_id), org_id=org_id,
                )

            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalars().all()
            assert len(gates) == 1, f"멱등 깨짐 — {len(gates)}건 생성됨"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_stage_event_without_gate_declaration_creates_no_gate():
    """AC3 — gate 선언이 없는 stage(다른 레시피류) 이벤트를 발행해도 게이트가 전혀 안 생긴다
    (회귀 0 — 이 훅이 무선언 정의에 완전 무영향임을 실증)."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_member_id = await _seed_org_with_owner(s, slug="acme3312c")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_recipe_definition(
                s, org_id, slug="acme3312c",
                stage_metadata={"draft": {"role": "Writer", "action": "초안 작성"}},
            )
            body = EventPublishRequest(
                definition_key=definition_key,
                payload={"stage": "draft", "work_item_type": "story", "work_item_id": str(story_id)},
            )
            await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )

            gates = (await s.execute(select(Gate).where(Gate.work_item_id == story_id))).scalars().all()
            assert gates == []
    finally:
        await engine.dispose()


# ─── AC5 — 커넥터용 조회 계약 = 기존 GET /api/v2/gates(필터: work_item_id·work_item_type·
#     gate_type·status·sort). 새 라우트 없음(PO 확定, 2026-09-02) — 아래는 그 계약이 org
#     스코프 밖 요청에서 0건을 낸다는 실증(카디르 QA 커버리지 요구 반영). ─────────────────


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_list_gates_returns_zero_for_work_item_outside_caller_org_scope():
    """⭐AC5 — 에이전트 키 caller가 자기 org로 인증했지만 조회 필터(work_item_id)가 **다른
    org**의 story/게이트를 가리키면 그 게이트가 새지 않는다(설령 그 story_id를 정확히 안다
    해도). 실측: `list_gates`는 이 경우 빈 리스트가 아니라 `HTTPException(404)`를 낸다
    (gates.py:673, "존재-비노출" 관례 — get_gate_endpoint 단건조회와 동일 판정축, 모듈
    docstring 참조) — 그래서 이 테스트는 404를 단언한다(다른 org의 게이트 내용이 응답에
    한 조각도 안 실림)."""
    from fastapi import HTTPException

    from app.routers.gates import list_gates

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_a_id, project_a_id, _owner_a = await _seed_org_with_owner(s, slug="acme3312e-a")
            caller_id = await _seed_agent(s, org_a_id, project_a_id, name="caller")

            org_b_id, project_b_id, owner_b_id = await _seed_org_with_owner(s, slug="acme3312e-b")
            story_b_id = await _seed_story(s, org_b_id, project_b_id)
            definition_key_b = await _seed_recipe_definition(
                s, org_b_id, slug="acme3312eb",
                stage_metadata={
                    "approve": {
                        "role": "Approver", "action": "승인",
                        "gate": {"type": "external_publish", "approver": "org_owner"},
                    },
                },
            )
            publisher_b_id = await _seed_agent(s, org_b_id, project_b_id, name="publisher-b")
            from app.routers.events import EventPublishRequest, publish_registry_event

            await publish_registry_event(
                EventPublishRequest(
                    definition_key=definition_key_b,
                    payload={"stage": "approve", "work_item_type": "story", "work_item_id": str(story_b_id)},
                ),
                BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_b_id, org_b_id), org_id=org_b_id,
            )

            with pytest.raises(HTTPException) as exc:
                await list_gates(
                    work_item_id=story_b_id, work_item_type="story", status=None, sort=None,
                    gate_type="external_publish", assigned_to_me=False,
                    session=s, org_id=org_a_id, auth=_auth(caller_id, org_a_id),
                )
            assert exc.value.status_code == 404, f"org 스코프 밖 게이트가 샜다 — {exc.value!r}"
    finally:
        await engine.dispose()
