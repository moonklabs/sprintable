"""story #2259 AC4(E-CONNECT, 2026-07-29) — 끊어진 참조(broken reference)가 실제로 어떻게
다뤄지는지 세 갈래로 증명한다(PO 요구, 라이브 시도가 403(「Story 삭제는 휴먼만」)으로
막혀 realdb 테스트로 방식을 고정):

  ㉠참조 «행»이 남는가/사라지는가 — target이 하드삭제돼도 CASCADE가 없어 행은 남는다.
  ㉡read 경로(`reference_core.list_references`)가 그것을 어떻게 보여주는가 — `still_exists`
    필드로 "존재하지 않는다"를 명시적으로 실어 보낸다(조용히 누락시키지 않는다).
  ㉢「끊어졌다」가 사용자에게 어떻게 보이는가 — ⛔정직한 답: **아직 아무 라이브 엔드포인트도
    `list_references`를 호출하지 않는다**(코드 grep으로 실증). 즉 ㉡의 신호는 서비스
    레이어에서 올바르게 계산되지만, 지금은 어떤 사용자에게도 도달하지 않는다 — 이 설계
    제약("조용히 사라지면 그건 거짓말이다")이 아직 지켜지지 않은 상태를 그대로 선언한다
    (기능을 새로 짓지 않고, 갭을 정확히 재서 적는 것이 이번 판의 스코프).
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── ㉢ 코드 스캔 — list_references의 라이브 호출부가 정말 0인지 ────────────────


def test_list_references_has_zero_live_router_callers():
    """⛔이 테스트가 RED가 되면(즉 어딘가 router가 list_references를 부르기 시작하면) 이
    파일의 ㉢ 선언(「아직 사용자에게 안 보인다」)을 다시 써야 한다는 신호다 — 그때는
    선언을 지우는 게 아니라 이 테스트와 함께 갱신한다."""
    routers_dir = Path(__file__).resolve().parents[1] / "app" / "routers"
    callers = []
    for py_file in sorted(routers_dir.glob("*.py")):
        text = py_file.read_text()
        if re.search(r"\blist_references\s*\(", text):
            callers.append(py_file.name)
    assert callers == [], (
        f"list_references가 이제 router에서 호출된다({callers}) — "
        "㉢ 선언(«아직 사용자에게 안 보인다»)이 낡았다. 이 테스트와 PR 본문을 같이 갱신할 것."
    )


# ─── ㉠㉡ realdb 왕복 — Story 하드삭제 시나리오(PO가 라이브에서 시도했던 그 경로) ───


async def _session_factory():
    import os
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    url = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
    if not url:
        pytest.skip("통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


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


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="backlog")
    session.add(story)
    await session.commit()
    return story


async def _make_doc(session, org_id, project_id, title="Doc"):
    from app.models.doc import Doc
    doc = Doc(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, slug=f"d-{uuid.uuid4().hex[:8]}")
    session.add(doc)
    await session.commit()
    return doc


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


@pytest.mark.anyio
async def test_reference_row_survives_hard_delete_of_target_story_no_cascade():
    """㉠ — Story를 실제 DELETE 엔드포인트(휴먼 caller, PO가 라이브에서 겪은 바로 그 경로)로
    하드삭제해도, 그 story를 target으로 가리키던 entity_references 행은 사라지지 않는다
    (target_id에 FK/CASCADE가 없다 — reference.py 모델 설계상 폴리모픽 대상은 FK를 안 씀)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="To Be Deleted")
            doc = await _make_doc(s, org.id, project.id)
            ref = await _make_reference(
                s, org.id, "doc", doc.id, "story", story.id, created_by=member_id,
            )
            ref_id = ref.id

        # 라이브에서 PO가 겪은 그 경로 그대로: 휴먼 caller로 DELETE /api/v2/stories/{id}.
        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/stories/{story.id}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        # story row 자체는 사라졌는지 확인(하드삭제였다는 전제 검증 — 아니면 이 테스트가
        # 애초에 무의미).
        async with Session() as s2:
            from sqlalchemy import select
            from app.models.pm import Story
            still_there = (
                await s2.execute(select(Story.id).where(Story.id == story.id))
            ).scalar_one_or_none()
            assert still_there is None, "story가 실제로는 하드삭제되지 않았다 — 전제가 틀렸다"

            # ㉠ 핵심 — Reference 행은 살아 있다(CASCADE 없음).
            from app.models.reference import Reference
            ref_row = (
                await s2.execute(select(Reference).where(Reference.id == ref_id))
            ).scalar_one_or_none()
            assert ref_row is not None, "Reference 행이 target 삭제로 같이 사라졌다 — CASCADE가 걸려 있다"
            assert ref_row.target_id == story.id
            assert ref_row.target_type == "story"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_references_marks_still_exists_false_for_broken_target_twin_comparison():
    """㉡ — `list_references`(reference_core.py, direction="outgoing")가 끊어진 참조를
    조용히 빼지 않고 `still_exists=False`로 명시한다. 양성대조로 같은 호출 안에 «여전히
    존재하는» target도 같이 넣어 계측기가 살아 있는 것을 함께 본다(0건만 보면 "다 끊어짐"과
    "계측기가 죽음"을 구별할 수 없다)."""
    from app.services.reference_core import list_references

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, _ = await _make_human_member(s, org.id, project.id)
            source_doc = await _make_doc(s, org.id, project.id, title="Source Doc")
            broken_target_story = await _make_story(s, org.id, project.id, title="Will Be Deleted")
            alive_target_story = await _make_story(s, org.id, project.id, title="Still Alive")

            await _make_reference(
                s, org.id, "doc", source_doc.id, "story", broken_target_story.id, created_by=member_id,
            )
            await _make_reference(
                s, org.id, "doc", source_doc.id, "story", alive_target_story.id, created_by=member_id,
            )

            # target 하나만 직접 하드삭제(라우터를 거치지 않고 세션에서 바로 — 이 테스트는
            # ㉡만 격리해서 보는 것이 목적, ㉠은 위 테스트가 이미 증명했다).
            from app.models.pm import Story
            await s.delete(await s.get(Story, broken_target_story.id))
            await s.commit()

            resolved = await list_references(
                s, org_id=org.id, entity_type="doc", entity_id=source_doc.id, direction="outgoing",
            )

            by_target = {r.target_id: r for r in resolved}
            assert by_target[broken_target_story.id].still_exists is False
            assert by_target[alive_target_story.id].still_exists is True
            # ⛔조용히 빠지지 않았다는 것 자체를 센다 — 두 참조 모두 응답에 남아 있다.
            assert len(resolved) == 2
    finally:
        await engine.dispose()
