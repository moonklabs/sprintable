"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③a) — 블로그 목적지
축(`site_post_drafts.connection_id`)·목적지 봉인(`gate.sealed_destination_connection_id`)·
`get_blog_destination_module` 디스패치.

캐리포워드 3갈래(생략/명시null/값)는 3437 campaign_id의 페드루 리뷰 B1 처방과 동형 —
같은 함정을 이번엔 처음부터 피해 짰다(발견 즉시 수정 습관). 목적지 봉인은 sealed_
scheduled_at(#3414)·sealed_media_sha256(620beefc)과 동형 축 — 승인 후 변경=재승인."""
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
def _stub_wordpress_blog_adapter(monkeypatch):
    """조각③b(wordpress 실 모듈)가 아직 없다 — 이 파일의 테스트가 필요로 하는 건
    "hosted_site가 아닌, 실재하는 blog kind 채널"뿐이라 test_5b27b32f_sandbox_channel.py
    선례(monkeypatch.setitem(CHANNEL_ADAPTERS, ...))와 동형으로 임시 등재한다(신규
    실 어댑터 코드 0 — 이 스텁은 B1 kind 검사 통과 여부만 재는 픽스처다)."""
    import app.services.channel_adapters as adapters_mod

    stub = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="", refresh_mode="manual",
        credential_kind="pasted_secret", display_name="WordPress(스텁)", kind="blog",
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "wordpress", stub)


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

    org = Organization(id=uuid.uuid4(), name="Destination Axis Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="담롱"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="2호 글"):
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


async def _seed_connection(session, org_id, *, channel="wordpress", account_id=None, token="plain-access-token"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="pasted_secret", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential(token),
    )
    session.add(conn)
    await session.commit()
    return conn.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
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
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _draft_body(*, work_item_id, slug="2ho-blog", body_md="본문 v1", connection_id=None, explicit_none=False):
    body = {
        "work_item_id": str(work_item_id), "slug": slug, "lang": "ko", "title": "2호 글",
        "summary": "요약입니다", "tags": ["ai"], "body_md": body_md, "media_manifest": [],
    }
    if connection_id is not None:
        body["connection_id"] = str(connection_id)
    elif explicit_none:
        body["connection_id"] = None
    return body


async def _approve_gate_directly(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


# --- 캐리포워드 3갈래 ---------------------------------------------------------------


@pytest.mark.anyio
async def test_connection_id_omitted_on_edit_carries_forward():
    """생략 — 기존 값(wordpress connection) 유지. 뮤테이션 대상: 캐리포워드 센티널을
    지우면(생략=None 취급) 이 assert가 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="v1", connection_id=connection_id),
            )
            assert r1.status_code == 201, r1.text
            draft_id = r1.json()["draft_id"]

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="v2(connection_id 미포함)"),
            )
            assert r2.status_code == 201, r2.text

        async with Session() as s:
            from app.models.site_post_draft import SitePostDraft
            from sqlalchemy import select
            draft = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == uuid.UUID(draft_id))
            )).scalar_one()
            assert draft.connection_id == connection_id, "connection_id 생략 편집이 기존 목적지를 지웠다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_id_explicit_null_resets_to_hosted_site():
    """명시 null — hosted_site(None)로 해제."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="v1", connection_id=connection_id),
            )
            draft_id = r1.json()["draft_id"]

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="v2", explicit_none=True),
            )
            assert r2.status_code == 201, r2.text

        async with Session() as s:
            from app.models.site_post_draft import SitePostDraft
            from sqlalchemy import select
            draft = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == uuid.UUID(draft_id))
            )).scalar_one()
            assert draft.connection_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_id_new_draft_defaults_to_hosted_site():
    """신규 draft(connection_id 생략) — hosted_site(None)가 기본값."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            assert r.status_code == 201, r.text
            draft_id = r.json()["draft_id"]

        async with Session() as s:
            from app.models.site_post_draft import SitePostDraft
            from sqlalchemy import select
            draft = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == uuid.UUID(draft_id))
            )).scalar_one()
            assert draft.connection_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_id_cross_org_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, _ = await _seed_org(s)
            agent_a = await _seed_agent(s, org_a, project_a)
            story_a = await _seed_story(s, org_a, project_a)
            connection_in_org_b = await _seed_connection(s, org_b)

        _setup_org_scoped_app(app, Session, org_a, user_id=agent_a, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_a}/site-posts/drafts",
                json=_draft_body(work_item_id=story_a, connection_id=connection_in_org_b),
            )
            assert r.status_code == 422, r.text
            assert r.json()["error"]["code"] == "SITE_POST_CONNECTION_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_id_social_channel_rejected_422():
    """페드루 리뷰 B1(2026-09-04) — Threads(social) 연결을 블로그 목적지로 지정하면
    초안 생성 시점에 즉시 거부한다(fail-closed) — 안 그러면 상신·봉인·승인까지
    조용히 통과하고 발행(미배선)에서야 걸린다. 뮤테이션 대상: kind 검사를 지우면
    이 assert가 RED(201로 성공)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            threads_connection_id = await _seed_connection(s, org_id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=threads_connection_id),
            )
            assert r.status_code == 422, r.text
            assert r.json()["error"]["code"] == "SITE_POST_DESTINATION_KIND_MISMATCH"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- 목적지 봉인(승인 후 변경=재승인) ------------------------------------------------


