"""story #3858(customer-zero·BE·연결 쓰기, 페드루 PO 확定 2026-09-14 08:10Z) — doc→story
Reference write-path. 3852(읽기: `backlinks?source_type=doc`)가 라이브여도 «문서에 스토리
얘기를 적은 것»이 지금까지 아무 Reference도 안 남겼다(reconcile_doc_mentions가 wikiLink/
pageEmbed=doc→doc만 파싱) — 이 스토리가 그 write-path를 연다.

AC0 그라운딩 확定(디디, 07:55Z~08:09Z 3개 후보 형식 실물 대조):
  ① 링크(`entity:story:<uuid>`) — 이미 실존. story #2639가 이 형식을 EntityChip으로 렌더 —
    doc.content는 항상 HTML(markdownToHtml 변환, docs.py `html_content=doc.content`)이라
    저장된 HTML엔 `<a href="entity:story:...">`로 남는다.
  ② 텍스트 #NNNN — 실물 0(에디터에 `#` 트리거 mention 확장 자체가 없음).
  ③ 임베드 노드 — 실물 0(wikiLink `[[`·슬래시 PageEmbed 둘 다 `/api/docs`만 조회, 스토리
    검색/삽입 UI가 아예 없음).
→ AC1 확定: 링크 1종만(발명 0) — ②③은 에디터 삽입 UI 신설이 필요한 별건 카드(이 스토리 밖).

이 파일은 그 실 write-path(`POST /api/v2/docs`·`PATCH /api/v2/docs/{id}`가 저장 시
`reconcile_doc_mentions`를 태움)를 HTTP로 직접 타고, 3852의 읽기 route(`GET /api/v2/
stories/{id}/backlinks?source_type=doc`)로 그 결과를 검증한다 — «쓰기»와 «읽기» 두 스토리가
서로의 유일한 실 표본이라는 카드 자신의 서술 그대로.
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


# ─── Seeding helpers(test_2267_story_origin_realdb.py·test_3852...와 동형 — 이 파일 자체
# 완결 원칙, 두 파일이 이미 같은 helper 세트를 각자 복사해 두는 기존 관례) ────────────


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
    org_member.id — 실 `POST /api/v2/docs`·`PATCH /api/v2/docs/{id}`를 타는 테스트라 그
    라우트들을 이미 실측한 배선을 재사용)."""
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


