"""story #3437 후속(Phase1·마케팅운영, 유나 #3805 정적 판정·페드루 PO 確定 2026-09-04) —
campaign 「붙이기/해제」 전용 API. 유나 정적 판정: 캠페인 소속 변경이 기존 버전 POST
(`create_site_post_draft_version`)로 가면, 그 함수가 무조건 새 `SitePostVersion`을
만들고 `_reseal_gate_on_new_version`이 해시를 안 보고 승인된 게이트를 pending·
reapproval_required로 되돌린다 — 본문 무변인데도. campaign은 draft 축이지 버전 축이
아니라 그럴 이유가 없다.

`PATCH /organizations/{org_id}/site-posts/drafts/{draft_id}/campaign` —
새 버전 0·게이트 무접촉, `site_post_drafts.campaign_id`만 갱신."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


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

    org = Organization(id=uuid.uuid4(), name="3437 Campaign Patch Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, *, role="owner"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_story(session, org_id, project_id, *, title="블로그 원문"):
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _approve_gate_directly(session, gate_id, *, status="approved"):
    """test_3369_publish_site_post_from_draft.py::_approve_gate_directly와 동형 관례 —
    이 파일의 관심사는 campaign PATCH가 게이트를 건드리는지 여부지 gates.py의 승인
    authz가 아니다."""
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = status
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


async def _create_submit_approve_draft(client, session, *, org_id, story_id, slug):
    r = await client.post(
        f"/api/v2/organizations/{org_id}/site-posts/drafts",
        json={
            "work_item_id": str(story_id), "title": "제목", "slug": slug, "lang": "ko",
            "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
        },
    )
    assert r.status_code == 201, r.text
    draft_id = uuid.UUID(r.json()["draft_id"])

    r_submit = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={})
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    await _approve_gate_directly(session, gate_id, status="approved")
    return draft_id, gate_id


@pytest.mark.anyio
async def test_campaign_patch_attach_and_detach_does_not_create_version_or_reopen_approved_gate():
    """뮤테이션 대상: PATCH가 내부적으로 create_site_post_draft_version을 재사용하도록
    되돌리면 이 assert(버전 수·게이트 상태 불변) 둘 다 RED."""
    from app.main import app
    from app.models.gate import Gate
    from app.services.site_posts import list_site_post_draft_versions
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with Session() as s, _client_for(app) as client:
            r_campaign = await client.post(f"/api/v2/organizations/{org_id}/campaigns", json={"name": "붙이기 캠페인"})
            assert r_campaign.status_code == 201, r_campaign.text
            campaign_id = r_campaign.json()["id"]

            draft_id, gate_id = await _create_submit_approve_draft(
                client, s, org_id=org_id, story_id=story_id, slug="campaign-patch-post",
            )

            # 붙이기.
            r_attach = await client.patch(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/campaign",
                json={"campaign_id": campaign_id},
            )
            assert r_attach.status_code == 200, r_attach.text
            assert r_attach.json() == {
                "draft_id": str(draft_id), "campaign_id": campaign_id, "campaign_name": "붙이기 캠페인",
            }

            # 해제.
            r_detach = await client.patch(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/campaign",
                json={"campaign_id": None},
            )
            assert r_detach.status_code == 200, r_detach.text
            assert r_detach.json() == {"draft_id": str(draft_id), "campaign_id": None, "campaign_name": None}

        async with Session() as s:
            versions = await list_site_post_draft_versions(s, draft_id=draft_id)
            assert len(versions) == 1, "campaign PATCH가 새 버전을 만들었다"

            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "approved", "campaign PATCH가 승인된 게이트를 건드렸다"
            assert gate.reapproval_required is not True
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_version_post_reopens_approved_gate_positive_control():
    """양성대조 — 같은 draft에 버전 POST(본문 편집)를 하면 승인된 게이트가 실제로
    pending+reapproval_required=True로 되돌아간다(위 테스트의 "무변"이 테스트 설정
    결함으로 우연히 통과한 게 아님을 증명)."""
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with Session() as s, _client_for(app) as client:
            draft_id, gate_id = await _create_submit_approve_draft(
                client, s, org_id=org_id, story_id=story_id, slug="version-post-reopens",
            )

            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "제목", "slug": "version-post-reopens",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문 v2", "media_manifest": [],
                },
            )
            assert r_edit.status_code == 201, r_edit.text

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "pending"
            assert gate.reapproval_required is True
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_campaign_patch_cross_org_campaign_returns_422():
    """타 org의 campaign_id를 지정하면 422 CAMPAIGN_NOT_FOUND — 버전 POST 경로와
    같은 코드(존재 비노출 관례 동형)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, project_b = await _seed_org(s)
            human_a = await _seed_human(s, org_a)
            human_b = await _seed_human(s, org_b)
            story_a = await _seed_story(s, org_a, project_a)

        _setup_org_scoped_app(app, Session, org_b, user_id=human_b)
        async with _client_for(app) as client:
            r_campaign_b = await client.post(f"/api/v2/organizations/{org_b}/campaigns", json={"name": "B org 캠페인"})
            assert r_campaign_b.status_code == 201, r_campaign_b.text
            campaign_b_id = r_campaign_b.json()["id"]

        _setup_org_scoped_app(app, Session, org_a, user_id=human_a)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_a}/site-posts/drafts",
                json={
                    "work_item_id": str(story_a), "title": "제목", "slug": "cross-org-campaign-patch",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_patch = await client.patch(
                f"/api/v2/organizations/{org_a}/site-posts/drafts/{draft_id}/campaign",
                json={"campaign_id": campaign_b_id},
            )
        assert r_patch.status_code == 422, r_patch.text
        assert r_patch.json()["error"]["code"] == "CAMPAIGN_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