@pytest.mark.anyio
async def test_destination_change_after_approval_reopens_gate_for_reapproval():
    """story #3478 후속(카디르 REQUEST_CHANGES BLOCKER 1, 페드루 실측 2026-09-05로
    불변식 갱신) — 승인 뒤 connection_id만 바꿔도(본문 그대로) 옛 목적지 게이트는
    **voided**로 끝난다(최초 처방이던 pending+reapproval_required는 그 자체가 새
    구멍이었다 — 결재자가 그 pending을 "정상 승인"해 버리면 옛 목적지용 승인으로
    새 목적지에 발행되는 경로가 열린다, BLOCKER 1 참고). sealed_content_*는 안
    건드린다(옛 승인 기록 보존 — voided라도 "무엇이 승인됐었나"는 지우지 않는다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 그대로"),
            )
            draft_id = r1.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 그대로", connection_id=connection_id),
            )
            assert r2.status_code == 201, r2.text

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "voided"
            assert gate.sealed_destination_connection_id is None, "승인된 옛 봉인이 훼손됐다(재봉인은 submit() 재호출 몫)"
            assert gate.resolution_note, "voided 사유가 안 남았다(사람이 결재함에서 볼 근거)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_destination_only_change_reseals_and_is_not_noop():
    """story #3478 후속(카디르 REQUEST_CHANGES 경유 페드루 실측, 2026-09-05로 불변식
    갱신) — content는 동일해도 destination이 바뀌면 그 자체가 새 scope_key라 재상신은
    옛 게이트를 재사용하는 no-op이 아니라 **새 게이트**를 연다(옛 게이트는 그 목적지
    에서 손 뗀 채 pending으로 남는다 — approved였다면 위 테스트처럼 reapproval_
    required로 되돌아가지만, 여기선 애초에 approve 자체를 안 해 이미 pending이라
    무변화가 곧 정답). 옛 gate_id를 그대로 재사용해 재봉인되길 기대하던 옛 pin은
    #3478의 scope_key 축(같은 work_item·다른 목적지=다른 게이트) 자체와 모순이라
    폐기 — 새 불변식(새 게이트 생성·그 게이트가 새 목적지로 봉인·옛 게이트 불변)으로
    교체한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 동일"),
            )
            draft_id = r1.json()["draft_id"]
            r_submit1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit1.status_code == 200, r_submit1.text
            old_gate_id = uuid.UUID(r_submit1.json()["gate_id"])

            # content 그대로, connection_id만 값으로 지정(hosted_site→wordpress).
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 동일", connection_id=connection_id),
            )
            assert r2.status_code == 201, r2.text

            r_submit2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit2.status_code == 200, r_submit2.text
            new_gate_id = uuid.UUID(r_submit2.json()["gate_id"])
            assert new_gate_id != old_gate_id, (
                "destination만 바뀐 재상신이 옛 게이트를 그대로 재사용했다 — no-op으로 흡수된 것"
            )

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select

            new_gate = (await s.execute(select(Gate).where(Gate.id == new_gate_id))).scalar_one()
            assert new_gate.status == "pending"
            assert new_gate.sealed_destination_connection_id == connection_id, (
                "새 목적지 게이트가 그 목적지로 안 봉인됐다"
            )

            old_gate = (await s.execute(select(Gate).where(Gate.id == old_gate_id))).scalar_one()
            assert old_gate.status == "voided", "옛(hosted_site) 게이트가 destination 변경으로 voided 처리되지 않았다"
            assert old_gate.sealed_destination_connection_id is None, "옛 게이트가 새 목적지로 잘못 봉인됐다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_destination_change_voided_gate_cannot_be_approved_into_wrong_publish():
    """story #3478 후속(카디르 REQUEST_CHANGES ①, 페드루 실측 2026-09-05 재현 그대로) —
    B가 W로 상신(G_W pending, 승인 안 함) → 본문 그대로 connection만 H로 바꾼 뒤 상신
    (G_H pending) → 그 뒤 결재자가 G_W를 승인하려 하면 이미 voided라 illegal transition
    (ValueError, 게이트 라우터에선 409 gate_already_resolved에 대응)으로 막힌다 — W용
    승인으로 H에 발행되는 경로 자체가 구조적으로 안 열린다.

    뮤테이션 자가검증(실제 방법 — PR 본문과 동일하게 정정) — `_reseal_gate_on_new_
    version`의 void 분기(`if old_scope_key is not None and ...:`)를 `if False and ...`
    로 임시 비활성화하고 이 파일 전체를 재실행 : 이 테스트를 포함해 3건이 RED로
    재현됨을 직접 확인한 뒤 원본으로 복원했다(별도의 인라인 복제 로직은 쓰지 않았다)."""
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_w = await _seed_connection(s, org_id, account_id="w-site")
            connection_h = await _seed_connection(s, org_id, account_id="h-site")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 그대로", connection_id=connection_w),
            )
            draft_id = r1.json()["draft_id"]
            r_submit_w = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit_w.status_code == 200, r_submit_w.text
            gate_w_id = uuid.UUID(r_submit_w.json()["gate_id"])
            # 승인 안 함 — 재현 조건 그대로(pending인 채 destination 변경).

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 그대로", connection_id=connection_h),
            )
            assert r2.status_code == 201, r2.text
            r_submit_h = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit_h.status_code == 200, r_submit_h.text

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select

            gate_w = (await s.execute(select(Gate).where(Gate.id == gate_w_id))).scalar_one()
            assert gate_w.status == "voided", "G_W가 destination 변경으로 voided되지 않았다"

            with pytest.raises(ValueError, match="불법 전이"):
                await transition_gate(s, org_id, gate_w_id, "approved", resolver_id=uuid.uuid4())
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_scope_mismatch_defense_blocks_command_creation_and_worker_publish():
    """story #3478 후속(카디르 REQUEST_CHANGES ②, 페드루 실측 2026-09-05) — BLOCKER 1
    (void 정리)이 정상 동작해도, 어떤 경로로든 gate.scope_key(승인된 목적지)와 draft의
    **현재** connection_id가 어긋난 상태가 생기면(이 테스트처럼 억지로 그 조합을 만들어
    격리 재현) 두 방어선이 각각 막는다: ① 승인 훅(`_maybe_create_scheduled_publication_
    command`)이 명령을 안 만들고 note만 남긴다 ② 워커(`publish_site_post_external_
    command`)가 설령 명령이 생겼더라도 adapter 호출 直前에 `EXTERNAL_PUBLISH_APPROVAL_
    REQUIRED`로 막는다(연결 조회·adapter 코드에 아예 안 닿는다)."""
    import uuid as uuid_mod

    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.models.site_post_draft import SitePostDraft
    from app.models.site_post_version import SitePostVersion
    from app.services.gate_service import _maybe_create_scheduled_publication_command
    from app.services.site_posts import SitePostExternalPublishError, publish_site_post_external_command
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            connection_w = await _seed_connection(s, org_id, account_id="mismatch-w")
            connection_h = await _seed_connection(s, org_id, account_id="mismatch-h")

            draft = SitePostDraft(
                id=uuid_mod.uuid4(), org_id=org_id, work_item_id=story_id, slug="mismatch-post",
                connection_id=connection_h,  # draft의 현재 목적지 = H
            )
            s.add(draft)
            await s.flush()
            version = SitePostVersion(
                id=uuid_mod.uuid4(), draft_id=draft.id, version=1, title="제목", lang="ko",
                summary="요약", tags=[], body_md="본문",
                body_sha256="a" * 64, author_member_id=uuid_mod.uuid4(), author_kind="agent",
            )
            s.add(version)
            await s.flush()
            # 억지 조합 — scope_key(승인된 목적지) = W, draft의 현재 목적지 = H.
            gate = Gate(
                id=uuid_mod.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="external_publish", scope_key=str(connection_w), status="approved",
                requires_human=True, sealed_content_sha256=version.body_sha256,
                neutral_facts={"destination": "wordpress", "draft_id": str(draft.id)},
            )
            s.add(gate)
            await s.commit()
            gate_id, version_id = gate.id, version.id

        # ① 승인 훅 — 명령 0건·note 기록.
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            await _maybe_create_scheduled_publication_command(s, gate, resolver_id=uuid_mod.uuid4())
            await s.commit()
        async with Session() as s:
            commands = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalars().all()
            assert commands == [], "scope_key 불일치인데도 publication_command가 만들어졌다"
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.resolution_note, "불일치 사유가 안 남았다"

        # ② 워커 — 명령이 (다른 경로로) 이미 있었다고 가정하고 직접 호출, adapter 호출 前 차단.
        fake_command = PublicationCommand(
            id=uuid_mod.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_h,
            approved_version=version_id, operation="publish", content_kind="site_post",
        )
        async with Session() as s:
            with pytest.raises(SitePostExternalPublishError) as exc_info:
                await publish_site_post_external_command(s, fake_command)
            assert exc_info.value.error_code == "EXTERNAL_PUBLISH_APPROVAL_REQUIRED"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_destination_change_only_touches_gate_held_by_this_draft():
    """story #3478 후속(카디르 REQUEST_CHANGES REQUIRED 3, 페드루 실측 2026-09-05) —
    옛 scope 게이트를 건드릴 조건은 `resolve_gate_holder_draft_id(...) is None`("막는
    홀더 없음")이 아니라 「이 draft가 쥔 게이트」(neutral_facts.draft_id == 이 draft)
    여야 한다. `resolve_gate_holder_draft_id`는 "자기 자신"뿐 아니라 "발행이 회수/
    미배포라 더는 살아있지 않음"(`_gate_publication_is_live`=False)일 때도 None을
    반환한다(story #3478 決定③) — 다른 draft A가 쥔 approved 게이트가 이 상태면,
    A가 진짜로 쥐고 있는데도 "홀더 없음"으로 보여 옛(구현) 체크는 B의 destination
    변경만으로 A의 게이트를 건드린다. 이 테스트는 그 정확한 함정(A의 게이트에 실패한
    ChannelPublication을 하나 남겨 "안 살아있음"을 만든다)을 재현해 `_reseal_gate_
    on_new_version`을 직접 호출·이 축만 격리해서 잰다."""
    import uuid as uuid_mod

    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.models.site_post_draft import SitePostDraft
    from app.models.site_post_version import SitePostVersion
    from app.services.site_posts import _reseal_gate_on_new_version
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            connection_shared = await _seed_connection(s, org_id, account_id="shared-old-scope")
            connection_new = await _seed_connection(s, org_id, account_id="b-new-dest")

            draft_a = SitePostDraft(
                id=uuid_mod.uuid4(), org_id=org_id, work_item_id=story_id, slug="draft-a",
                connection_id=connection_shared,
            )
            draft_b = SitePostDraft(
                id=uuid_mod.uuid4(), org_id=org_id, work_item_id=story_id, slug="draft-b",
                connection_id=connection_new,  # B는 이미 새 목적지로 갱신된 뒤라고 가정.
            )
            s.add_all([draft_a, draft_b])
            await s.flush()

            # A가 «옛 scope»(shared)를 실제로 쥔 approved 게이트(neutral_facts.draft_id=A).
            gate_a = Gate(
                id=uuid_mod.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="external_publish", scope_key=str(connection_shared), status="approved",
                requires_human=True, neutral_facts={"draft_id": str(draft_a.id)},
            )
            s.add(gate_a)
            await s.flush()
            # A의 발행이 실패해 「살아있지 않다」— _gate_publication_is_live(gate_a.id)를
            # False로 만드는 유일한 방법(story #3478 決定③, resolve_gate_holder_draft_id
            # docstring 참고). A가 진짜로 쥐고 있는데도 옛 체크는 이걸 "홀더 없음"으로 읽는다.
            s.add(ChannelPublication(
                id=uuid_mod.uuid4(), org_id=org_id, gate_id=gate_a.id, version_id=uuid_mod.uuid4(),
                connection_id=connection_shared, channel="wordpress", status="failed",
            ))

            b_version = SitePostVersion(
                id=uuid_mod.uuid4(), draft_id=draft_b.id, version=2, title="제목", lang="ko",
                summary="요약", tags=[], body_md="본문 v2",
                body_sha256="b" * 64, author_member_id=uuid_mod.uuid4(), author_kind="agent",
            )
            s.add(b_version)
            await s.commit()
            gate_a_id = gate_a.id

        async with Session() as s:
            draft_b_row = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == draft_b.id)
            )).scalar_one()
            version_row = (await s.execute(
                select(SitePostVersion).where(SitePostVersion.id == b_version.id)
            )).scalar_one()
            # B가 old_connection_id=shared(A의 scope와 동일한 옛 값)에서 new=connection_new로
            # 바뀌었다고 가정하고 훅을 직접 호출 — REQUIRED 3의 정확한 대상 시나리오.
            await _reseal_gate_on_new_version(
                s, org_id=org_id, work_item_id=story_id, version=version_row, draft=draft_b_row,
                old_connection_id=connection_shared,
            )
            await s.commit()

        async with Session() as s:
            gate_a_after = (await s.execute(select(Gate).where(Gate.id == gate_a_id))).scalar_one()
            assert gate_a_after.status == "approved", "B의 destination 변경이 A가 쥔 게이트를 건드렸다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_destination_round_trip_revives_voided_gate_row():
    """story #3478 후속(페드루 REQUIRED, 2026-09-05) — 「돌아오는 길」 계약. W→H로
    바꾸면(위 테스트들) 옛 W 게이트가 voided된다 — 그 뒤 다시 H→W로 바꿔 재상신하면
    **같은 게이트 행(id 불변)이 되살아나야** 한다(새 행을 새로 만들지 않는다).

    이 계약은 다른 모듈의 암묵 전제 위에 서 있다 — `find_gate_slot_with_pr_fallback`
    가 status 필터 없이 조회하고, `create_gate()`가 rejected가 아니면 그 행을 그대로
    반환하며, `submit_site_post_draft()`의 "status != pending"이면 되돌리는 분기가
    pending 복귀+재봉인+`reapproval_required=False`까지 처리한다는 전제. 이 셋 중
    하나라도 나중에 "voided도 걸러내자"며 status 필터를 넣으면 이 되살아나는 경로가
    조용히 깨진다 — 이 테스트가 그 자리를 지키는 가드."""
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_w = await _seed_connection(s, org_id, account_id="roundtrip-w")
            connection_h = await _seed_connection(s, org_id, account_id="roundtrip-h")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 v1", connection_id=connection_w),
            )
            draft_id = r1.json()["draft_id"]
            r_submit_w1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit_w1.status_code == 200, r_submit_w1.text
            gate_w_id = uuid.UUID(r_submit_w1.json()["gate_id"])

            # W → H (옛 W 게이트가 voided된다 — 위 테스트들과 동일 경로).
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 v2", connection_id=connection_h),
            )
            assert r2.status_code == 201, r2.text
            r_submit_h = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit_h.status_code == 200, r_submit_h.text

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate_w_voided = (await s.execute(select(Gate).where(Gate.id == gate_w_id))).scalar_one()
            assert gate_w_voided.status == "voided", "그라운딩 전제(W→H가 W를 voided)가 깨졌다"

        # H → W (돌아오는 길) — 본문도 바꿔서 재봉인이 최신 버전을 실제로 반영하는지까지 잰다.
        async with _client_for(app) as client:
            r3 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 v3(돌아온 뒤)", connection_id=connection_w),
            )
            assert r3.status_code == 201, r3.text
            r_submit_w2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit_w2.status_code == 200, r_submit_w2.text
            revived_gate_id = uuid.UUID(r_submit_w2.json()["gate_id"])

        assert revived_gate_id == gate_w_id, "돌아오는 길이 새 게이트 행을 만들었다 — 같은 행 재사용 계약이 깨진 것"

        async with Session() as s:
            from app.models.gate import Gate
            from app.models.site_post_version import SitePostVersion
            from sqlalchemy import select

            revived = (await s.execute(select(Gate).where(Gate.id == revived_gate_id))).scalar_one()
            assert revived.status == "pending"
            assert revived.sealed_destination_connection_id == connection_w
            assert revived.reapproval_required is False
            latest_version = (await s.execute(
                select(SitePostVersion)
                .where(SitePostVersion.draft_id == draft_id)
                .order_by(SitePostVersion.version.desc())
                .limit(1)
            )).scalar_one()
            assert revived.sealed_content_sha256 == latest_version.body_sha256, "재봉인이 최신 버전을 안 반영했다"

            approved = await transition_gate(s, org_id, revived_gate_id, "approved", resolver_id=uuid.uuid4())
            await s.commit()
            assert approved.status == "approved", "되살아난 게이트가 정상 승인 전이를 못 탔다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- get_blog_destination_module 디스패치 -------------------------------------------


