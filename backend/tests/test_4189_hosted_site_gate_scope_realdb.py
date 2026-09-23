"""story #4189(E-RECIPE-2·P1) — 자사 블로그(hosted_site) 초안 게이트가 레시피 external_publish 게이트
(unscoped "")와 같은 행을 나눠 쓰다 덮어쓰던 결함. 실 PG(alembic heads, non-destructive).

AC1: 레시피 게이트가 있는 work item에 자사 블로그 초안을 제출해도 레시피 게이트 행의 neutral_facts·status가
     그대로이고, 초안 게이트는 "hosted_site" 슬롯의 별도 행이다.
AC2: 레시피 없는 자사 블로그 단독 흐름(초안 → 제출 → 승인 → 발행) 무회귀 · 레시피 승인 → 캐스케이드로
     자사 블로그 게이트 승인 → 발행(바뀐 슬롯을 발행 조회가 찾는지) · 기존 "" 행 이관 SQL.
"""
from __future__ import annotations

import importlib.util
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_RECIPE_FACTS = {"triggered_by_event": "preset.marketing.blog_article", "stage": "pending_approval"}


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


async def _seed(session) -> dict:
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.participation import ParticipationRole
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="approver", label="Approver", is_default=True)
    session.add(role)
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="작성 에이전트", is_active=True)
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member"))
    user = User(id=uuid.uuid4(), email=f"h-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="owner")
    session.add(om)
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="블로그 글")
    session.add(story)
    await session.commit()
    return {"org_id": org.id, "agent_id": agent.id, "human_id": user.id, "om_id": om.id,
            "story_id": story.id, "role_id": role.id}


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _as(app, Session, org_id, user_id):
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

    async def _auth():
        return AuthContext(user_id=str(user_id), email="c@test", claims={"app_metadata": {"org_id": str(org_id)}})

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _draft_body(story_id):
    return {"work_item_id": str(story_id), "slug": f"post-{uuid.uuid4().hex[:6]}", "lang": "ko", "title": "블로그 글",
            "summary": "요약", "tags": [], "body_md": "# 제목\n\n본문", "media_manifest": []}


async def _create_and_submit_hosted_draft(app, Session, seeded) -> tuple[dict, dict]:
    org_id = seeded["org_id"]
    body = _draft_body(seeded["story_id"])
    _as(app, Session, org_id, seeded["agent_id"])
    async with _client_for(app) as c:
        r_draft = await c.post(f"/api/v2/organizations/{org_id}/site-posts/drafts", json=body)
    assert r_draft.status_code == 201, r_draft.text
    _as(app, Session, org_id, seeded["human_id"])
    async with _client_for(app) as c:
        r_submit = await c.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{r_draft.json()['draft_id']}/submit", json={})
    assert r_submit.status_code == 200, r_submit.text
    return body, r_submit.json()


async def _recipe_gate(Session, seeded, *, approved: bool):
    from app.services.gate_service import create_gate, set_gate_status

    async with Session() as s:
        gate = await create_gate(
            s, seeded["org_id"], seeded["story_id"], "story", "external_publish",
            seeded["agent_id"], seeded["role_id"], neutral_facts=dict(_RECIPE_FACTS), notify=False,
        )
        if approved:
            set_gate_status(gate, "approved", now=datetime.now(timezone.utc))
            gate.resolver_id = seeded["om_id"]
            gate.resolved_at = datetime.now(timezone.utc)
        await s.commit()
        return gate.id


