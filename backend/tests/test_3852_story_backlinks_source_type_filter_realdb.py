"""story #3852(customer-zero·BE·연결 읽기, 페드루 PO 확定 2026-09-14 07:51Z) — 「스토리에
붙은 문서」읽기. 그라운딩 결론(디디, AC0 확定): docs.story_id FK는 0 — 연결은 전부
`entity_references`(Reference) 표를 경유한다. 새 route를 만들지 않고 기존
`GET /api/v2/stories/{id}/backlinks`에 옵션 쿼리 파라미터 `source_type` 1개만 더한다.

⛔재확認(디디, 착수 중 정정, 07:55Z → 페드루 판정 07:55Z) — AC2 원안은 "문서 본문 #NNNN
언급 → reconcile_doc_mentions → backlinks?source_type=doc"였으나, `reconcile_doc_mentions`
(mention_parser.py)의 `extract_doc_mention_targets`는 `data-doc-id`(wikiLink/pageEmbed)만
파싱하고 extracted_refs의 target_type이 "doc"으로 하드코딩돼 있다 — 문서 본문은 다른
문서만 가리킬 수 있고 스토리는 가리킬 수 없다(현재 코드베이스 실측, doc→story Reference
실 write-path는 stories.py의 `origin_type='doc'` created_from 부착 1종뿐). 페드루 판정:
AC2 정본 테스트는 **그 실 write-path**(story 생성 시 origin_type=doc → created_from
Reference → backlinks?source_type=doc)를 타야 한다(test_2267_story_origin_realdb.py의
`test_story_creation_with_origin_leaves_created_from_reference_visible_in_backlinks`와
동형, origin이 chat_message 대신 doc). 배제 축(다른 source_type 제외·다른 org 격리)은
`_make_reference`(test_2266과 동일 관례) 직접 insert로 보강 — 「배제」만 재는 용도라
실 write-path가 필수는 아니다.
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

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


# ─── Seeding helpers(test_2266_story_backlinks_realdb.py·test_1994_backlink_api_realdb.py와
# 동형 — 이 파일 자체 완결, twin-system 재발명 아님 — 두 파일이 이미 같은 helper 세트를
# 각자 복사해 두는 기존 관례를 그대로 따른다) ──────────────────────────────────


async def _make_org(session, name="Org"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_id):
    """test_2267_story_origin_realdb.py의 동명 helper와 동일 anchor 패턴(member.id ==
    org_member.id — 실 `POST /api/v2/stories`(create_story)를 타는 테스트라, 그 라우트를
    이미 실측한 파일의 정확한 배선을 재사용한다: members + org_members + project_access
    직접 write — team_members는 VIEW라 INSERT 불가)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name="Human")
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="backlog")
    session.add(story)
    await session.commit()
    return story


async def _make_doc(session, org_id, project_id, title="Doc", content=""):
    from app.models.doc import Doc
    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=f"doc-{uuid.uuid4().hex[:8]}", content=content,
    )
    session.add(doc)
    await session.commit()
    return doc


async def _make_conversation(session, org_id, project_id, member_ids, created_by, conv_type="dm"):
    from app.models.conversation import Conversation, ConversationParticipant
    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type=conv_type,
        title="Test convo", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _add_message(session, conv_id, sender_id, content, created_at=None):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content=content, created_at=created_at or datetime.now(UTC),
    )
    session.add(msg)
    await session.commit()
    return msg


async def _make_reference(session, org_id, source_type, source_id, target_type, target_id, created_by, form="mention"):
    from app.models.reference import Reference
    ref = Reference(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_field="body",
        source_id=source_id, target_type=target_type, target_id=target_id, form=form,
        created_by=created_by,
    )
    session.add(ref)
    await session.commit()
    return ref