def test_get_blog_destination_module_none_returns_hosted_site():
    from app.services import hosted_site_publish
    from app.services.blog_destinations import get_blog_destination_module

    assert get_blog_destination_module(connection_id=None) is hosted_site_publish


def test_get_blog_destination_module_wordpress_returns_wordpress_publish():
    """조각③b — wordpress_publish.py 배선."""
    from app.services import wordpress_publish
    from app.services.blog_destinations import get_blog_destination_module

    assert (
        get_blog_destination_module(connection_id=uuid.uuid4(), channel="wordpress")
        is wordpress_publish
    )


def test_get_blog_destination_module_webhook_returns_webhook_publish():
    """조각④ — webhook_publish.py 배선(webhook도 wordpress와 나란히 실 구현체가 됐다)."""
    from app.services import webhook_publish
    from app.services.blog_destinations import get_blog_destination_module

    assert (
        get_blog_destination_module(connection_id=uuid.uuid4(), channel="webhook")
        is webhook_publish
    )


def test_get_blog_destination_module_unknown_channel_not_implemented_yet():
    """wordpress·webhook 둘 다 아닌(아직 존재하지 않는) 목적지는 여전히 fail-closed —
    뮤테이션 대상: 이 가드를 지우면 존재하지 않는 목적지가 조용히 어떤 모듈로든
    (예: hosted_site) 떨어질 수 있다."""
    from app.services.blog_destinations import (
        BlogDestinationNotImplementedError,
        get_blog_destination_module,
    )

    with pytest.raises(BlogDestinationNotImplementedError):
        get_blog_destination_module(connection_id=uuid.uuid4(), channel="some-future-channel")
