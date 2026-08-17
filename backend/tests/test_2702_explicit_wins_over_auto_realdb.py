"""story #2702([채팅·참조·잔여] bare #N + 명시 멘션 공존 시 origin=auto가 이겨 backlink에서
빠지는 결함) — 실PG 검증.

PO 라이브 프로브(2026-08-17, dev b330a06e) 재현: 한 메시지에 같은 story를 가리키는
bare `#N`과 명시 브라켓 멘션이 **함께** 있으면, `promote_bare_story_refs`가 본문을
치환한 뒤로는 파싱만으로 "이 target_id가 애초에 명시로도 타이핑돼 있었다"를 못 가른다
(승격이 심은 토큰과 사람이 직접 친 토큰이 문법상 동일해진다) — 그 결과 origin='auto'로
저장돼 backlinks(explicit 필터)에서 «진짜 참조»가 유실됐다.

fix: `conversations.py`의 `promote_bare_story_refs` 호출 직전, 승격 *전* 원문에서
`extract_chat_entity_mentions`로 명시 멘션 story_id 집합을 먼저 뽑아 `auto_story_ids`에서
빼 둔다 — `insert_chat_mentions`의 기존 origin 판정(`eid in auto_story_ids`)이 자연히
explicit을 고르게 된다(#2679가 이미 만든 판정 로직 자체는 그대로, ambiguity가 생기는
"호출부" 한 곳만 고쳤다).

커버:
  AC1: bare #N + 같은 story 명시 멘션 공존 → 단일 Reference 행, origin='explicit'.
  AC2: 양성대조 — bare만(auto·정본 #2679 테스트 무변경) / 명시만(explicit·정본 #2679
       테스트 무변경) — 이 파일은 새 케이스만 추가하고 #2679 파일은 안 건드린다.
  AC4: 소급 백필 없음(과거 메시지의 겹침 행은 origin='auto' 그대로) — 이 fix는 저장
       시점 write-path에만 적용된다(#2679와 동일 판단, 코드 변경 자체가 그 범위임을 증명).
"""
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


# ─── seeding — test_2629/test_2679의 동형 anchor 패턴 재사용 ───────────────────

async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2702", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org, project


async def _seed_agent(session, org_id, project_id):
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name="agent"))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted",
    ))
    await session.commit()
    return member_id


async def _seed_story(session, org_id, project_id, *, number, title="타깃"):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        status="backlog", story_number=number,
    )
    session.add(story)
    await session.commit()
    return story


async def _seed_conversation(session, org_id, project_id, member_ids, created_by):
    from app.models.conversation import Conversation, ConversationParticipant
    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="group",
        title="T", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _seed_human(session, org_id, project_id):
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
    return om.id, user_id


def _agent_auth(agent_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"org_id": str(org_id), "api_key_id": str(uuid.uuid4())}},
    )


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    """story #2451: get_db 오버라이드는 반드시 conftest.override_db_and_read 경유."""
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _user():
        return AuthContext(user_id=str(user_id), email="h@test.com", claims={"app_metadata": {"org_id": str(org_id)}})

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _user


# ─── AC1 — bare #N + 같은 story 명시 멘션 공존 → explicit 승 ───────────────────