async def _find_reference_by_source(session, *, org_id, source_type, source_id, target_id):
    """test_2267_story_origin_realdb.py의 `_find_reference`와 동형(이 파일 자체완결 원칙 —
    import 대신 재정의, 두 파일이 이미 같은 helper 세트를 각자 복사해 두는 기존 관례)."""
    from sqlalchemy import select as sa_select
    from app.models.reference import Reference
    row = (
        await session.execute(
            sa_select(Reference).where(
                Reference.org_id == org_id, Reference.source_type == source_type,
                Reference.source_id == source_id, Reference.target_id == target_id,
            )
        )
    ).scalar_one_or_none()
    return row


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_source_type_doc_filter_returns_only_doc_rows_via_real_created_from_writepath():
    """⭐AC1/AC2 핵심(페드루 판정 07:55Z, 정본 시나리오) — 실 write-path로 doc→story
    Reference를 만든다: `POST /api/v2/stories`에 `origin_type=doc·origin_id=<doc.id>`를
    실어 스토리를 생성하면 stories.py:852의 자동부착이 `relation=created_from` Reference를
    쓴다(test_2267_story_origin_realdb.py의 동형 happy-path와 origin만 doc으로 교체). 같은
    스토리에 chat_message 참조도 하나 더(다른 소스) 붙여 `?source_type=doc`가 doc 1건만
    걸러내는지, 파라미터 생략 시 2건 전량인지 함께 잰다(응답 item shape 무변)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            doc = await _make_doc(s, org.id, project.id, title="Origin Doc")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, "이것도 참고")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id),
                    "org_id": str(org.id),
                    "title": "문서에서 만든 스토리",
                    "origin_type": "doc",
                    "origin_id": str(doc.id),
                },
            )
            assert create_resp.status_code == 201, create_resp.text
            story_id = uuid.UUID(create_resp.json()["id"])

            async with Session() as s:
                ref = await _find_reference_by_source(
                    s, org_id=org.id, source_type="doc", source_id=doc.id, target_id=story_id,
                )
                assert ref is not None, "origin_type=doc/origin_id를 줬는데 참조 행이 안 생겼다"
                assert ref.relation == "created_from"
                assert ref.target_type == "story"
                # 이제 같은 스토리에 chat_message 소스도 하나 더(source_type 필터의 배제
                # 대상 — 같은 target_id를 다른 source_type이 함께 가리키는 흔한 실제 모양).
                await _make_reference(
                    s, org.id, "chat_message", msg.id, "story", story_id, created_by=member_id,
                )

            resp = await client.get(f"/api/v2/stories/{story_id}/backlinks?source_type=doc")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 1, body
            assert body["data"][0]["source_type"] == "doc"
            assert body["data"][0]["relation"] == "created_from"
            assert body["data"][0]["doc"]["id"] == str(doc.id)
            assert body["data"][0]["doc"]["title"] == "Origin Doc"

            # 파라미터 생략 시 현행 전량(2건) — 회귀 0(AC1 "응답 모양 무변" 재확認).
            resp_all = await client.get(f"/api/v2/stories/{story_id}/backlinks")
            assert resp_all.status_code == 200, resp_all.text
            assert len(resp_all.json()["data"]) == 2
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_source_type_doc_filter_zero_when_only_chat_message_linked():
    """연결 없음(doc 0건) — chat_message만 있을 때 `?source_type=doc`는 빈 배열(존재하는데
    안 보이는 게 아니라 진짜 0건 — collection scope는 유지, AC2 「없음」 축)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="No Doc")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, "언급함")
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks?source_type=doc")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["data"] == []
            assert body["meta"]["has_more"] is False
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_source_type_doc_filter_excludes_other_org_doc_reference():
    """다른 org 격리 — 같은 story_id를 가리키는 doc reference가 있어도 그 doc/참조가 다른
    org 소속이면 이 org의 caller에겐 0건(org_id 크로스 매치 0, IDOR 회귀가드 동형)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s, "Org A")
            other_org = await _make_org(s, "Org B")
            project = await _make_project(s, org.id, "P")
            other_project = await _make_project(s, other_org.id, "P2")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            other_member_id, _ = await _make_human_member(s, other_org.id, other_project.id)

            story = await _make_story(s, org.id, project.id, title="Org A Story")
            other_doc = await _make_doc(s, other_org.id, other_project.id, title="Org B Doc")
            # 다른 org 소속 Reference(org_id=other_org) — Reference.org_id 자체가 다른
            # org이므로 org A의 backlinks 쿼리(Reference.org_id == org_id)가 애초에 이 행을
            # 안 본다(위 IDOR 축과 별개로 이미 격리되는 축 — 그래도 실측으로 고정한다).
            await _make_reference(
                s, other_org.id, "doc", other_doc.id, "story", story.id, created_by=other_member_id,
            )

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks?source_type=doc")
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"] == []
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_source_type_invalid_value_rejected_422():
    """AC1 — 허용목록 밖 값은 422(FastAPI Literal 검증, 라우터 경계 — list_entity_backlinks
    호출 전에 거절돼 서비스 계층 UnsupportedBacklinkSourceTypeError는 이 경로로 도달 불가)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="S")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks?source_type=epic")
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_ignoring_source_type_filter_returns_oversized_page():
    """⭐RED→GREEN 자체검증 — `list_entity_backlinks`의 source_type WHERE절을 사보타주(주석
    처리 시뮬레이션 = 그 필터를 안 거는 별도 쿼리 실행)하면 doc 1건이 아니라 doc+chat_message
    2건이 돌아온다는 것을 직접 확인 — 이 테스트가 «필터가 실제로 결과 집합을 좁힌다»는
    사실 자체를 고정한다(필터를 지워도 우연히 같은 결과가 나오는 축퇴 케이스가 아님을 증명)."""
    from sqlalchemy import select

    from app.models.reference import Reference

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, _user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="S")
            doc = await _make_doc(s, org.id, project.id, title="D")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, "m")
            await _make_reference(s, org.id, "doc", doc.id, "story", story.id, created_by=member_id)
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_id)

            # 필터 적용(정상 계약) — 1건.
            filtered = (await s.execute(
                select(Reference).where(
                    Reference.org_id == org.id, Reference.target_type == "story",
                    Reference.target_id == story.id, Reference.source_type == "doc",
                )
            )).scalars().all()
            assert len(filtered) == 1

            # 뮤테이션 — source_type 조건을 뺀 "만약 필터를 안 걸었다면" 쿼리(사보타주 시뮬레이션).
            unfiltered = (await s.execute(
                select(Reference).where(
                    Reference.org_id == org.id, Reference.target_type == "story",
                    Reference.target_id == story.id,
                )
            )).scalars().all()
            assert len(unfiltered) == 2, "필터를 빼면 doc+chat_message 2건이 나와야 뮤테이션이 유효하다"
    finally:
        await engine.dispose()
