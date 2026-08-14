"""story #2629(챗·전달계약) — 본문의 맨 스토리 번호(`#24`류)를 서버가 entity 임베드로
자동 승격. P0의 본문 `@handle` 파서와 동형 철학(read-only 해석이 아니라 본문 자체를
저장 시점에 치환하는 첫 사례).

커버: ①순수 regex 후보 추출(dev 실측 오탐 경계 — 헥스 컬러 배제·한글 조사 결합 통과)
②보호 구간(코드블록/인라인코드/기존 entity 토큰) ③실 DB resolve(org+project 스코프·
실패 시 원문 유지·타 project 미스코프) ④send_message() 전체 경로에서 agent/human 양쪽
동형 적용(AC3)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


# ── ① 순수 regex 후보 추출 — dev 실측 오탐 경계 그대로 고정 ─────────────────────
def test_extract_bare_ref_plain_number():
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    content = "보드 확인은 #24 참고"
    cands = extract_bare_story_ref_candidates(content)
    assert len(cands) == 1
    start, end, number = cands[0]
    assert number == 24
    assert content[start:end] == "#24"


def test_extract_bare_ref_korean_particle_attached():
    """dev 실측 다수 형태 — #2629와 처럼 한글 조사가 공백 없이 바로 붙는 케이스."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    content = "#2629와 #2642로 같이 보는"
    cands = extract_bare_story_ref_candidates(content)
    numbers = [c[2] for c in cands]
    assert numbers == [2629, 2642]


def test_extract_bare_ref_hex_color_excluded():
    """dev 실측 1위 오탐 축 — 매치 직후 라틴 알파벳이면(헥스 컬러류) 통째로 제외."""
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("baseline `#74747c` 톤") == []
    assert extract_bare_story_ref_candidates("색상 #95959c 확인") == []


def test_extract_bare_ref_double_hash_excluded():
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("## 42 제목") == []


def test_extract_bare_ref_multiple_and_none():
    from app.services.story_ref_promoter import extract_bare_story_ref_candidates
    assert extract_bare_story_ref_candidates("") == []
    assert extract_bare_story_ref_candidates("아무 번호도 없음") == []
    cands = extract_bare_story_ref_candidates("#1 그리고 #2 둘 다")
    assert [c[2] for c in cands] == [1, 2]


# ── ② 보호 구간 ────────────────────────────────────────────────────────────────
async def test_promote_skips_fenced_code_block():
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = "설명\n```\n# 24 이건 셸 주석\n```\n끝"
            result = await promote_bare_story_refs(s, org_id=org.id, project_id=project.id, content=content)
            assert result == content  # 코드블록 안이라 무변환
    finally:
        await engine.dispose()


async def test_promote_skips_inline_code():
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = "명령어 `git checkout #24` 참고"
            result = await promote_bare_story_refs(s, org_id=org.id, project_id=project.id, content=content)
            assert result == content
    finally:
        await engine.dispose()


async def test_promote_skips_existing_entity_token():
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            content = "[이슈 #24 수정](entity:story:11111111-1111-1111-1111-111111111111) 참고"
            result = await promote_bare_story_refs(s, org_id=org.id, project_id=project.id, content=content)
            assert result == content  # 이미 토큰 안 — 이중 변환 금지
    finally:
        await engine.dispose()


# ── ③ 실 DB resolve ────────────────────────────────────────────────────────────
async def test_promote_resolves_existing_story_to_entity_token():
    from app.services.story_ref_promoter import promote_bare_story_refs
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            result = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content="확인은 #24 참고",
            )
            expected_token = build_reference_token("story", story.id, "보드 리팩터")
            assert result == f"확인은 {expected_token} 참고"
    finally:
        await engine.dispose()


async def test_promote_unresolved_number_kept_verbatim():
    """resolve 실패(그 번호 story 없음) — 그 매치만 원문 유지, all-or-nothing 아님."""
    from app.services.story_ref_promoter import promote_bare_story_refs
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            result = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content="#24 그리고 #9999",
            )
            expected_token = build_reference_token("story", story.id, "보드 리팩터")
            assert result == f"{expected_token} 그리고 #9999"
    finally:
        await engine.dispose()


