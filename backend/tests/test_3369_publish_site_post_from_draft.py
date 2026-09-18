"""story #3369(Phase0 S3·마케팅 운영 플랫폼 v3, 페드루 PO 확定 2026-09-03) — 휴먼이 승인한
정확한 버전만 서버가 공개하고 URL과 platform 감사를 남긴다.

AC 매핑:
- AC1: 인증된 조직 휴먼이 승인된 최신 버전에 "발행"을 요청하면 서버가 봉인을 재검증한 뒤
  그 버전만 SitePost 공개 projection에 반영한다.
- AC2: 게이트가 없거나 pending/rejected/auto_passed면 403 EXTERNAL_PUBLISH_APPROVAL_
  REQUIRED — Phase 0 external_publish는 실제 휴먼 approved만 인정한다(auto_passed 포함
  거부 — 뮤테이션 대상).
- AC3: 고객 에이전트가 같은 endpoint를 호출하면 승인 유무와 무관하게 403 SITE_POST_
  PUBLISH_HUMAN_ONLY.
- AC4: 성공 응답은 공개 URL을 반환하고, 그 URL을 익명 GET하면 승인된 제목·본문과 200이
  관측된다. site 커넥터 org_config.site_base_url이 있으면 그것 기반, 없으면 공개 API URL.
- AC5: 성공 시 감사 로그에 공개 실행 actor=platform, gate_id·version_id·URL이 연결된다.
- AC6: 승인 후 수정된 버전의 발행 요청이 거부되면(SEAL_MISSING/REAPPROVAL_REQUIRED) 이전에
  공개된 URL과 본문은 그대로 유지된다.
- AC7: 재승인 후 다시 발행하면 같은 글의 공개 projection이 새 버전으로 갱신되고, 감사
  로그에는 두 발행의 version ID가 구분되어 남는다.

뮤테이션 1건(스토리 본문 명시) — auto_passed를 공개 가능 상태에 다시 포함한다:
publish_site_post_from_draft()의 `gate.status != "approved"`를
`gate.status not in ("approved", "auto_passed")`로 완화하면
test_auto_passed_gate_is_rejected_not_approved가 반드시 실패해야 한다(403 대신 200).
로컬 자체검증 절차는 파일 맨 아래 주석 — 실행은 세션 로그 참고, 커밋엔 미포함."""
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

    org = Organization(id=uuid.uuid4(), name="Publish Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _org_member_id(session, *, org_id, user_id) -> str:
    """story 194acb63(배포 11 실측) — published_by_member_id/created_by_member_id는 이제
    org_member.id다(auth.user_id/User.id가 아니다) — 시드 결과를 되짚어 읽는다."""
    from app.models.project import OrgMember
    from sqlalchemy import select

    member_id = (await session.execute(
        select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
    )).scalar_one()
    return str(member_id)


async def _seed_story(session, org_id, project_id, *, title="2호 글"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_default_role(session, org_id):
    """story #3367(PR#3733 리뷰 반영) — submit()이 기본 역할 없으면 명시 거부한다
    (SITE_POST_APPROVER_ROLE_MISSING). 이 파일의 submit() 경유 테스트는 모두 이 시드가
    필요하다(test_3367의 동일 헬퍼 그대로 재사용)."""
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


def _draft_body(*, work_item_id, slug="2ho-blog", lang="ko", title="2호 글", body_md="# 제목\n\n본문입니다."):
    return {
        "work_item_id": str(work_item_id), "slug": slug, "lang": lang, "title": title,
        "summary": "요약입니다", "tags": ["ai"], "body_md": body_md, "media_manifest": [],
    }


async def _approve_gate_directly(session, gate_id, *, status="approved"):
    """휴먼 결재 UI 왕복(gates.py) 없이 상태만 만든다(test_3367과 동형 관례) — 이 테스트의
    관심사는 site_posts.py의 재검증 로직이지 gates.py의 승인 authz가 아니다."""
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = status
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


async def _submit_and_approve(client, session, *, org_id, draft_id, status="approved"):
    """draft를 상신(봉인)하고 곧바로 승인 상태로 만든다 — 이 파일 전체가 재사용하는 조합."""
    r = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={})
    assert r.status_code == 200, r.text
    gate_id = uuid.UUID(r.json()["gate_id"])
    await _approve_gate_directly(session, gate_id, status=status)
    return gate_id


@pytest.mark.anyio
async def test_publish_success_matching_seal_creates_public_projection_and_platform_audit():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]
            version_id = r_draft.json()["version_id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client, Session() as s:
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 200, r_pub.text
        payload = r_pub.json()
        assert payload["version_id"] == version_id
        assert payload["url"]
        assert payload["published_at"]

        # AC4 — 공개 URL을 익명 GET하면 승인된 제목·본문과 200.
        from urllib.parse import urlparse
        parsed = urlparse(payload["url"])
        async with _client_for(app) as anon_client:
            r_public = await anon_client.get(parsed.path + "?" + parsed.query)
        assert r_public.status_code == 200, r_public.text
        assert r_public.json()["title"] == "2호 글"
        assert r_public.json()["body_md"] == "# 제목\n\n본문입니다."

        # AC5 — activity_log에 platform actor로 gate_id·version_id·url이 연결된다.
        async with Session() as s:
            from app.models.activity_log import ActivityLog
            from sqlalchemy import select
            logs = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.org_id == org_id, ActivityLog.action == "site_post_published",
                )
            )).scalars().all()
        assert len(logs) == 1
        log = logs[0]
        assert log.actor_type == "platform"
        assert log.actor_id is None
        assert log.context["gate_id"] == str(gate_id)
        assert log.context["version_id"] == version_id
        assert log.context["url"] == payload["url"]
        # story 194acb63(배포 11 실측) — published_by_member_id는 org_member.id다(User.id
        # 그대로면 그게 그 결함이다).
        async with Session() as s:
            expected_member_id = await _org_member_id(s, org_id=org_id, user_id=human_id)
        assert log.context["published_by_member_id"] == expected_member_id
        assert log.context["published_by_member_id"] != str(human_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_caller_gets_human_only_403_and_no_projection_written():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 403, r_pub.text
        assert r_pub.json()["error"]["code"] == "SITE_POST_PUBLISH_HUMAN_ONLY"

        async with Session() as s:
            from app.models.site_post import SitePost
            from sqlalchemy import select
            rows = (await s.execute(select(SitePost).where(SitePost.org_id == org_id))).scalars().all()
        assert rows == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_pending_gate_returns_approval_required_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit.json()["status"] == "pending"  # 승인 안 함 — 그대로 pending

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 403, r_pub.text
        assert r_pub.json()["error"]["code"] == "EXTERNAL_PUBLISH_APPROVAL_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_gate_at_all_returns_approval_required_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
        # submit()을 아예 안 함 — 게이트 자체가 없다.

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 403, r_pub.text
        assert r_pub.json()["error"]["code"] == "EXTERNAL_PUBLISH_APPROVAL_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_auto_passed_gate_is_rejected_not_approved():
    """AC2 핵심 — 뮤테이션 대상 라인이 지키는 바로 그 테스트. auto_passed는 이 endpoint에서
    성공으로 치지 않는다(레거시 publish_site_post는 허용하지만 이 draft 기반 endpoint는 더
    엄격하다 — 페드루 PO 명시)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id, status="auto_passed")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 403, r_pub.text
        assert r_pub.json()["error"]["code"] == "EXTERNAL_PUBLISH_APPROVAL_REQUIRED"

        async with Session() as s:
            from app.models.site_post import SitePost
            from sqlalchemy import select
            rows = (await s.execute(select(SitePost).where(SitePost.org_id == org_id))).scalars().all()
        assert rows == [], "auto_passed로 공개 projection이 만들어지면 안 된다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_seal_missing_returns_409_and_writes_nothing():
    """AC1·설계 정정(페드루 2026-09-03) — submit()을 거치지 않고 승인만 만들면
    sealed_content_sha256이 None이다. 레거시 publish_site_post는 이 경우 검사를 skip하지만,
    이 draft 기반 endpoint는 fail-closed로 409 SITE_POST_SEAL_MISSING을 낸다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        # submit()이 만든 게이트를 안 쓰고, 다른 경로로(예: 구식 마이그레이션 이전 게이트를
        # 흉내) sealed_content_*를 직접 지워 "봉인 없이 승인됨" 상태를 재현한다.
        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select, update
            await s.execute(
                update(Gate).where(Gate.id == gate_id).values(
                    status="approved", sealed_content_sha256=None, sealed_content_version=None,
                    sealed_content_body=None, resolver_id=uuid.uuid4(), resolved_at=datetime.now(timezone.utc),
                )
            )
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 409, r_pub.text
        assert r_pub.json()["error"]["code"] == "SITE_POST_SEAL_MISSING"

        async with Session() as s:
            from app.models.site_post import SitePost
            from sqlalchemy import select
            rows = (await s.execute(select(SitePost).where(SitePost.org_id == org_id))).scalars().all()
        assert rows == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_hash_mismatch_defense_in_depth_returns_409_reapproval_required():
    """AC6 방어망 — 정상 경로로는 승인 후 편집이 게이트를 pending으로 되돌려(_reopen_
    approved_gate_after_edit) 이 분기가 도달 불가능하다(페드루 PO 확인 2026-09-03). 그래도
    "approved인데 해시가 다른" 행이 다른 경로로 생기는 경우를 막는 방어망이 실제로 작동하는지
    직접 그 상태를 만들어 확인한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            gate_id = await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        # 방어망 재현 — approved 유지한 채 봉인 해시만 강제로 다른 값으로 바꾼다(정상 경로로는
        # 절대 안 생기는 조합, 위 파일독 주석 그대로).
        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import update
            await s.execute(update(Gate).where(Gate.id == gate_id).values(sealed_content_sha256="다른-해시"))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 409, r_pub.text
        assert r_pub.json()["error"]["code"] == "SITE_POST_REAPPROVAL_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_rejected_publish_keeps_previously_published_body_unchanged():
    """AC6 — 최초 발행 성공 후, 편집(v2)이 게이트를 pending으로 되돌린 상태에서 재상신 없이
    발행을 재시도하면 403(승인 필요)이고, 기존 공개본(v1)은 그대로 유지된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub1 = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub1.status_code == 200, r_pub1.text
        url_v1 = r_pub1.json()["url"]

        # 승인 후 편집 — 게이트가 자동으로 pending+reapproval_required=True로 되돌아간다.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_v2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="# 제목\n\n수정된 본문."),
            )
        assert r_v2.status_code == 201, r_v2.text

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub2 = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub2.status_code == 403, r_pub2.text
        assert r_pub2.json()["error"]["code"] == "EXTERNAL_PUBLISH_APPROVAL_REQUIRED"

        from urllib.parse import urlparse
        parsed = urlparse(url_v1)
        async with _client_for(app) as anon_client:
            r_public = await anon_client.get(parsed.path + "?" + parsed.query)
        assert r_public.status_code == 200
        assert r_public.json()["body_md"] == "# 제목\n\n본문입니다.", "거부된 재발행이 기존 공개본을 건드리면 안 된다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_republish_after_reapproval_updates_projection_and_logs_distinct_versions():
    """AC7 — 재승인 후 다시 발행하면 같은 글의 공개 projection이 새 버전으로 갱신되고,
    감사 로그에는 두 발행의 version ID가 구분되어 남는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            v1_id = r_draft.json()["version_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub1 = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub1.status_code == 200, r_pub1.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client, Session() as s:
            r_v2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="# 제목\n\n재승인된 본문."),
            )
            v2_id = r_v2.json()["version_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub2 = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub2.status_code == 200, r_pub2.text
        assert r_pub2.json()["version_id"] == v2_id
        assert r_pub2.json()["version_id"] != v1_id

        async with Session() as s:
            from app.models.site_post import SitePost
            from sqlalchemy import select
            posts = (await s.execute(select(SitePost).where(SitePost.org_id == org_id))).scalars().all()
        assert len(posts) == 1, "같은 (org,lang,slug) — 새 행이 아니라 upsert여야 한다"
        assert posts[0].body_md == "# 제목\n\n재승인된 본문."

        async with Session() as s:
            from app.models.activity_log import ActivityLog
            from sqlalchemy import select
            logs = (await s.execute(
                select(ActivityLog)
                .where(ActivityLog.org_id == org_id, ActivityLog.action == "site_post_published")
                .order_by(ActivityLog.created_at.asc())
            )).scalars().all()
        assert len(logs) == 2
        assert {log.context["version_id"] for log in logs} == {v1_id, v2_id}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_url_uses_configured_site_base_url_over_public_api_fallback():
    """AC4 — 조직 설정 site 커넥터의 org_config.site_base_url이 있으면 그것 기반
    (+/{lang}/blog/{slug}), 없으면(다른 모든 테스트) 공개 API URL로 fallback한다."""
    from app.main import app
    from app.services.connector_registry import set_org_connector_config, set_org_connector_schema

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            await set_org_connector_schema(
                s, org_id=org_id, connector_key="site", version="0.1.0", channel="stable",
                fields=[{"name": "site_base_url", "source": "org_config", "type": "string", "required": False}],
                requires_env=[], created_by=None,
            )
            await set_org_connector_config(
                s, org_id=org_id, connector_key="site", config={"site_base_url": "https://sprintable.ai"},
            )
            await s.commit()  # 두 함수 다 flush만 한다 — 세션 종료 전 커밋 안 하면 롤백된다

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 200, r_pub.text
        assert r_pub.json()["url"] == "https://sprintable.ai/ko/blog/2ho-blog"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 뮤테이션 자체검증(로컬, 커밋엔 미포함) ─────────────────────────────────────
# ① app/services/site_posts.py::publish_site_post_from_draft의
#    `if gate is None or gate.status != "approved":`를
#    `if gate is None or gate.status not in ("approved", "auto_passed"):`로 완화 →
#    test_auto_passed_gate_is_rejected_not_approved 실행 → 403 대신 200으로 RED 확인 →
#    원복 → GREEN 재확인.
