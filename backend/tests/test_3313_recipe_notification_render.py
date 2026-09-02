"""story #3313(마케팅자동화·온보딩 결함) — block_template 없는 사이클형 정의의 stage 이벤트
알림이 role/action·다음 stage·발행 예시·work item 참조 토큰을 싣는지(AC1/AC2) 실왕복 검증.
block_template 있는 정의·stage_metadata 없는 비사이클형 정의는 바이트 동일 렌더(AC3, PO
확定②로 두 갈래 다 커버)."""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


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


async def _seed_org_project(session, *, slug="e3313"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3313", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="캠페인 아이디어 후보"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


_CYCLE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["monitor", "research", "draft"]},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
    },
}
_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_definition(
    session, org_id, *, slug, stage_metadata=None, block_template=None, payload_schema=None,
):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=f"org.{slug}.recipe_cycle", org_id=org_id, name="테스트 레시피",
        payload_schema=payload_schema or _CYCLE_SCHEMA, routing=_ROUTING,
        stage_metadata=stage_metadata or {}, block_template=block_template,
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


def _fake_request(*, project_id_header: uuid.UUID | None = None) -> "StarletteRequest":
    """story #2674 — publish_registry_event의 X-Project-Id 헤더 폴백(work_item 참조가 다른
    project를 가리키거나 애초에 못 풀 때 대비, test_2633_event_publish.py와 동형 패턴)."""
    from starlette.requests import Request as StarletteRequest

    headers = []
    if project_id_header is not None:
        headers.append((b"x-project-id", str(project_id_header).encode()))
    return StarletteRequest(scope={"type": "http", "headers": headers})


async def _publish_and_get_content(
    session, *, definition_key, payload, publisher_id, org_id, project_id_header=None,
):
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.conversation import ConversationMessage

    resp = await publish_registry_event(
        EventPublishRequest(definition_key=definition_key, payload=payload),
        BackgroundTasks(), _fake_request(project_id_header=project_id_header),
        db=session, auth=_auth(publisher_id, org_id), org_id=org_id,
    )
    from sqlalchemy import select

    msg = (await session.execute(
        select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
    )).scalar_one()
    return msg.content, resp