async def test_promote_scoped_to_project_cross_project_not_resolved():
    """같은 org 다른 project의 동일 story_number는 resolve 안 됨(스코프 경계)."""
    from app.models.project import Project
    from app.services.story_ref_promoter import promote_bare_story_refs

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            other_project = Project(id=uuid.uuid4(), org_id=org.id, name="Other")
            s.add(other_project)
            await s.commit()
            await _seed_story(s, org.id, other_project.id, number=24, title="다른 프로젝트 스토리")

            result = await promote_bare_story_refs(
                s, org_id=org.id, project_id=project.id, content="#24 참고",
            )
            assert result == "#24 참고"  # 다른 project 소속이라 미승격
    finally:
        await engine.dispose()


# ── ④ send_message() 전체 경로 — agent/human 양쪽 동형(AC3) ─────────────────────
async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2629", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org, project


async def _seed_story(session, org_id, project_id, *, number, title):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        status="backlog", story_number=number,
    )
    session.add(story)
    await session.commit()
    return story


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name=name))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id))
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted"))
    await session.commit()
    return member_id


async def _seed_human(session, org_id, project_id):
    """team_members는 실 migrated DB에선 VIEW(members ⋈ project_access, migration 0088)라
    직접 INSERT 불가 — anchor 경로(Member+ProjectAccess.org_member_id)로 시드한다
    (test_1994_backlink_api_realdb.py::_make_human_member와 동형 패턴)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"h-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    session.add(Member(id=om.id, org_id=org_id, type="human", user_id=user_id, name="Human"))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, member_id=om.id,
        permission="granted", role="member",
    ))
    await session.commit()
    return user_id


async def _seed_conversation(session, org_id, project_id, member_ids, created_by):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="group",
        title="Test", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


def _agent_auth(agent_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"org_id": str(org_id), "api_key_id": str(uuid.uuid4())}},
    )


def _human_auth(user_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="human@test.com",
        claims={"app_metadata": {"org_id": str(org_id)}},
    )


async def test_send_message_promotes_bare_ref_for_agent_sender():
    from fastapi import BackgroundTasks
    from app.routers.conversations import SendMessageRequest, send_message
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id], created_by=agent_id)

        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content="확인은 #24 참고"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_agent_auth(agent_id, org.id), org_id=org.id,
            )
            expected_token = build_reference_token("story", story.id, "보드 리팩터")
            assert result["data"]["content"] == f"확인은 {expected_token} 참고"
    finally:
        await engine.dispose()


async def test_send_message_promotes_bare_ref_for_human_sender():
    """AC3 — 사람 발신 메시지도 동형 동작(발신자 타입 무관)."""
    from fastapi import BackgroundTasks
    from app.routers.conversations import SendMessageRequest, send_message
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            user_id = await _seed_human(s, org.id, project.id)
            story = await _seed_story(s, org.id, project.id, number=24, title="보드 리팩터")
            conv_id = await _seed_conversation(s, org.id, project.id, [user_id], created_by=user_id)

        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content="확인은 #24 참고"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_human_auth(user_id, org.id), org_id=org.id,
            )
            expected_token = build_reference_token("story", story.id, "보드 리팩터")
            assert result["data"]["content"] == f"확인은 {expected_token} 참고"
    finally:
        await engine.dispose()


async def test_send_message_no_bare_ref_unaffected():
    """무회귀 — 매치할 게 없으면 content가 그대로 저장된다."""
    from fastapi import BackgroundTasks
    from app.routers.conversations import SendMessageRequest, send_message

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id], created_by=agent_id)

        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content="그냥 평문 메시지"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_agent_auth(agent_id, org.id), org_id=org.id,
            )
            assert result["data"]["content"] == "그냥 평문 메시지"
    finally:
        await engine.dispose()