async def test_bare_and_explicit_mention_same_story_stores_single_explicit_row():
    """PO 프로브1 그대로 pin: bare 「#N」+ mentions=[story #N] 같은 메시지 → 그 target
    행 origin='explicit'·단일 행(auto/explicit 이중 저장 아님 — 유일성 인덱스가 origin을
    안 보므로 애초에 두 행이 될 수 없다, 그래서 '어느 origin이 남는가'만 검증하면 충분)."""
    from fastapi import BackgroundTasks
    from sqlalchemy import select

    from app.models.reference import Reference
    from app.routers.conversations import SendMessageRequest, send_message
    from app.services.reference_token import build_reference_token

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            target = await _seed_story(s, org.id, project.id, number=24, title="타깃")
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id], created_by=agent_id)

        token = build_reference_token("story", target.id, "타깃")
        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                # 같은 story를 bare #24와 명시 토큰 둘 다로 가리킨다 — "#2679 (자세한 건 [링크])" 류
                # 흔한 글쓰기의 정확한 재현.
                body=SendMessageRequest(content=f"#24 참고 — 자세한 건 {token}"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_agent_auth(agent_id, org.id), org_id=org.id,
            )

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(
                    Reference.org_id == org.id,
                    Reference.source_id == uuid.UUID(result["data"]["id"]),
                    Reference.target_type == "story", Reference.target_id == target.id,
                )
            )).scalars().all()
            assert len(rows) == 1, "auto/explicit 이중 저장이면 이 fix가 아니라 유일성 인덱스 자체가 깨진 것"
            assert rows[0].origin == "explicit"
    finally:
        await engine.dispose()


async def _seed_message(session, conversation_id, sender_id, content="본문"):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conversation_id, sender_id=sender_id, content=content,
    )
    session.add(msg)
    await session.commit()
    return msg


async def _make_reference(session, org_id, source_type, source_id, target_type, target_id, created_by, origin):
    from app.models.reference import Reference
    ref = Reference(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_field="body",
        source_id=source_id, target_type=target_type, target_id=target_id, form="mention",
        origin=origin, created_by=created_by,
    )
    session.add(ref)
    await session.commit()
    return ref


async def test_backlinks_endpoint_includes_target_when_row_is_explicit_after_fix():
    """AC1의 read-path 짝 — #2679::test_backlinks_endpoint_excludes_auto_includes_explicit와
    동일 패턴(직접 구성한 Reference, 사람 뷰어 조회) — 이 fix가 실제로 만드는 행 모양
    (bare+explicit 공존 메시지가 write-path에서 귀결하는 origin='explicit' 단일 행,
    test 1이 그 write-path 자체를 실증)이 read-path에서도 정상 노출됨을 확認한다.
    write-path(send_message 전체 경로)는 test 1이 이미 실증했으므로 여기서 다시 왕복하지
    않는다(같은 관심사를 두 번 재는 대신, read-path만 독립적으로 고정)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            viewer_id, viewer_user_id = await _seed_human(s, org.id, project.id)
            target = await _seed_story(s, org.id, project.id, number=25, title="타깃2")
            # conversation_readable_predicate(app/services/conversation_auth.py) — 뷰어가
            # participant가 아니면(project access만으론 부족) chat_message source는 안 보인다
            # (is_participant AND project_access_valid 조합만 이 조합에서 통과) — 뷰어를
            # participant로 포함해야 실제 열람 가능한 상태를 재현한다.
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id, viewer_id], created_by=agent_id)
            source_msg = await _seed_message(s, conv_id, agent_id)
            await _make_reference(
                s, org.id, "chat_message", source_msg.id, "story", target.id, agent_id, "explicit",
            )
            source_msg_id = source_msg.id

        await _setup_app_human(app, Session, viewer_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{target.id}/backlinks")
            assert resp.status_code == 200, resp.text
            source_ids = {item["source_id"] for item in resp.json()["data"]}
            assert str(source_msg_id) in source_ids, (
                "bare #N + 명시 멘션 공존 메시지가 origin='explicit'로 저장됐다면 backlinks에 "
                "떠야 한다 — origin='auto'로 새면(story #2702 회귀) 여기서 빠진다"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── AC3 뮤테이션 근거(수동 재확인 기록, 자동 실행 아님) ─────────────────────────
# conversations.py의 `_auto_story_ids -= _explicit_story_ids_before_promotion` 한 줄을
# 되돌리면 위 test_bare_and_explicit_mention_same_story_stores_single_explicit_row가
# origin == "auto"로 떨어져 RED — 수동 재확인 완료(PR 본문/커밋 메시지 기록).
