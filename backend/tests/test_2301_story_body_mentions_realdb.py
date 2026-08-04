"""story #2301(E-CONNECT, 오르테가 판정 2026-07-29, 스레드 7256d5cc) — story 본문(description)·
AC(acceptance_criteria)의 `#` 엔티티 토큰이 저장 시 `entity_references`로 실제로 걷히는지
실PG 검증. #2597(FE)이 삽입 UI만 열었고 BE 파서가 없던 갭(화면은 되는데 저장 안 됨)의 배선.

핵심 판정 AC들:
  AC1: story 전용 write 헬퍼가 0 — `insert_chat_mentions`/`reconcile_doc_mentions`를 병합한
    공용 코어(`reconcile_entity_references`)를 stories.py가 직접 호출(재구현 0, mention_
    parser.py에 story 전용 함수 추가 안 함 — 이 파일이 코드가 아니라 테스트라 grep으로
    직접 확인).
  AC2: 본문·AC는 서로 다른 source_field라 각각 독립적으로 reconcile — 같은 대상을 양쪽에
    걸면 두 행 다 남는다.
  AC3(이 판의 진짜 시험): 토큰을 지우면 참조가 없어지는 것 — 양성대조를 같은 응답(같은
    story)에: 안 지운 토큰의 참조는 남는 것. 둘 다 사라지면 "지운 것"이 아니라 "다 날린 것".
  AC4: 채팅 회귀 0 — 메시지는 불변이라 stale 삭제가 "안 도는" 것(기존 test_1993_mentions_
    realdb.py 전체 스위트가 별도로 이걸 실증 — 이 파일은 stories.py 신규 호출부만 스코프).
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
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

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


async def _make_story(session, org_id, project_id, title="Story", description="", acceptance_criteria=""):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        status="backlog", description=description, acceptance_criteria=acceptance_criteria,
    )
    session.add(story)
    await session.commit()
    return story


async def _make_target_doc(session, org_id, project_id, title="Target"):
    from app.models.doc import Doc
    doc = Doc(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, slug=f"doc-{uuid.uuid4().hex[:8]}")
    session.add(doc)
    await session.commit()
    return doc


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db, get_read_db

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
    # story #2451(§6 Phase3 A2 스윕): 이 헬퍼를 재사용하는 모든 파일(test_2328·test_2224_*·
    # test_2221·test_2269·test_2288·test_2355·test_2363 등)이 한 번에 커버되도록 소스
    # 헬퍼에서 get_read_db도 같이 건다 — A1에서 파일별 개별 패치 후 「더 있었다」 재발을
    # 겪은 교훈(카디르 QA)으로, 이번엔 공유 지점 하나를 고쳐 다운스트림 임포터 전체를 막는다.
    app.dependency_overrides[get_read_db] = _db
    app.dependency_overrides[get_current_user] = _auth


def _token(title: str, target_type: str, target_id: uuid.UUID) -> str:
    return f"[{title}](entity:{target_type}:{target_id})"


async def _refs(session, org_id, story_id, source_field=None):
    from sqlalchemy import select
    from app.models.reference import Reference
    conds = [Reference.org_id == org_id, Reference.source_type == "story", Reference.source_id == story_id]
    if source_field is not None:
        conds.append(Reference.source_field == source_field)
    rows = (await session.execute(select(Reference).where(*conds))).scalars().all()
    return rows


# ─── AC1: story 전용 write 헬퍼 0(코드 스캔) ─────────────────────────────────


def test_no_story_specific_mention_write_helper_added():
    """mention_parser.py에 "story" 전용 write 함수가 새로 생기지 않았는지 직접 확인 —
    공용 코어(`reconcile_entity_references`)만 있고, `insert_story_mentions`류 이름이
    없어야 AC1이 선다.

    ⛔story #2269(C-11) 후속 정정: 이름에 "story"가 들어가는 것과 "write 헬퍼"인 것은
    다른 축이다 — #2269가 추가한 `resolve_bare_number_story_refs`는 이름에 "story"가
    있지만 **SELECT만 하고** 그 결과를 그대로 이 파일 위 reconcile_entity_references(공용
    코어)에 넘기는 resolver다(`extract_chat_entity_mentions`와 같은 역할 — 다만 uuid가
    본문에 이미 있지 않아 번호→uuid 해소에 DB 조회가 필요할 뿐). 원래 이름 substring
    체크는 "이 가드가 실제로 막으려는 것"(story 전용 INSERT/write 로직 재구현)의 근사치일
    뿐이었다 — 근사치가 깨지자(정당한 resolver가 이름에 걸림) 근사치가 아니라 진짜 불변식
    (write API를 직접 호출하는가)으로 판정을 옮긴다."""
    import inspect

    import app.services.mention_parser as mp

    story_named_funcs = [
        name for name in dir(mp)
        if callable(getattr(mp, name)) and not name.startswith("_") and "story" in name.lower()
    ]
    _WRITE_SIGNALS = ("pg_insert(", "sa_delete(", "Reference(", "session.add(", "db.add(")
    write_helpers = [
        name for name in story_named_funcs
        if any(sig in inspect.getsource(getattr(mp, name)) for sig in _WRITE_SIGNALS)
    ]
    assert write_helpers == [], f"story 전용 write 헬퍼가 생겼다: {write_helpers}"


# ─── AC2: description·AC 각각 독립 reconcile ─────────────────────────────────


async def test_patch_description_creates_reference():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_target_doc(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": _token("Target", "doc", target.id)},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                refs = await _refs(s, org.id, story.id, source_field="description")
                assert len(refs) == 1
                assert refs[0].target_type == "doc"
                assert refs[0].target_id == target.id
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_same_target_in_description_and_ac_both_persist_independently():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_target_doc(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={
                    "description": _token("Target", "doc", target.id),
                    "acceptance_criteria": _token("Target", "doc", target.id),
                },
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                desc_refs = await _refs(s, org.id, story.id, source_field="description")
                ac_refs = await _refs(s, org.id, story.id, source_field="acceptance_criteria")
                assert len(desc_refs) == 1
                assert len(ac_refs) == 1
                assert desc_refs[0].id != ac_refs[0].id
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC3(진짜 시험): 토큰 삭제 → 참조 삭제, 양성대조는 남음 ──────────────────


async def test_removing_token_deletes_reference_kept_token_survives_positive_control():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target_removed = await _make_target_doc(s, org.id, project.id, title="Removed")
            target_kept = await _make_target_doc(s, org.id, project.id, title="Kept")
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            # ⛔선행 상태는 직접 ORM으로 심지 않는다(그러면 reconcile 경로를 안 거쳐 seed 자체가
            # 거짓 전제가 된다) — 실 PATCH로 두 토큰을 먼저 «진짜로» 저장시킨다.
            seed = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={
                    "description": (
                        _token("Removed", "doc", target_removed.id) + " and "
                        + _token("Kept", "doc", target_kept.id)
                    ),
                },
            )
            assert seed.status_code == 200, seed.text
            async with Session() as s:
                before = await _refs(s, org.id, story.id, source_field="description")
                assert {r.target_id for r in before} == {target_removed.id, target_kept.id}

            # "Removed" 토큰만 지우고 "Kept" 토큰은 그대로 둔 채 재저장.
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": _token("Kept", "doc", target_kept.id) + " only now"},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                after = await _refs(s, org.id, story.id, source_field="description")
                after_targets = {r.target_id for r in after}
                # ⭐양성대조 — 지운 것만 없어지고 안 지운 것은 남는다(둘 다 사라지면 "다 날린 것").
                assert target_removed.id not in after_targets, "지운 토큰의 참조가 안 지워졌다"
                assert target_kept.id in after_targets, "안 지운 토큰의 참조까지 같이 날아갔다"
                assert after_targets == {target_kept.id}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_clearing_description_entirely_removes_all_its_references():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_target_doc(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            seed = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": _token("Target", "doc", target.id)},
            )
            assert seed.status_code == 200, seed.text
            async with Session() as s:
                before = await _refs(s, org.id, story.id, source_field="description")
                assert len(before) == 1

            resp = await client.patch(f"/api/v2/stories/{story.id}", json={"description": "no tokens here"})
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                after = await _refs(s, org.id, story.id, source_field="description")
                assert after == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 미변경 필드는 재조정 안 함(불필요한 diff-쿼리 skip) ─────────────────────


async def test_patching_unrelated_field_does_not_touch_description_references():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            target = await _make_target_doc(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            seed = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": _token("Target", "doc", target.id)},
            )
            assert seed.status_code == 200, seed.text

            resp = await client.patch(f"/api/v2/stories/{story.id}", json={"priority": "high"})
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                refs = await _refs(s, org.id, story.id, source_field="description")
                assert len(refs) == 1
                assert refs[0].target_id == target.id
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 미등록 target_type dropped(채팅과 동일 관례) ────────────────────────────


async def test_unregistered_target_type_in_description_is_dropped_not_stored():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story.id}",
                json={"description": _token("X", "goal", uuid.uuid4())},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s:
                refs = await _refs(s, org.id, story.id, source_field="description")
                assert refs == [], "registry 밖 target_type이 저장됐다(조용히 통과 금지 위반)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
