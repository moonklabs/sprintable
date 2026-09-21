"""story #3313(마케팅자동화·온보딩 결함) — 사이클형 정의의 stage 이벤트 알림이 role/action·
다음 stage·발행 예시·work item 참조 토큰을 싣는지(AC1/AC2) 실왕복 검증. stage_metadata 없는
비사이클형 정의는 바이트 동일 렌더(AC3-②, 지어낼 stage_metadata 자체가 없다).

⛔story #4076(2026-09-21) — AC3-①("block_template 있는 정의는 바이트 동일")은 폐기됐다.
그 전제(block_template 있으면 FE P2 렌더러가 담당하니 이 plain body는 안 건드려도 된다)가
틀렸다 — 멘션을 받는 에이전트는 block_template을 못 본다. 아래
`test_definition_with_block_template_now_renders_self_describing_content`가 새 계약(자기
설명 렌더가 block_template 유무와 무관하게 적용됨)을 pin한다."""
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


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """story a05da51b — 이 파일은 publish_registry_event/publish_preset_event/
    transition_gate/send_message 중 하나를 호출해 실제로 메시지를 발행하거나 게이트를
    전이시킨다 — `send_message`의 background task(`mark_agent_replied`)가 이 파일의
    throwaway 엔진이 아니라 `app.core.database.async_session_factory`(전역·프로세스
    수명 엔진)를 쓴다. destructive_schema 마커 파일이라 story #3330(PR#3711)이 conftest.py
    에 심은 전역 autouse(non-destructive 전용 스코프)의 적용 대상이 아니다 — 이 파일
    자신의 여러 테스트가 한 pytest 세션 안에서 순차 실행되며 같은 전역 엔진을 반복
    사용하므로, dispose 없이 두면 pytest-anyio의 테스트별 새 이벤트 루프 사이에서 커넥션
    누수/`Event loop is closed`로 이어질 수 있다(story #3330/PR#3711 실사고 — test_3330_
    gate_verdict_notification.py에서 최초 재현). 이 realdb 하네스의 표준 방어 fixture
    재사용(새 로직 0, story a05da51b — scripts/lint_destructive_publish_path_dispose_
    fixture.py 가드 대상)."""
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


