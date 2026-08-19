"""story #2266(C-8, E-CONNECT) — `list_doc_backlinks` 일반화(target_type 허용목록) +
`GET /api/v2/stories/{id}/backlinks`(역방향, "이것을 가리키는 것들"). 실PG 검증.

PO 판정(2026-07-28) 3정정을 그대로 검증한다:
  ①target_type은 허용목록(BACKLINKS_ALLOWED_TARGET_TYPES={doc, story}) — 밖은 거절
  ②story TARGET 게이트(`_assert_story_project_access`)가 같은 PR에 선다 — 게이트 없이 여는
    PR은 이 스토리의 완료가 아니다(AC2 money test)
  ③구 AC4(참조 0건 전체 목록/기준선)는 #2277로 분리 — 이 파일은 다루지 않는다
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


# ─── Seeding helpers (test_1994_backlink_api_realdb.py와 동형 — 이 파일 자체 완결) ──


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
    """test_1994의 동명 helper와 동일 anchor 패턴(members + org_members + project_access
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


# ─── ①허용목록 — service-level guard ────────────────────────────────────────


@pytest.mark.anyio
async def test_list_entity_backlinks_rejects_unsupported_target_type():
    """게이트가 안 선 타입(epic 등)은 허용목록 밖 — UnsupportedBacklinkTargetTypeError."""
    from app.dependencies.auth import AuthContext
    from app.services.backlinks import (
        UnsupportedBacklinkTargetTypeError,
        list_entity_backlinks,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            auth = AuthContext(user_id=str(uuid.uuid4()), email="x@test", claims={})
            with pytest.raises(UnsupportedBacklinkTargetTypeError):
                await list_entity_backlinks(
                    s, org_id=org.id, target_type="epic", target_id=uuid.uuid4(),
                    auth=auth, limit=30, cursor=None,
                )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_backlinks_allowlist_contains_exactly_doc_and_story():
    """story #2721(2026-08-17)이 artifact를 추가 — 허용목록은 정확히 {doc, story, artifact}뿐
    (다음 판이 늘리기 전까지 고정, 함수명은 이력 보존을 위해 유지)."""
    from app.services.backlinks import BACKLINKS_ALLOWED_TARGET_TYPES
    assert BACKLINKS_ALLOWED_TARGET_TYPES == frozenset({"doc", "story", "artifact"})


def test_zero_ref_models_key_set_matches_allowlist():
    """story #2721 — backlinks.py 자기 주석("_ZERO_REF_MODELS의 키를 늘릴 땐 반드시
    BACKLINKS_ALLOWED_TARGET_TYPES도 같이 늘어야 한다")이 지금까지 코드로 강제된 적이 없었다
    (grep 확認 — 이 테스트가 최초). count_zero_referenced_entities()가 `_ZERO_REF_MODELS
    [target_type]`을 BACKLINKS_ALLOWED_TARGET_TYPES 전체에 대해 순회하므로, 두 집합이 어긋나면
    한쪽만 늘어도 조용히 넘어가는 게 아니라 **KeyError로 즉시 죽는다**(런타임 크래시 —
    다음 사람이 한쪽만 고치면 이 함수가 다음 cron 실행에서 바로 터진다) — 그 자리를 이 테스트가
    push 前에 잡는다."""
    from app.services.backlinks import _ZERO_REF_MODELS, BACKLINKS_ALLOWED_TARGET_TYPES
    assert set(_ZERO_REF_MODELS) == BACKLINKS_ALLOWED_TARGET_TYPES


# ─── ②story TARGET 게이트 — AC2 money test(권한 대조: 있음 vs 없음) ────────────


@pytest.mark.anyio
async def test_story_backlinks_404_for_nonexistent_story():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{uuid.uuid4()}/backlinks")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_story_backlinks_project_access_twin_comparison():
    """⭐AC2·AC5 핵심 — 양성대조(twin comparison, PO가 #2277에도 요구한 그 패턴): 같은
    story·같은 참조 데이터에 대해 project 접근이 «있는» caller는 200+데이터를 보고, 접근이
    «없는» caller는 404를 받는다(story #2322, 2026-07-29 — 예전엔 403이었으나 존재 비노출
    규율로 통일). 하나만 재면(0건만 확인) 권한 게이트가 실제로 도는지
    "없어서 0건"인지 "막혀서 0건"인지 구분이 안 된다 — 이 테스트가 그 둘을 가른다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "Story Project")
            other_project = await _make_project(s, org.id, "Other Project")
            member_with_access, user_with_access = await _make_human_member(s, org.id, project.id)
            member_without_access, user_without_access = await _make_human_member(s, org.id, other_project.id)

            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [member_with_access], member_with_access)
            msg = await _add_message(s, conv_id, member_with_access, f"보는 [Story](entity:story:{story.id})")
            await _make_reference(
                s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_with_access,
            )

        # (1) 접근 있는 caller — 200 + 데이터 보임
        await _setup_app_human(app, Session, user_with_access, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 1, body
            assert body["data"][0]["source_type"] == "chat_message"
            assert body["data"][0]["message"]["id"] == str(msg.id)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        # (2) 접근 없는 caller(다른 project) — story #2322(2026-07-29): 404로 통일(존재
        # 비노출 규율 — 예전엔 403이었다가 이 스토리에서 정정됨), 데이터 유출 0
        await _setup_app_human(app, Session, user_without_access, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_story_backlinks_gate_red_green_mutation_self_check():
    """⭐RED→GREEN 자체검증 — 라우터에서 `_assert_story_project_access` 호출을 사보타주하면
    위 twin comparison의 (2)가 403 대신 200으로 새는지(=게이트가 실제로 그 자리에서 막고
    있었는지) 직접 증명한다. `stories.py`를 임시로 패치해 게이트를 무력화 → RED 확인 → 원복."""
    import app.routers.stories as stories_module

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "Story Project")
            other_project = await _make_project(s, org.id, "Other Project")
            member_with_access, user_with_access = await _make_human_member(s, org.id, project.id)
            member_without_access, user_without_access = await _make_human_member(s, org.id, other_project.id)
            story = await _make_story(s, org.id, project.id, title="Target Story")

        from app.main import app

        original_gate = stories_module._assert_story_project_access

        async def _noop_gate(*args, **kwargs):
            return None

        stories_module._assert_story_project_access = _noop_gate
        try:
            await _setup_app_human(app, Session, user_without_access, org.id)
            client = _client_for(app)
            try:
                resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
                # 게이트 무력화 상태 — 권한 없는 caller인데도 200이 새는 것(RED, 사보타주 효과 실증)
                assert resp.status_code == 200, (
                    f"사보타주가 안 먹었다(게이트가 다른 경로로도 걸리는 중?) — {resp.status_code}: {resp.text}"
                )
            finally:
                await client.aclose()
                app.dependency_overrides.clear()
        finally:
            stories_module._assert_story_project_access = original_gate

        # 원복 후 GREEN 재확인 — 같은 caller가 다시 404(story #2322 통일).
        await _setup_app_human(app, Session, user_without_access, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ③「0건」 collection_scope meta(AC4) ────────────────────────────────────


@pytest.mark.anyio
async def test_story_backlinks_zero_result_still_carries_collection_scope():
    """참조 0건이어도 meta.collection_scope는 항상 나온다 — FE가 「출처 없음」이 아니라
    「관찰된 참조 0건(수집범위 X)」을 조립할 수 있는 근거 사실을 backend가 준다(AC4)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="No references")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["data"] == []
            scope = body["meta"]["collection_scope"]
            # story #2267(C-9): meeting·story가 창조-출처(relation='created_from') source로 추가됨.
            assert scope["source_types"] == ["chat_message", "doc", "meeting", "story"]
            assert scope["forms"] == "all"
            assert "pr_sid_text_convention" in scope["excludes"]
            assert "evidence_free_text_reference" in scope["excludes"]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_doc_backlinks_wrapper_still_returns_collection_scope_no_regression():
    """list_doc_backlinks(#1994 기존 호출부)도 같은 SSOT를 타므로 collection_scope가
    새로 붙는다 — 기존 41개 테스트가 이미 키-존재 단정이 아닌 개별 키만 검사해 회귀가 없음을
    실행으로 확인했지만(별도 스윕), 이 테스트는 그 사실 자체를 명시적으로 고정한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            from app.models.doc import Doc
            doc = Doc(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="D", slug=f"d-{uuid.uuid4().hex[:8]}", content="")
            s.add(doc)
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs/{doc.id}/backlinks")
            assert resp.status_code == 200, resp.text
            assert "collection_scope" in resp.json()["meta"]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ④성능 경계(AC7) — 단건 조회가 실제로 인덱스를 타는지 실측 ─────────────────


@pytest.mark.anyio
async def test_story_backlinks_query_uses_target_index():
    """⛔실측(AC7) — target_type+target_id 필터가 ix_entity_references_target을 Index
    (Only) Scan으로 타는지 EXPLAIN으로 직접 확인한다(코드 읽고 "될 것 같다"가 아니라)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            from sqlalchemy import text
            explain = await s.execute(text(
                "EXPLAIN SELECT * FROM entity_references "
                "WHERE org_id = :org_id AND target_type = 'story' AND target_id = :target_id "
                "ORDER BY created_at DESC, id DESC LIMIT 31"
            ), {"org_id": str(org.id), "target_id": str(uuid.uuid4())})
            plan_lines = [row[0] for row in explain.all()]
            plan_text = "\n".join(plan_lines)
            assert "ix_entity_references_target" in plan_text, (
                f"target index를 안 탄다 — planner가 다른 경로를 골랐다:\n{plan_text}"
            )
    finally:
        await engine.dispose()
