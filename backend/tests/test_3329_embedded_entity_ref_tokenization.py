"""story #3329(febb8a4a) — stage_metadata.action 자유 문구 안에 박힌 doc/story
UUID(전체 또는 8자 prefix)를 알림 렌더(events.py::_render_event_message_content,
_tokenize_embedded_entity_refs)가 클릭 참조 토큰으로 바꾸는지 검증.

실사례 재현(담롱 3바퀴 draft 알림): action 문구에 "doc 20808e14의 해당 행"처럼 8자 hex가
한글 조사 바로 뒤에 붙는다 — Python 기본 `\\b`(Unicode 워드 경계)는 한글을 워드 문자로 쳐서
이 경계가 안 생기므로(직접 실측 확인), 이 회귀를 실제로 잡는 테스트를 포함한다.

AC1 — 실재하는 엔티티만 토큰화(오탐 0): 존재하는 UUID/유일 prefix는 바뀌고, 존재하지 않거나
모호한 것은 원문 그대로.
AC2 — 8자 prefix 유일성 보장 방침: doc+story 합쳐 정확히 1건일 때만 치환, 2건 이상(모호)이면
원문 유지."""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """story a05da51b — 이 파일의 테스트는 실제로 메시지를 발행해(`_publish` →
    `publish_registry_event`) `send_message`의 background task(`mark_agent_replied`)를
    태운다. 그 task는 이 파일의 throwaway 엔진이 아니라 `app.core.database.
    async_session_factory`(전역·프로세스 수명)를 쓴다. destructive_schema 마커 파일이라
    story #3330의 conftest.py 전역 autouse(non-destructive 전용, 프로세스 격리로 이미
    안전한 destructive는 스코프 밖)의 적용 대상이 아니다 — 이 파일 자신의 여러 테스트가
    **한 pytest 세션 안에서** 순차 실행되며 같은 전역 엔진을 반복 사용하므로, dispose
    없이 두면 pytest-anyio의 테스트별 새 이벤트 루프 사이에서 커넥션 누수/`Event loop is
    closed`로 이어질 수 있다(실측 확인 — test_3330_gate_verdict_notification.py에서
    최초 재현, 이 파일도 같은 위험을 이미 갖고 있었음이 회귀 재확認 중 발견됨). 이
    realdb 하네스가 destructive 파일에 이미 쓰는 표준 방어 fixture 재사용(새 로직 0)."""
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