def _generic_expected(definition_key: str, payload: dict) -> str:
    lines = [f"[이벤트] {definition_key}"]
    lines += [f"- {k}: {v}" for k, v in payload.items()]
    return "\n".join(lines)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_stage_event_without_block_template_renders_role_action_next_stage_and_example():
    """⭐AC1 핵심 — block_template=null인 사이클형 정의의 stage 이벤트 알림에 role·action·
    다음 stage·다음 발행 예시가 실린다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313a")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(
                s, org_id, slug="e3313a",
                stage_metadata={
                    "monitor": {"role": "Scout", "action": "주제·신호 감지, 후보 콘텐츠 아이디어 수집"},
                    "research": {"role": "Researcher", "action": "근거 자료 수집"},
                    "draft": {"role": "Writer", "action": "초안 작성"},
                },
            )
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key,
                payload={"stage": "monitor", "work_item_type": "story", "work_item_id": str(story_id)},
                publisher_id=publisher_id, org_id=org_id,
            )

            assert "- stage: monitor (Scout)" in content
            assert "- 할 일: 주제·신호 감지, 후보 콘텐츠 아이디어 수집" in content
            assert "- 다음 단계: research (Researcher)" in content
            example_line = next(
                line for line in content.splitlines()
                if line.startswith("- 다음 단계로 넘기는 발행 예시: publish_event(")
            )
            example_json = example_line.removeprefix(
                "- 다음 단계로 넘기는 발행 예시: publish_event("
            ).removesuffix(")")
            example = json.loads(example_json)
            assert example["definition_key"] == definition_key
            assert example["payload"]["stage"] == "research"
            assert example["payload"]["work_item_id"] == str(story_id)
            assert f"[캠페인 아이디어 후보](entity:story:{story_id})" in content
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_last_stage_has_no_next_stage_line():
    """마지막 stage(다음 stage 없음)는 "없음(마지막 stage)"으로 명시 — 지어내지 않음."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313b")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(
                s, org_id, slug="e3313b",
                stage_metadata={
                    "monitor": {"role": "Scout", "action": "감지"},
                    "research": {"role": "Researcher", "action": "조사"},
                    "draft": {"role": "Writer", "action": "작성"},
                },
            )
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key,
                payload={"stage": "draft", "work_item_type": "story", "work_item_id": str(story_id)},
                publisher_id=publisher_id, org_id=org_id,
            )
            assert "- 다음 단계: 없음(마지막 stage)" in content
            assert "publish_event(" not in content
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_unresolvable_work_item_falls_back_to_raw_id():
    """work item title을 못 찾으면(작업 자체는 실존하지만 work_item_type이 이 렌더러가
    지원하는 story/task가 아님 — 예: doc) 참조 토큰 대신 원시 work_item_type/work_item_id를
    그대로 남긴다(정보 손실 없음, 지어내지 않음). 실존하지 않는 id 대신 실 Doc을 써서 "project
    해소 실패"(별개 관심사, #2674)와 "title lookup 미지원 타입"을 섞지 않는다."""
    from app.models.doc import Doc

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313c")
            publisher_id = await _seed_agent(s, org_id, project_id)
            doc = Doc(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="어떤 문서",
                slug=f"doc-{uuid.uuid4().hex[:8]}",
            )
            s.add(doc)
            await s.commit()

            schema = {
                "type": "object", "additionalProperties": False,
                "required": ["stage", "work_item_type", "work_item_id"],
                "properties": {
                    "stage": {"type": "string", "enum": ["monitor"]},
                    "work_item_type": {"type": "string"},
                    "work_item_id": {"type": "string", "format": "uuid"},
                },
            }
            definition_key = await _seed_definition(
                s, org_id, slug="e3313c",
                stage_metadata={"monitor": {"role": "Scout", "action": "감지"}},
                payload_schema=schema,
            )
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key,
                payload={"stage": "monitor", "work_item_type": "doc", "work_item_id": str(doc.id)},
                publisher_id=publisher_id, org_id=org_id,
            )
            assert "- work_item_type: doc" in content
            assert f"- work_item_id: {doc.id}" in content
            assert "entity:doc:" not in content
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_definition_with_block_template_renders_byte_identical_to_old_generic():
    """⭐AC3-① — block_template이 있는 정의는 이 스토리 이전과 바이트 동일(회귀 0). P2(#2637)
    FE 렌더러가 그 정의를 이미 담당하므로 이 plain body는 손대지 않는다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313d")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(
                s, org_id, slug="e3313d",
                stage_metadata={"monitor": {"role": "Scout", "action": "감지"}},
                block_template={"title": "템플릿 있음"},
            )
            payload = {"stage": "monitor", "work_item_type": "story", "work_item_id": str(story_id)}
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key, payload=payload, publisher_id=publisher_id, org_id=org_id,
            )
            assert content == _generic_expected(definition_key, payload)
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_non_cyclic_definition_without_stage_metadata_renders_byte_identical():
    """⭐AC3-② — PO 확定(2026-09-02): block_template 없는 정의라도 stage_metadata 자체가
    빈(비사이클형) 정의는 바이트 동일(회귀 0) — 지어낼 role/action이 애초에 없다("담당자
    없는 stage는 모르면 안 준다" 원칙과 동일)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313e")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            schema = {
                "type": "object", "additionalProperties": False,
                "required": ["work_item_type", "work_item_id"],
                "properties": {"work_item_type": {"type": "string"}, "work_item_id": {"type": "string", "format": "uuid"}},
            }
            definition_key = await _seed_definition(
                s, org_id, slug="e3313e", stage_metadata={}, payload_schema=schema,
            )
            payload = {"work_item_type": "story", "work_item_id": str(story_id)}
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key, payload=payload, publisher_id=publisher_id, org_id=org_id,
            )
            assert content == _generic_expected(definition_key, payload)
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_stage_not_registered_in_stage_metadata_falls_back_to_generic():
    """stage가 payload_schema.enum엔 있는데 stage_metadata에는 등재 안 됐으면(누락) 지어내지
    않고 기존 폴백으로 — 이 케이스는 validate_stage_metadata가 등록 시점에 이미 stage_metadata
    ⊆ enum만 강제하지 enum ⊆ stage_metadata까진 강제 안 하므로(부분 정의 허용) 실제로 있을 수
    있는 조합."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313f")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(
                s, org_id, slug="e3313f",
                stage_metadata={"monitor": {"role": "Scout", "action": "감지"}},  # "research" 누락
            )
            payload = {"stage": "research", "work_item_type": "story", "work_item_id": str(story_id)}
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key, payload=payload, publisher_id=publisher_id, org_id=org_id,
            )
            assert content == _generic_expected(definition_key, payload)
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_legacy_stage_metadata_missing_action_falls_back_without_crashing_publish():
    """⭐PO 리뷰(페드루, 2026-09-02) — validate_stage_metadata의 role/action 필수 검증은
    2026-08-19 이후 "쓰기 시점" 가드라, 그 전에 저장된 정의는 role/action이 누락된 채 DB에
    남아있을 수 있다(이 테스트가 그 레거시 shape을 직접 재현). 직접 인덱싱이면 publish 자체가
    KeyError로 죽어 "알림 개선이 발행 회귀"가 됐을 자리 — .get() 방어로 발행은 성공하고
    본문은 기존 제네릭으로 안전 폴백해야 한다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313g")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(
                s, org_id, slug="e3313g",
                # action 누락(레거시) — validate_stage_metadata 신설 前 저장됐을 법한 shape.
                stage_metadata={"monitor": {"role": "Scout"}},
            )
            payload = {"stage": "monitor", "work_item_type": "story", "work_item_id": str(story_id)}
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key, payload=payload, publisher_id=publisher_id, org_id=org_id,
            )  # KeyError 없이 여기까지 도달하는 것 자체가 핵심 단언.
            assert content == _generic_expected(definition_key, payload)
    finally:
        await engine.dispose()
