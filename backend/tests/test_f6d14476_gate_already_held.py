"""story f6d14476(Phase0 결함, 디디 발견·페드루 PO 결정 ② 확定 2026-09-03) — external_publish
게이트 슬롯은 work_item_id 단위인데, 같은 work_item에 언어변형 초안이 둘이면 뒤에 상신한
초안이 앞선 초안의(이미 pending/approved인) 게이트를 조용히 덮어써 파괴하던 결함의 회귀가드.

PO 결정 ②(게이트 슬롯 granularity는 work_item 그대로 유지) 구현:
- AC1: work_item의 게이트가 이미 다른 초안(neutral_facts.draft_id)에 의해 pending/approved로
  쥐여 있으면, 다른 초안의 상신은 409 SITE_POST_GATE_ALREADY_HELD로 막는다. 쥐고 있는 게이트
  (상태·봉인·resolver)는 절대 안 건드린다.
- AC2: 같은 초안의 재상신(같은 draft_id)은 그대로 허용(idempotent).
- 발견 즉시 수정(같은 함수 영역) — 편집-훅(_reseal_gate_on_new_version)도 work_item_id만으로
  게이트를 찾아 동일한 corruption class를 submit() 없이도 열 수 있었다(다른 초안을 편집만
  해도 승인된 게이트가 조용히 reopen/재봉인됨) — 여기도 같은 draft_id 소유권 가드로 막는다.

실 HTTP 왕복(엔드포인트 그대로 호출) — test_3367_site_post_submit_gate_seal.py의 하네스
(_setup_org_scoped_app·_client_for) 그대로 재사용."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Gate Held Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, *, role="member"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_story(session, org_id, project_id, *, title="언어변형 글"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id):
    from app.dependencies.auth import AuthContext, get_current_user

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
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _draft_body(*, work_item_id, slug, lang, title, body_md="# 제목\n\n본문입니다."):
    return {
        "work_item_id": str(work_item_id), "slug": slug, "lang": lang, "title": title,
        "summary": "요약입니다", "tags": ["ai"], "body_md": body_md,
        "media_manifest": [],
    }


async def _approve_gate_directly(session, gate_id):
    from datetime import datetime, timezone
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


async def _get_gate(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    return (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()


@pytest.mark.anyio
async def test_second_draft_submit_blocked_409_first_gate_untouched():
    """AC1·AC4 — draft A submit→approve, draft B(같은 work_item, 다른 slug/lang) submit →
    409 SITE_POST_GATE_ALREADY_HELD·A 게이트(status·seal·resolver) 완전 불변."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_a = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, slug="a-blog", lang="ko", title="A(한글)"),
            )
            assert r_a.status_code == 201, r_a.text
            draft_a_id = r_a.json()["draft_id"]

            r_submit_a = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_a_id}/submit", json={},
            )
            assert r_submit_a.status_code == 200, r_submit_a.text
            gate_a_id = uuid.UUID(r_submit_a.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_a_id)
            gate_a_before = await _get_gate(s, gate_a_id)
            before_status = gate_a_before.status
            before_seal = gate_a_before.sealed_content_sha256
            before_resolver = gate_a_before.resolver_id
            before_resolved_at = gate_a_before.resolved_at

        async with _client_for(app) as client:
            r_b = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, slug="b-blog", lang="en", title="B(English)"),
            )
            assert r_b.status_code == 201, r_b.text
            draft_b_id = r_b.json()["draft_id"]

            r_submit_b = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_b_id}/submit", json={},
            )
        assert r_submit_b.status_code == 409, r_submit_b.text
        detail = r_submit_b.json()["error"]
        assert detail["code"] == "SITE_POST_GATE_ALREADY_HELD"
        assert detail["holding_draft_id"] == draft_a_id
        assert detail["holding_lang"] == "ko"
        assert detail["holding_slug"] == "a-blog"

        async with Session() as s:
            gate_a_after = await _get_gate(s, gate_a_id)
            assert gate_a_after.status == before_status == "approved"
            assert gate_a_after.sealed_content_sha256 == before_seal
            assert gate_a_after.resolver_id == before_resolver
            assert gate_a_after.resolved_at == before_resolved_at
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_same_draft_resubmit_after_approval_still_allowed():
    """AC2 — 같은 초안의 재상신(같은 draft_id, 같은 내용)은 다른 초안이 아니므로 계속 200
    (idempotent 조기 반환), 승인 상태도 그대로 유지된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_a = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, slug="a-blog", lang="ko", title="A(한글)"),
            )
            draft_a_id = r_a.json()["draft_id"]
            r_submit_a = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_a_id}/submit", json={},
            )
            gate_a_id = uuid.UUID(r_submit_a.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_a_id)

        async with _client_for(app) as client:
            r_resubmit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_a_id}/submit", json={},
            )
        assert r_resubmit.status_code == 200, r_resubmit.text
        assert r_resubmit.json()["gate_id"] == str(gate_a_id)

        async with Session() as s:
            gate_a_after = await _get_gate(s, gate_a_id)
            assert gate_a_after.status == "approved"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_editing_non_holding_draft_does_not_reopen_or_reseal_other_gate():
    """발견 즉시 수정 회귀가드 — draft A 승인 뒤, draft B(다른 초안)를 '편집'만 해도(제출 없이)
    _reseal_gate_on_new_version 훅이 work_item_id만으로 A의 게이트를 찾아 조용히 reopen/
    재봉인하던 경로를 막는다. B 편집 후 A 게이트는 완전 불변이어야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_a = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, slug="a-blog", lang="ko", title="A(한글)"),
            )
            draft_a_id = r_a.json()["draft_id"]
            r_submit_a = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_a_id}/submit", json={},
            )
            gate_a_id = uuid.UUID(r_submit_a.json()["gate_id"])

            r_b = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, slug="b-blog", lang="en", title="B(English)"),
            )
            draft_b_id = r_b.json()["draft_id"]

        async with Session() as s:
            await _approve_gate_directly(s, gate_a_id)
            gate_a_before = await _get_gate(s, gate_a_id)
            before_status = gate_a_before.status
            before_seal = gate_a_before.sealed_content_sha256
            before_version = gate_a_before.sealed_content_version

        async with _client_for(app) as client:
            r_edit_b = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(
                    work_item_id=story_id, slug="b-blog", lang="en", title="B(English) v2",
                    body_md="# 제목\n\n고친 본문.",
                ),
            )
        assert r_edit_b.status_code == 201, r_edit_b.text
        assert r_edit_b.json()["draft_id"] == draft_b_id

        async with Session() as s:
            gate_a_after = await _get_gate(s, gate_a_id)
            assert gate_a_after.status == before_status == "approved"
            assert gate_a_after.sealed_content_sha256 == before_seal
            assert gate_a_after.sealed_content_version == before_version
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
