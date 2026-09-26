"""story #4351 PR A — 채널 · 사이트 글 초안과 캠페인 안의 글 · 변형이 접근 권한 없는 프로젝트의 것을 싣지 않는다.

초안은 프로젝트 소속(work_item_id → Story.project_id) — 쓰기 가드 `_require_channel_post_draft_project_access`는 이미 그 축인데 읽기
라우트만 org 전체였다(한 리소스에 규칙이 둘). PO 판정(2026-09-26): 읽기도 같은 축. 제한된 caller는 접근 가능 프로젝트 것만 · 단건
(상세 · 버전 · 발행)은 404 · 총계(X-Total-Count)도 접근 가능분만 · 전체 접근(owner)은 옛 동작 그대로.
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import pytest

from tests.conftest import override_db_and_read
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_3437_content_ledger_projection import _seed_connection
from tests.test_e_security_sec_s8_g_cross_project_access_realdb import _REAL_DB_URL, _session_factory

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _channel_credential_key(monkeypatch):
    """연결 시드가 토큰을 암호화한다 — 테스트마다 새 키(test_3437 관례)."""
    from cryptography.fernet import Fernet

    from app.core import config as config_module

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@asynccontextmanager
async def _world():
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.user import User
    from app.services.channel_posts import create_channel_post_draft_version
    from app.services.site_posts import create_site_post_draft_version

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
            pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
            s.add_all([pa, pb])
            await s.commit()
            member_id, member_user = await _make_member(s, org.id, pa.id)
            owner_user = uuid.uuid4()
            s.add(User(id=owner_user, email=f"o-{owner_user.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user, role="owner"))
            stories = {}
            for key, proj in (("a", pa), ("b", pb)):
                st = Story(id=uuid.uuid4(), org_id=org.id, project_id=proj.id, title=f"story-{key}")
                s.add(st)
                stories[key] = st.id
            await s.commit()
            connection_id = await _seed_connection(s, org.id)
            channel_drafts, site_drafts = {}, {}
            for key, mark in (("a", "VISIBLE-A"), ("b", "SECRET-B")):
                version, _channel, _v = await create_channel_post_draft_version(
                    s, org_id=org.id, work_item_id=stories[key], connection_id=connection_id,
                    text=f"{mark}-channel-text", link_url=None, author_member_id=member_id, author_kind="human",
                )
                channel_drafts[key] = str(version.draft_id)
                site_version, _v2 = await create_site_post_draft_version(
                    s, org_id=org.id, work_item_id=stories[key], slug=f"slug-{key}-{uuid.uuid4().hex[:6]}", lang="ko",
                    title=f"{mark}-site-title", summary="s", tags=[], body_md="b", media_manifest=[],
                    author_member_id=member_id, author_kind="human",
                )
                site_drafts[key] = str(site_version.draft_id)
            await s.commit()
        yield Session, {
            "org": org.id, "pa": pa.id, "member_user": member_user, "owner_user": owner_user,
            "channel": channel_drafts, "site": site_drafts,
        }
    finally:
        await engine.dispose()


async def _get(Session, seeded, path, user):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.auth import get_verified_org_id
    from app.main import app

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(
            user_id=str(user), email="u@test",
            claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = lambda: seeded["org"]
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            return await c.get(path.format(org=seeded["org"], **{f"{k}_{x}": v for k, d in (("channel", seeded["channel"]), ("site", seeded["site"])) for x, v in d.items()}))
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("path,visible", [
    ("/api/v2/organizations/{org}/channel-posts/drafts", "VISIBLE-A-channel-text"),
    ("/api/v2/organizations/{org}/site-posts/drafts", "VISIBLE-A-site-title"),
])
async def test_draft_lists_show_only_accessible_projects(path, visible):
    async with _world() as (Session, seeded):
        member = await _get(Session, seeded, path, seeded["member_user"])
        assert member.status_code == 200, member.text[:300]
        assert visible in member.text and "SECRET-B" not in member.text
        if "x-total-count" in member.headers:
            assert member.headers["x-total-count"] == "1", "총계도 접근 가능분만(존재가 새지 않게)"
        owner = await _get(Session, seeded, path, seeded["owner_user"])
        assert "SECRET-B" in owner.text, "전체 접근은 옛 동작 그대로"


@pytest.mark.parametrize("path", [
    "/api/v2/organizations/{org}/channel-posts/drafts/{channel_b}",
    "/api/v2/organizations/{org}/channel-posts/drafts/{channel_b}/versions",
    "/api/v2/organizations/{org}/site-posts/drafts/{site_b}",
    "/api/v2/organizations/{org}/site-posts/drafts/{site_b}/versions",
])
async def test_single_inaccessible_draft_is_404(path):
    async with _world() as (Session, seeded):
        resp = await _get(Session, seeded, path, seeded["member_user"])
        assert resp.status_code == 404, resp.text[:300]
        assert "SECRET-B" not in resp.text
        own = await _get(Session, seeded, path.replace("_b}", "_a}"), seeded["member_user"])
        assert own.status_code == 200, own.text[:300]


async def test_site_post_publication_of_inaccessible_draft_is_404():
    """PO — 발행은 쓰기와 맞닿은 단건이라 테스트 하나: 접근 못 하는 프로젝트 초안의 발행 상태 = 404 · 자기 프로젝트 초안은 통과."""
    async with _world() as (Session, seeded):
        other = await _get(Session, seeded, "/api/v2/organizations/{org}/site-posts/drafts/{site_b}/publication", seeded["member_user"])
        assert other.status_code == 404, other.text[:300]
        own = await _get(Session, seeded, "/api/v2/organizations/{org}/site-posts/drafts/{site_a}/publication", seeded["member_user"])
        assert own.status_code != 404, own.text[:300]


async def test_reconcile_of_inaccessible_publication_writes_nothing(monkeypatch):
    """story #4351(쓰기 IDOR · PO) — 접근 못 하는 프로젝트의 채널 발행물 대조는 «없는 발행물»과 같은 응답(409 NOT_FOUND) · 대조 행 0.
    자기 프로젝트 발행물은 대조가 돈다(가짜 실측으로)."""
    from sqlalchemy import func, select

    import app.services.publication_reconciliation as recon_module
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.models.channel_publication_reconciliation import ChannelPublicationReconciliation

    live = {"impressions": 1, "reach": 1, "views": 1, "engagements": 1, "clicks": 1, "spend": 0, "conversions": 0}

    async def _fake_fetch(db, snapshot, **_kwargs):
        return {"raw": live, "values": live}

    monkeypatch.setattr(recon_module, "_fetch_for_snapshot", _fake_fetch)
    async with _world() as (Session, seeded):
        pubs = {}
        async with Session() as s:
            from app.models.channel_post_draft import ChannelPostDraft

            for key in ("a", "b"):
                draft = await s.get(ChannelPostDraft, uuid.UUID(seeded["channel"][key]))
                gate = Gate(
                    id=uuid.uuid4(), org_id=seeded["org"], work_item_id=draft.work_item_id, work_item_type="story",
                    gate_type="external_publish", status="approved", neutral_facts={},
                )
                s.add(gate)
                await s.flush()
                pub = ChannelPublication(
                    id=uuid.uuid4(), org_id=seeded["org"], gate_id=gate.id, version_id=uuid.uuid4(),
                    connection_id=draft.connection_id, channel="threads", status="published", external_id=f"m-{key}",
                )
                s.add(pub)
                pubs[key] = pub.id
            await s.commit()

        from httpx import ASGITransport, AsyncClient

        from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
        from app.main import app

        async def _db():
            async with Session() as s:
                yield s

        async def _auth():
            return AuthContext(
                user_id=str(seeded["member_user"]), email="u@test",
                claims={"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["pa"])}},
            )

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        app.dependency_overrides[get_verified_org_id] = lambda: seeded["org"]
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                other = await c.post(f"/api/v2/organizations/{seeded['org']}/publications/{pubs['b']}/reconcile")
                own = await c.post(f"/api/v2/organizations/{seeded['org']}/publications/{pubs['a']}/reconcile")
        finally:
            app.dependency_overrides.clear()
        assert other.status_code == 409 and "INSIGHT_PUBLICATION_NOT_FOUND" in other.text, other.text[:300]
        assert own.status_code == 201, own.text[:300]
        async with Session() as s:
            written = (await s.execute(
                select(func.count()).select_from(ChannelPublicationReconciliation)
                .where(ChannelPublicationReconciliation.publication_id == pubs["b"])
            )).scalar_one()
        assert written == 0, "접근 못 하는 프로젝트 발행물에 대조 행이 써졌다"