async def _seed_org_with_owner(session, *, slug="e3329"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3329", slug=slug)
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


async def _seed_story(session, org_id, project_id, *, story_id=None, title="레시피 산출물"):
    from app.models.pm import Story

    story = Story(id=story_id or uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_doc(session, org_id, project_id, *, doc_id=None, title):
    from app.models.doc import Doc

    doc = Doc(
        id=doc_id or uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
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
    },
}
_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_definition(session, org_id, *, slug, action_text):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=f"org.{slug}.recipe_cycle", org_id=org_id, name="테스트 레시피",
        payload_schema=_RECIPE_SCHEMA, routing=_ROUTING,
        stage_metadata={"draft": {"role": "Writer", "action": action_text}},
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


async def _publish_draft_and_get_content(s, org_id, project_id, publisher_id, *, slug, action_text):
    story_id = await _seed_story(s, org_id, project_id)
    definition_key = await _seed_definition(s, org_id, slug=slug, action_text=action_text)
    resp = await _publish(
        s, definition_key=definition_key, publisher_id=publisher_id, org_id=org_id,
        payload={"stage": "draft", "work_item_type": "story", "work_item_id": str(story_id)},
    )
    return await _content_of(s, resp)


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_hex8_prefix_unique_in_org_becomes_reference_token():
    """⭐AC1/AC2 핵심 — 실사례 그대로: action 문구 안 8자 prefix가 org 내 유일한 doc과
    매치되면 클릭 토큰으로 바뀐다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329a")
            publisher_id = await _seed_agent(s, org_id, project_id)
            doc_id = uuid.UUID("20808e14-0000-4000-8000-000000000001")
            await _seed_doc(s, org_id, project_id, doc_id=doc_id, title="채널별 산출물 규격 표")

            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329a",
                action_text="채널별 산출물 규격 표 doc 20808e14의 해당 행을 참고해 초안 작성",
            )
            assert f"[채널별 산출물 규격 표](entity:doc:{doc_id})" in content
            assert "20808e14의" not in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_hex8_prefix_immediately_followed_by_korean_particle_still_matches():
    """⭐한글 조사 바로 붙는 실측 재현(회귀 방지) — Python 기본 `\\b`는 한글을 워드 문자로
    쳐서 "20808e14의"에서 경계가 안 생겨 매치가 실패했었다(직접 실측 확인). 이 테스트가
    그 정확한 실패 형태를 pin한다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329b")
            publisher_id = await _seed_agent(s, org_id, project_id)
            doc_id = uuid.UUID("a11c3813-0000-4000-8000-000000000001")
            await _seed_doc(s, org_id, project_id, doc_id=doc_id, title="톤 가이드")

            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329b",
                action_text="톤 가이드 a11c3813을 따라 작성하고 마침표로 끝내세요",
            )
            assert f"[톤 가이드](entity:doc:{doc_id})" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_hex8_prefix_no_match_stays_raw():
    """AC1 음성 대조 — 존재하지 않는 8자 prefix는 원문 그대로 남는다(오탐 0)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329c")
            publisher_id = await _seed_agent(s, org_id, project_id)

            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329c",
                action_text="doc deadbeef를 참고하세요",
            )
            assert "deadbeef를 참고하세요" in content
            assert "entity:doc:" not in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_hex8_prefix_ambiguous_multiple_matches_stays_raw():
    """⭐AC2 핵심 — 같은 8자 prefix로 시작하는 doc이 org 안에 2건이면(모호) 치환하지
    않는다(«실재하는 엔티티만», 그러나 유일하지 않으면 위험 — 안전하게 원문 유지)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329d")
            publisher_id = await _seed_agent(s, org_id, project_id)
            await _seed_doc(
                s, org_id, project_id,
                doc_id=uuid.UUID("cafe1234-0000-4000-8000-000000000001"), title="문서 A",
            )
            await _seed_doc(
                s, org_id, project_id,
                doc_id=uuid.UUID("cafe1234-0000-4000-8000-000000000002"), title="문서 B",
            )

            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329d",
                action_text="doc cafe1234를 참고하세요",
            )
            assert "cafe1234를 참고하세요" in content
            assert "entity:doc:" not in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_full_uuid_embedded_becomes_reference_token():
    """AC1 — 문구에 8자 prefix 대신 전체 UUID가 박혀 있어도 동일하게 토큰화된다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329e")
            publisher_id = await _seed_agent(s, org_id, project_id)
            doc_id = uuid.uuid4()
            await _seed_doc(s, org_id, project_id, doc_id=doc_id, title="규격 표 전체")

            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329e",
                action_text=f"doc {doc_id}를 참고하세요",
            )
            assert f"[규격 표 전체](entity:doc:{doc_id})" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_full_uuid_nonexistent_stays_raw():
    """AC1 음성 대조 — 존재하지 않는 전체 UUID는 원문 그대로."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329f")
            publisher_id = await _seed_agent(s, org_id, project_id)
            ghost_id = uuid.uuid4()

            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329f",
                action_text=f"doc {ghost_id}를 참고하세요",
            )
            assert f"{ghost_id}를 참고하세요" in content
            assert "entity:doc:" not in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_story_prefix_also_tokenized_not_just_doc():
    """AC1 — story #3329 문구가 "doc/story UUID"라고 명시한 대로, story id 8자 prefix도
    doc과 동일하게 토큰화된다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329g")
            publisher_id = await _seed_agent(s, org_id, project_id)
            ref_story_id = uuid.UUID("beef0001-0000-4000-8000-000000000001")
            await _seed_story(s, org_id, project_id, story_id=ref_story_id, title="참고 스토리")

            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329g",
                action_text="story beef0001의 AC를 그대로 따르세요",
            )
            assert f"[참고 스토리](entity:story:{ref_story_id})" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_multiple_embedded_refs_in_one_action_both_tokenized():
    """AC1 — 문구 하나에 서로 다른 두 참조가 박혀 있어도 둘 다 정확한 자리에 토큰화된다
    (위치 보존 pin — _async_regex_sub의 순서 처리 검증)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329h")
            publisher_id = await _seed_agent(s, org_id, project_id)
            doc1_id = uuid.UUID("11110001-0000-4000-8000-000000000001")
            doc2_id = uuid.UUID("22220002-0000-4000-8000-000000000001")
            await _seed_doc(s, org_id, project_id, doc_id=doc1_id, title="규격 표")
            await _seed_doc(s, org_id, project_id, doc_id=doc2_id, title="톤 가이드")

            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329h",
                action_text="doc 11110001과 doc 22220002를 함께 참고하세요",
            )
            assert f"[규격 표](entity:doc:{doc1_id})" in content
            assert f"[톤 가이드](entity:doc:{doc2_id})" in content
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_existing_token_title_hex8_untouched():
    """⭐PO 리뷰(PR#3713, 2026-09-02) — action 문구에 **이미** 참조 토큰이 박혀 있고, 그
    토큰의 제목 안에 다른(실재하는) doc의 8자 prefix와 우연히 같은 hex8 문자열이 들어있어도
    건드리지 않는다("토큰 속 토큰" 금지). trap 문서(E1)가 실재해 그 prefix로 해소 가능한데도
    보호구간이 막아야 한다 — trap이 없으면 이 테스트는 아무것도 증명하지 못한다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329j")
            publisher_id = await _seed_agent(s, org_id, project_id)
            outer_doc_id = uuid.UUID("aaaa1111-0000-4000-8000-000000000001")
            await _seed_doc(s, org_id, project_id, doc_id=outer_doc_id, title="커밋 bbbb2222 반영본")
            trap_doc_id = uuid.UUID("bbbb2222-0000-4000-8000-000000000001")
            await _seed_doc(s, org_id, project_id, doc_id=trap_doc_id, title="함정 문서")

            existing_token = f"[커밋 bbbb2222 반영본](entity:doc:{outer_doc_id})"
            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329j",
                action_text=f"{existing_token} 확인 요망",
            )
            assert existing_token in content
            assert f"entity:doc:{trap_doc_id}" not in content
            assert content.count("entity:doc:") == 1
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_new_token_title_hex8_prefix_no_nested_substitution():
    """⭐PO 리뷰(PR#3713, 2026-09-02) — 전체 UUID 패스가 **방금 만든** 새 토큰의 제목 안에
    다른(실재하는) doc의 8자 prefix와 같은 hex8 문자열이 들어있어도, 뒤이은 8자 prefix 패스가
    그 안까지 훑어 중첩 치환하지 않는다. trap 문서(E2)가 실재해 그 prefix로 해소 가능한데도
    막아야 한다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner = await _seed_org_with_owner(s, slug="e3329k")
            publisher_id = await _seed_agent(s, org_id, project_id)
            outer_doc_id = uuid.UUID("cccc3333-0000-4000-8000-000000000001")
            await _seed_doc(s, org_id, project_id, doc_id=outer_doc_id, title="커밋 dddd4444 반영")
            trap_doc_id = uuid.UUID("dddd4444-0000-4000-8000-000000000001")
            await _seed_doc(s, org_id, project_id, doc_id=trap_doc_id, title="함정 문서2")

            content = await _publish_draft_and_get_content(
                s, org_id, project_id, publisher_id, slug="e3329k",
                action_text=f"doc {outer_doc_id}를 참고하세요",
            )
            assert f"[커밋 dddd4444 반영](entity:doc:{outer_doc_id})" in content
            assert f"entity:doc:{trap_doc_id}" not in content
            assert content.count("entity:doc:") == 1
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_cross_org_doc_prefix_does_not_leak():
    """AC1 경계 — 다른 org에만 존재하는 8자 prefix는 이 org에선 0건이라(존재판정 org
    스코프) 원문 그대로 — IDOR류 누수 없음(#3323의 org 경계 원칙과 동형)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_a_id, project_a_id, _owner_a = await _seed_org_with_owner(s, slug="e3329i-a")
            org_b_id, project_b_id, _owner_b = await _seed_org_with_owner(s, slug="e3329i-b")
            other_doc_id = uuid.UUID("beefbeef-0000-4000-8000-000000000001")
            await _seed_doc(s, org_b_id, project_b_id, doc_id=other_doc_id, title="다른 org 문서")

            publisher_id = await _seed_agent(s, org_a_id, project_a_id)
            content = await _publish_draft_and_get_content(
                s, org_a_id, project_a_id, publisher_id, slug="e3329i",
                action_text="doc beefbeef를 참고하세요",
            )
            assert "beefbeef를 참고하세요" in content
            assert "entity:doc:" not in content
    finally:
        await engine.dispose()