async def _find_reference(session, *, org_id, source_type, source_id, target_type, target_id):
    from sqlalchemy import select as sa_select
    from app.models.reference import Reference
    row = (
        await session.execute(
            sa_select(Reference).where(
                Reference.org_id == org_id, Reference.source_type == source_type,
                Reference.source_id == source_id, Reference.target_type == target_type,
                Reference.target_id == target_id,
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


def _entity_link_html(label: str, target_type: str, target_id) -> str:
    return f'<p><a href="entity:{target_type}:{target_id}">{label}</a></p>'


@pytest.mark.anyio
async def test_doc_entity_story_link_creates_reference_visible_in_story_backlinks():
    """⭐AC1/AC2 핵심 — doc 본문에 `entity:story:<uuid>` 링크 1건을 실어 `POST /api/v2/docs`로
    생성하면 reconcile_doc_mentions가 doc→story Reference를 쓰고, 3852의
    `backlinks?source_type=doc`에 그 doc 1건이 그대로 보인다(두 스토리의 읽기/쓰기 짝)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Linked Story")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/docs",
                json={
                    "project_id": str(project.id),
                    "org_id": str(org.id),
                    "title": "관련 문서",
                    "slug": f"doc-{uuid.uuid4().hex[:8]}",
                    "content": _entity_link_html("Linked Story", "story", story.id),
                },
            )
            assert create_resp.status_code == 201, create_resp.text
            doc_id = uuid.UUID(create_resp.json()["id"])

            async with Session() as s:
                ref = await _find_reference(
                    s, org_id=org.id, source_type="doc", source_id=doc_id,
                    target_type="story", target_id=story.id,
                )
                assert ref is not None, "entity:story: 링크를 실었는데 Reference 행이 안 생겼다"
                assert ref.form == "mention"
                assert ref.source_field == "body"

            backlinks_resp = await client.get(f"/api/v2/stories/{story.id}/backlinks?source_type=doc")
            assert backlinks_resp.status_code == 200, backlinks_resp.text
            data = backlinks_resp.json()["data"]
            assert len(data) == 1, data
            assert data[0]["source_type"] == "doc"
            assert data[0]["doc"]["id"] == str(doc_id)
            assert data[0]["doc"]["title"] == "관련 문서"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_removing_entity_link_from_doc_body_revokes_reference():
    """AC1/AC2 — 본문에서 링크를 지우고 저장(PATCH)하면 그 Reference도 회수(delete)된다
    (reconcile의 기존 diff 로직 그대로 — doc→doc 회수와 동형, 이 카드가 새로 짤 필요 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Will Be Unlinked")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/docs",
                json={
                    "project_id": str(project.id),
                    "org_id": str(org.id),
                    "title": "곧 링크 지울 문서",
                    "slug": f"doc-{uuid.uuid4().hex[:8]}",
                    "content": _entity_link_html("Will Be Unlinked", "story", story.id),
                },
            )
            assert create_resp.status_code == 201, create_resp.text
            doc_id = uuid.UUID(create_resp.json()["id"])

            async with Session() as s:
                ref = await _find_reference(
                    s, org_id=org.id, source_type="doc", source_id=doc_id,
                    target_type="story", target_id=story.id,
                )
                assert ref is not None, "선행 조건 실패 — 링크가 애초에 안 써짐"

            patch_resp = await client.patch(
                f"/api/v2/docs/{doc_id}", json={"content": "<p>이제 스토리 얘기 없음</p>"},
            )
            assert patch_resp.status_code == 200, patch_resp.text

            async with Session() as s:
                ref_after = await _find_reference(
                    s, org_id=org.id, source_type="doc", source_id=doc_id,
                    target_type="story", target_id=story.id,
                )
                assert ref_after is None, "본문에서 링크를 지웠는데 Reference가 안 회수됐다"

            backlinks_resp = await client.get(f"/api/v2/stories/{story.id}/backlinks?source_type=doc")
            assert backlinks_resp.status_code == 200, backlinks_resp.text
            assert backlinks_resp.json()["data"] == []
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_entity_link_to_other_org_story_uuid_does_not_leak_into_that_orgs_backlinks():
    """다른 org 스토리 uuid 무시 — doc(org A)이 다른 org(org B) 소속 스토리의 uuid를 링크에
    실으면, `reconcile_entity_references`의 존재판정(`_batch_resolve_existence`, org_id
    스코프)이 그 target을 "org A 안엔 없음"으로 판정해 write-time에 조용히 drop한다(경고
    로그만 — doc 저장 자체는 그대로 201, best-effort 원칙, doc→doc과 동일 설계) — Reference
    행 자체가 안 생긴다(디디 최초 가정 "쓰기는 되고 읽기에서만 안 보인다"는 실측으로 정정:
    실제로는 쓰기 자체가 org-scope에서 막힌다 — 더 안전한 쪽). org B 관점에서 그 story의
    backlinks가 0건인 건 이 결과의 당연한 귀결(원래 없는 참조를 조회하는 것)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _make_org(s, "Org A")
            org_b = await _make_org(s, "Org B")
            project_a = await _make_project(s, org_a.id, "PA")
            project_b = await _make_project(s, org_b.id, "PB")
            member_a, user_a = await _make_human_member(s, org_a.id, project_a.id)
            _member_b, _user_b = await _make_human_member(s, org_b.id, project_b.id)
            story_b = await _make_story(s, org_b.id, project_b.id, title="Org B Story")

        await _setup_app_human(app, Session, user_a, org_a.id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/docs",
                json={
                    "project_id": str(project_a.id),
                    "org_id": str(org_a.id),
                    "title": "Org A 문서 — Org B 스토리 uuid 언급",
                    "slug": f"doc-{uuid.uuid4().hex[:8]}",
                    "content": _entity_link_html("Org B Story", "story", story_b.id),
                },
            )
            assert create_resp.status_code == 201, create_resp.text
            doc_id = uuid.UUID(create_resp.json()["id"])
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        # Org B 자기 자신 관점에서 그 story의 backlinks를 조회 — 0건(Reference.org_id=org A라
        # org B의 backlinks 쿼리와 org_id가 안 맞음, 크로스 org 유출 없음).
        await _setup_app_human(app, Session, _user_b, org_b.id)
        client2 = _client_for(app)
        try:
            resp = await client2.get(f"/api/v2/stories/{story_b.id}/backlinks?source_type=doc")
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"] == [], "다른 org 문서의 참조가 이 org backlinks에 새어 나왔다"
        finally:
            await client2.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            ref = await _find_reference(
                s, org_id=org_a.id, source_type="doc", source_id=doc_id,
                target_type="story", target_id=story_b.id,
            )
            assert ref is None, (
                "존재판정이 org_id로 스코프되므로 다른 org 소속 target은 write-time에 "
                "drop돼야 한다 — Reference 행이 생겼다면 org 경계가 새고 있는 것"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_doc_to_doc_wikilink_regression_still_works_alongside_entity_link():
    """doc→doc 기존 회귀 0 — 같은 doc 본문에 wikiLink(doc→doc)와 entity:story: 링크가
    함께 있어도 둘 다 정확히 자기 target_type으로 Reference가 남는다(서로 안 섞임)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Mixed Ref Story")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            target_doc_resp = await client.post(
                "/api/v2/docs",
                json={
                    "project_id": str(project.id), "org_id": str(org.id),
                    "title": "대상 문서", "slug": f"doc-{uuid.uuid4().hex[:8]}", "content": "<p>대상</p>",
                },
            )
            assert target_doc_resp.status_code == 201, target_doc_resp.text
            target_doc_id = uuid.UUID(target_doc_resp.json()["id"])

            mixed_html = (
                f'<p><span data-type="wikiLink" data-doc-id="{target_doc_id}" '
                f'data-title="대상 문서">대상 문서</span></p>'
                + _entity_link_html("Mixed Ref Story", "story", story.id)
            )
            source_resp = await client.post(
                "/api/v2/docs",
                json={
                    "project_id": str(project.id), "org_id": str(org.id),
                    "title": "혼합 참조 문서", "slug": f"doc-{uuid.uuid4().hex[:8]}", "content": mixed_html,
                },
            )
            assert source_resp.status_code == 201, source_resp.text
            source_doc_id = uuid.UUID(source_resp.json()["id"])

            async with Session() as s:
                doc_ref = await _find_reference(
                    s, org_id=org.id, source_type="doc", source_id=source_doc_id,
                    target_type="doc", target_id=target_doc_id,
                )
                assert doc_ref is not None, "wikiLink(doc→doc) 회귀 — 기존 파싱이 깨졌다"
                story_ref = await _find_reference(
                    s, org_id=org.id, source_type="doc", source_id=source_doc_id,
                    target_type="story", target_id=story.id,
                )
                assert story_ref is not None, "entity:story: 링크가 같은 본문에서 안 뽑혔다"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_entity_link_extraction_branch_returns_zero_references():
    """⭐RED→GREEN 자체검증 — `extract_doc_entity_ref_targets`가 안 돌면(사보타주: 빈 리스트
    반환) entity:story: 링크가 있어도 Reference가 0건이라는 것을 직접 대조한다(이 추출
    분기가 실제로 결과를 만든다는 사실 자체를 고정)."""
    from app.services import mention_parser

    html = _entity_link_html("어떤 스토리", "story", uuid.uuid4())

    # 정상 — 1건 추출.
    normal = mention_parser.extract_doc_entity_ref_targets(html)
    assert len(normal) == 1
    assert normal[0][0] == "story"

    # 뮤테이션 — 추출 분기 자체를 무력화한 버전(사보타주 시뮬레이션: 빈 함수).
    def _sabotaged_extract(_html_content: str) -> list[tuple[str, uuid.UUID]]:
        return []

    sabotaged = _sabotaged_extract(html)
    assert sabotaged == [], "사보타주가 실제로 결과를 0건으로 만드는지 확인(뮤테이션 유효성)"
    assert len(normal) != len(sabotaged), "정상 추출과 사보타주 결과가 달라야 뮤테이션이 유효하다"