async def _gate(Session, gate_id):
    from sqlalchemy import select

    from app.models.gate import Gate

    async with Session() as s:
        return (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()


async def _publish(app, Session, seeded, body, *, gate_id=None):
    org_id = seeded["org_id"]
    payload = {k: body[k] for k in ("work_item_id", "slug", "lang", "title", "summary", "tags", "body_md")}
    if gate_id is not None:
        payload["gate_id"] = str(gate_id)
    _as(app, Session, org_id, seeded["human_id"])
    async with _client_for(app) as c:
        return await c.post(f"/api/v2/organizations/{org_id}/site-posts", json=payload)


async def test_hosted_draft_submit_leaves_recipe_gate_untouched():
    """AC1 — 뮤테이션: site_post_gate_scope_key가 None에 ""를 돌려주면 같은 행을 받아 이 테스트가 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        recipe_gate_id = await _recipe_gate(Session, seeded, approved=True)
        _, submit = await _create_and_submit_hosted_draft(app, Session, seeded)

        recipe = await _gate(Session, recipe_gate_id)
        draft_gate = await _gate(Session, uuid.UUID(submit["gate_id"]))
        assert recipe.status == "approved"
        assert recipe.scope_key == ""
        assert recipe.neutral_facts["triggered_by_event"] == _RECIPE_FACTS["triggered_by_event"]
        assert recipe.neutral_facts["stage"] == _RECIPE_FACTS["stage"]
        assert "draft_id" not in recipe.neutral_facts
        assert draft_gate.id != recipe.id
        assert draft_gate.scope_key == "hosted_site"
        assert draft_gate.status == "pending"
        assert draft_gate.neutral_facts["destination"] == "hosted_site"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_hosted_only_flow_submit_approve_publish_unchanged():
    """AC2 — 레시피 없는 자사 블로그 단독: gate_id 명시·생략 두 경로 모두 새 슬롯에서 승인 게이트를 찾는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        body, submit = await _create_and_submit_hosted_draft(app, Session, seeded)
        gate_id = uuid.UUID(submit["gate_id"])

        not_yet = await _publish(app, Session, seeded, body)
        assert not_yet.status_code != 201, "승인 전인데 발행됐다"

        from app.services.gate_service import set_gate_status
        from sqlalchemy import select
        from app.models.gate import Gate
        async with Session() as s:
            g = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            set_gate_status(g, "approved", now=datetime.now(timezone.utc))
            g.resolver_id = seeded["om_id"]
            g.resolved_at = datetime.now(timezone.utc)
            await s.commit()

        r_without_id = await _publish(app, Session, seeded, body)
        assert r_without_id.status_code == 201, r_without_id.text
        r_with_id = await _publish(app, Session, seeded, body, gate_id=gate_id)
        assert r_with_id.status_code == 201, r_with_id.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_publish_does_not_accept_recipe_gate_as_hosted_approval():
    """자사 블로그 발행 chokepoint는 레시피 unscoped 게이트를 대신 통과시키지 않는다(예전엔 같은 행이라 구분 불가)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        recipe_gate_id = await _recipe_gate(Session, seeded, approved=True)
        body, _ = await _create_and_submit_hosted_draft(app, Session, seeded)
        r = await _publish(app, Session, seeded, body, gate_id=recipe_gate_id)
        assert r.status_code != 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_recipe_approval_cascades_to_hosted_gate_and_publish_succeeds():
    """AC2 — 초안 먼저 제출 → 레시피 게이트 승인(transition_gate) → 훅B가 hosted_site 게이트를 승계 승인 →
    gate_id 없이 발행 성공. 예전(같은 행)에 되던 «레시피 승인 한 번으로 자사 블로그 발행»이 슬롯을 나눈 뒤에도 된다."""
    from app.main import app
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        recipe_gate_id = await _recipe_gate(Session, seeded, approved=False)
        body, submit = await _create_and_submit_hosted_draft(app, Session, seeded)

        async with Session() as s:
            await transition_gate(s, seeded["org_id"], recipe_gate_id, "approved", resolver_id=seeded["om_id"])
            await s.commit()

        hosted = await _gate(Session, uuid.UUID(submit["gate_id"]))
        assert hosted.status == "approved", hosted.resolution_note
        r = await _publish(app, Session, seeded, body)
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def _load_migration():
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0397_hosted_site_gate_scope_key.py"
    spec = importlib.util.spec_from_file_location("_mig_4189", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


async def test_migration_moves_only_legacy_hosted_rows():
    """기존 행 처리 — "" 슬롯의 자사 블로그 게이트(destination=hosted_site·draft_id)만 옮기고 레시피 게이트는 둔다."""
    from sqlalchemy import text

    from app.models.gate import Gate

    mig = _load_migration()
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            a = await _seed(s)
            b = await _seed(s)
        async with Session() as s:
            legacy = Gate(
                id=uuid.uuid4(), org_id=a["org_id"], work_item_id=a["story_id"], work_item_type="story",
                gate_type="external_publish", status="approved", scope_key="",
                neutral_facts={"destination": "hosted_site", "draft_id": str(uuid.uuid4())},
            )
            recipe = Gate(
                id=uuid.uuid4(), org_id=b["org_id"], work_item_id=b["story_id"], work_item_type="story",
                gate_type="external_publish", status="pending", scope_key="",
                neutral_facts=dict(_RECIPE_FACTS),
            )
            s.add_all([legacy, recipe])
            await s.commit()
            await s.execute(text(mig._MOVE), {"from_scope": "", "to_scope": "hosted_site"})
            await s.commit()
        assert (await _gate(Session, legacy.id)).scope_key == "hosted_site"
        assert (await _gate(Session, recipe.id)).scope_key == ""
        async with Session() as s:
            await s.execute(text(mig._MOVE), {"from_scope": "hosted_site", "to_scope": ""})
            await s.commit()
        assert (await _gate(Session, legacy.id)).scope_key == ""
    finally:
        await engine.dispose()