async def _seed_org_project_with_owner(session, *, slug="e3313"):
    """story #4076 — `stage_metadata[stage].gate` 선언이 있는 stage를 발행하면
    `maybe_create_stage_gate`가 approver="org_owner"를 실제로 해소하려 한다(test_3312의
    `_seed_org_with_owner`와 동형) — org owner가 없으면 UnknownApproverRoleError로 발행
    자체가 죽는다(이 함수는 events.py의 try/except GenerationBudgetExceededError 밖이라
    안 잡힘). 게이트 문구 테스트는 이 helper로 org를 세운다."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project

    org = Organization(id=uuid.uuid4(), name="Org3313", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=uuid.uuid4(), role="owner")
    session.add(owner_member)
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
    """work item title을 못 찾으면(work_item_type이 이 렌더러가 지원하는 타입 — story·task·
    doc·visual_artifact·epic, story #3884가 doc/visual_artifact를, story #3893
    CHANGES②가 epic을 추가로 확장 — 자체가 아님) 참조 토큰 대신 원시 work_item_type/
    work_item_id를 그대로 남긴다(정보 손실 없음, 지어내지 않음). story #3884 이전엔 doc이
    이 미지원 예시였으나 doc 리졸버 추가로 더는 유효하지 않았고(doc은 실제로 해소된다),
    그래서 epic으로 교체했었는데 story #3893 CHANGES②가 epic도 해소되게 만들어 또
    교체 필요 — sprint로 교체: PROJECT_SCOPED_WORK_ITEM_TYPES(gate_service.py)엔 있어
    발행 자체(project 해소)는 성공하면서도, 이 함수(제목 lookup)의 5종(story·task·doc·
    visual_artifact·epic)엔 없어 "미지원 타입" 취지가 그대로 유효하다(agent_decision·
    support_escalation은 project-무관 self-referencing anchor라 발행 자체가 400으로
    막혀 이 시나리오에 못 쓴다 — 별개 관심사와 섞임 방지, 3884 실측으로 발견)."""
    from app.models.pm import Sprint

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313c")
            publisher_id = await _seed_agent(s, org_id, project_id)
            sprint = Sprint(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="어떤 스프린트")
            s.add(sprint)
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
                payload={"stage": "monitor", "work_item_type": "sprint", "work_item_id": str(sprint.id)},
                publisher_id=publisher_id, org_id=org_id,
            )
            assert "- work_item_type: sprint" in content
            assert f"- work_item_id: {sprint.id}" in content
            assert "entity:sprint:" not in content
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_doc_work_item_now_resolves_to_reference_token():
    """story #3884(AC1(b)) — doc은 더 이상 「미지원 타입」이 아니다(위 테스트가 agent_decision
    으로 교체된 이유). 실 Doc을 참조하면 참조 토큰(클릭 가능한 [제목](entity:doc:id))으로
    해소되고 원시 raw work_item_id 줄은 남지 않는다(3313 원 계약이 확장됐다는 걸 직접 고정)."""
    from app.models.doc import Doc

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313e")
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
                s, org_id, slug="e3313e",
                stage_metadata={"monitor": {"role": "Scout", "action": "감지"}},
                payload_schema=schema,
            )
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key,
                payload={"stage": "monitor", "work_item_type": "doc", "work_item_id": str(doc.id)},
                publisher_id=publisher_id, org_id=org_id,
            )
            assert f"entity:doc:{doc.id}" in content
            assert "어떤 문서" in content
            assert "- work_item_type: doc" not in content
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_definition_with_block_template_now_renders_self_describing_content():
    """⭐story #4076 — AC3-①(옛 「block_template 있으면 바이트 동일」) 폐기를 직접 pin.
    가드에서 `block_template is not None` 절을 되돌리면 이 테스트가 다시 제네릭 폴백만
    받아 RED가 된다(뮤테이션 셀프체크 대상). block_template 필드 자체는 그대로 저장돼
    있다는 것도 같이 확認(FE 카드 회귀 0 — 필드는 안 건드렸다는 근거)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e3313d")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(
                s, org_id, slug="e3313d",
                stage_metadata={
                    "monitor": {"role": "Scout", "action": "감지"},
                    "research": {"role": "Researcher", "action": "조사"},
                },
                block_template={"title": "템플릿 있음"},
            )
            payload = {"stage": "monitor", "work_item_type": "story", "work_item_id": str(story_id)}
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key, payload=payload, publisher_id=publisher_id, org_id=org_id,
            )
            assert content != _generic_expected(definition_key, payload)
            assert "- stage: monitor (Scout)" in content
            assert "- 할 일: 감지" in content
            assert "- 다음 단계: research (Researcher)" in content
            assert "publish_event(" in content

            from sqlalchemy import select
            from app.models.event_definition import EventDefinition

            row = (await s.execute(
                select(EventDefinition).where(EventDefinition.key == definition_key)
            )).scalar_one()
            assert row.block_template == {"title": "템플릿 있음"}
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_current_stage_gate_shows_already_open_sentence_and_no_immediate_example():
    """⭐story #4076 ④(스코프 B) — 지금 발행되는 stage 자체에 gate 선언이 있으면, 그
    발행(=이 알림을 만드는 바로 그 발행)이 `maybe_create_stage_gate`로 이미 게이트를 열어
    뒀다(events.py:1845 이하, routing 직후·메시지 발송 前). 다음 stage를 지금 발행하면
    안 되므로(승인 대기 中) 즉시 발행 예시를 생략하고 "이미 열려 있습니다" 문구로 대체.
    뮤테이션 셀프체크 대상: 이 gate 분기를 지우면 publish_event(가 다시 나타나 RED."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project_with_owner(s, slug="e3313h")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(
                s, org_id, slug="e3313h",
                stage_metadata={
                    "monitor": {
                        "role": "Scout", "action": "감지",
                        "gate": {"type": "checkpoint", "approver": "org_owner"},
                    },
                    "research": {"role": "Researcher", "action": "조사"},
                },
            )
            payload = {"stage": "monitor", "work_item_type": "story", "work_item_id": str(story_id)}
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key, payload=payload, publisher_id=publisher_id, org_id=org_id,
            )
            assert "지금 사람 승인 게이트가 열려 있습니다(승인자 역할: org_owner)" in content
            assert "preset.gate.verdict" in content
            assert "- 다음 단계: research (Researcher)" in content
            assert "publish_event(" not in content
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_next_stage_gate_keeps_example_and_appends_opens_on_publish_note():
    """⭐story #4076 ④(스코프 A) — 지금 stage엔 gate가 없지만, 안내하는 다음 stage 자체에
    gate 선언이 있으면 그 발행이 게이트를 여는 트리거다. 발행 예시를 빼면 에이전트가 게이트를
    여는 방법 자체를 모르게 되므로(페드루 PO 지적) 예시는 그대로 두고 결과 안내만 덧붙인다.
    뮤테이션 셀프체크 대상: 안내 문장을 지우면 이 assert만 RED(예시 자체는 안 깨짐)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project_with_owner(s, slug="e3313i")
            publisher_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition_key = await _seed_definition(
                s, org_id, slug="e3313i",
                stage_metadata={
                    "monitor": {"role": "Scout", "action": "감지"},
                    "research": {
                        "role": "Researcher", "action": "조사",
                        "gate": {"type": "checkpoint", "approver": "org_owner"},
                    },
                },
            )
            payload = {"stage": "monitor", "work_item_type": "story", "work_item_id": str(story_id)}
            content, _resp = await _publish_and_get_content(
                s, definition_key=definition_key, payload=payload, publisher_id=publisher_id, org_id=org_id,
            )
            assert "publish_event(" in content
            assert "- 다음 단계: research (Researcher)" in content
            assert "이 발행을 하면 사람 승인 게이트가 열립니다" in content
            assert "preset.gate.verdict" in content
            assert "지금 사람 승인 게이트가 열려 있습니다" not in content
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
