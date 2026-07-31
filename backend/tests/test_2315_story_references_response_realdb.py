"""story #2315(E-CONNECT, 오르테가 판정 2026-07-29, 스레드 7256d5cc) — story PATCH 응답이
`references{stored, dropped[]}` 사이드밴드를 싣는지 실PG 검증. #2599로 reconcile_entity_
references는 이미 돌지만(#2301) 그 결과를 응답이 말 안 하던 형제 비대칭(채팅엔 있고
story엔 없음)을 닫는다.

AC1: description·acceptance_criteria 두 호출의 dropped를 **평면 배열 하나**로 합친다 —
  채팅과 "한 글자도 다르지 않게"(오르테가 확정, 2026-07-29). 어느 필드에서 나온 것인지
  화면이 구분하지 않는다.
AC(정상 경로): 아무 토큰도 안 걸면(stored·dropped 둘 다 0) `references`가 null이다(채팅과
  동일 게이트 — #2294 관례). story는 response_model=StoryResponse라 다른 None 필드처럼
  키 자체는 유지된다(채팅의 raw dict와 달리 키를 통째로 뺄 수는 없음 — 아래 테스트 참조).
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


def _token(title: str, target_type: str, target_id) -> str:
    return f"[{title}](entity:{target_type}:{target_id})"


async def _setup(description="", acceptance_criteria=""):
    from app.main import app

    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
        story = await _make_story(s, org.id, project.id)
    await _setup_app_human(app, Session, caller_user_id, org.id)
    return app, engine, Session, org, project, story


# ─── AC1: dropped가 평면 배열 하나로 합쳐진다(source_field 구분 없음) ────────


async def test_dropped_from_description_and_acceptance_criteria_merge_into_one_flat_array():
    app, engine, Session, org, project, story = await _setup()
    client = _client_for(app)
    try:
        # 둘 다 registry 밖 target_type(goal) — 둘 다 dropped로 떨어진다.
        resp = await client.patch(
            f"/api/v2/stories/{story.id}",
            json={
                "description": _token("D", "goal", uuid.uuid4()),
                "acceptance_criteria": _token("AC", "goal", uuid.uuid4()),
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        refs = body["references"]
        assert refs["stored"] == 0
        # ⭐AC1 핵심 — 하나의 평면 배열(길이 2), source_field 같은 태그로 갈라놓지 않는다.
        assert len(refs["dropped"]) == 2
        assert all("source_field" not in d for d in refs["dropped"]), (
            f"응답이 필드를 구분한다 — 채팅과 다른 모양: {refs['dropped']}"
        )
        assert {d["reason"] for d in refs["dropped"]} == {"unregistered_target_type"}
    finally:
        await client.aclose()
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_stored_count_sums_across_both_fields():
    app, engine, Session, org, project, story = await _setup()
    async with Session() as s:
        target1 = await _make_target_doc(s, org.id, project.id, title="T1")
        target2 = await _make_target_doc(s, org.id, project.id, title="T2")
    client = _client_for(app)
    try:
        resp = await client.patch(
            f"/api/v2/stories/{story.id}",
            json={
                "description": _token("T1", "doc", target1.id),
                "acceptance_criteria": _token("T2", "doc", target2.id),
            },
        )
        assert resp.status_code == 200, resp.text
        refs = resp.json()["references"]
        assert refs["stored"] == 2
        assert refs["dropped"] == []
    finally:
        await client.aclose()
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 정상 경로: references가 null이다(채팅과 동일 게이트 — stored·dropped 둘 다 0이면 ───
# 세팅 자체를 스킵) — ⛔단 story는 response_model=StoryResponse라 필드 "키" 자체는 다른
# None 필드들(epic_id 등)과 동형으로 항상 존재한다(채팅은 raw dict라 키를 통째로 뺄 수
# 있었지만 여기선 그러면 스키마 전체의 None-필드 직렬화 정책을 건드리게 된다 — 범위 밖).
# FE `parseDroppedReferences`는 `!references`로 null을 걸러 빈 배열로 안전 폴백하므로
# 소비자 관점에서 결과는 동일하다.


async def test_no_mention_tokens_yields_null_references():
    app, engine, Session, org, project, story = await _setup()
    client = _client_for(app)
    try:
        resp = await client.patch(
            f"/api/v2/stories/{story.id}",
            json={"description": "no tokens here", "acceptance_criteria": "none here either"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "references" in body  # StoryResponse는 다른 None 필드와 동형으로 키를 유지한다.
        assert body["references"] is None, "정상 경로(dropped·stored 둘 다 0)에 값이 실렸다"
    finally:
        await client.aclose()
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_patching_unrelated_field_yields_null_references():
    """description/acceptance_criteria가 이번 PATCH에 없으면 reconcile 자체가 안 돈다 —
    references도 null이어야 한다(양성대조: title만 바뀌는 흔한 PATCH가 안 깨지는 것)."""
    app, engine, Session, org, project, story = await _setup()
    client = _client_for(app)
    try:
        resp = await client.patch(f"/api/v2/stories/{story.id}", json={"title": "New Title"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["references"] is None
    finally:
        await client.aclose()
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── malformed_token도 story PATCH 응답에 그대로 실린다(#2316 SSOT 재사용 확인) ─


async def test_malformed_token_reason_reused_as_is_no_new_enum():
    """오르테가 확정: dropped 사유 열거형은 채팅 쪽(#2294/#2612)이 SSOT — story가 새로
    만들지 않는다. reconcile_entity_references가 target_types 필터만 보고 malformed_token
    분류는 원래 story write-path가 find_malformed_chat_tokens를 안 타므로(#2316 AC5 범위
    밖 선언) 이 테스트는 「story가 chat과 같은 reason 문자열을 그대로 반환한다」만 검증한다
    — unregistered_target_type로 실측(story write-path에서 재현 가능한 유일한 사유)."""
    app, engine, Session, org, project, story = await _setup()
    client = _client_for(app)
    try:
        resp = await client.patch(
            f"/api/v2/stories/{story.id}",
            json={"description": _token("X", "goal", uuid.uuid4())},
        )
        assert resp.status_code == 200, resp.text
        reasons = {d["reason"] for d in resp.json()["references"]["dropped"]}
        assert reasons == {"unregistered_target_type"}
    finally:
        await client.aclose()
        app.dependency_overrides.clear()
        await engine.dispose()
