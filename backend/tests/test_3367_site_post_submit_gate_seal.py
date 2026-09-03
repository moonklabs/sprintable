"""story #3367(Phase0 S2·마케팅 운영 블루프린트 v3, 선생님 확定 2026-09-03) — external_publish
승인이 본 버전을 봉인하고 수정 즉시 재승인 상태로 바꾼다.

AC 매핑:
- AC1: 휴먼(또는 에이전트)이 상신하면 external_publish 게이트가 pending으로 서고 대상
  version·content_sha256·빈 media manifest hash·목적지(hosted_site)가 봉인된다.
- AC2: 에이전트도 상신은 허용(게이트 생성까지) — external_publish는 _ALWAYS_MANUAL_GATE_TYPES라
  create_gate가 호출자 무관 항상 pending을 강제한다(신규 코드 없음, 기존 가드 그대로).
- AC4·AC5: 승인 뒤 새 버전이 생기면(휴먼 수정) 그 버전 생성과 같은 트랜잭션 안에서 게이트가
  원자적으로 pending+reapproval_required=True로 되돌아간다. 봉인 값(sealed_content_*)은
  이 시점에 안 바뀐다 — 다음 명시 submit()이 재봉인할 때까지 "예전 승인 대상"으로 남는다.
- AC6: 봉인된 해시와 지금 공개하려는 내용의 해시가 다르면 공개 서비스는 409
  SITE_POST_REAPPROVAL_REQUIRED — 기존 공개 본문은 그대로 유지된다.
- 봉인 값 불변: 재상신해도 내용이 같으면(같은 버전) 게이트·봉인 값이 그대로 재사용된다(멱등).
- S1 후속(페드루 PO 2026-09-03 05:33Z): 목록 GET에 origin_author_kind(버전 1의 author_kind).
- neutral_facts에 draft_author_member_id(버전 1 작성자)·requested_by_member_id(상신자) —
  S5(통지 수신자)가 읽는 키 이름 그대로(recipe_gate_hooks._build_approval_neutral_facts 관례).

뮤테이션 2건(스토리 본문 + AC 인라인 명시):
① 공개 직전 hash 비교를 제거 — 승인 후 바뀐 본문이 공개돼 test_publish_after_edit_...가
   반드시 실패해야 한다.
② 봉인 값을 갱신하는 코드 경로를 편집-훅에 하나 더 열면(사실상 조용한 재봉인) 같은 테스트가
   반드시 실패해야 한다(더 이상 mismatch가 안 생겨 409를 못 본다).
둘 다 이 파일 맨 아래 주석에 자체검증 절차를 남긴다(실행은 세션 로그 참고, 커밋엔 포함 안 함)."""
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

    org = Organization(id=uuid.uuid4(), name="Submit Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_story(session, org_id, project_id, *, title="2호 글"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_metering_key(session, org_id):
    from app.services.pageview_counter import get_or_create_active_key
    return await get_or_create_active_key(session, org_id=org_id)


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


def _draft_body(*, work_item_id, slug="2ho-blog", lang="ko", title="2호 글"):
    return {
        "work_item_id": str(work_item_id), "slug": slug, "lang": lang, "title": title,
        "summary": "요약입니다", "tags": ["ai"], "body_md": "# 제목\n\n본문입니다.",
        "media_manifest": [],
    }


async def _approve_gate_directly(session, gate_id):
    """휴먼 결재 UI 왕복(gates.py) 없이 승인 상태만 만든다 — 이 테스트의 관심사는 site_posts.py
    쪽 상태(sealed_content_*·reapproval_required·409)지 gates.py의 승인 authz가 아니다
    (그건 test_rc1_body_trust_actor.py·test_3365_external_publish_gate_human_only.py 관할)."""
    from datetime import datetime, timezone
    from app.models.gate import Gate

    from sqlalchemy import select
    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


@pytest.mark.anyio
async def test_submit_seals_pending_gate_with_target_version():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
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
        content_sha256 = r_draft.json()["body_sha256"]

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit.status_code == 200, r_submit.text
        payload = r_submit.json()
        assert payload["version_id"] == version_id
        assert payload["content_sha256"] == content_sha256
        assert payload["status"] == "pending"

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == uuid.UUID(payload["gate_id"])))).scalar_one()
        assert gate.status == "pending"
        assert gate.gate_type == "external_publish"
        assert gate.work_item_id == story_id
        assert gate.sealed_content_version == 1
        assert gate.sealed_content_sha256 == content_sha256
        assert gate.sealed_content_body == "# 제목\n\n본문입니다."
        assert gate.neutral_facts["destination"] == "hosted_site"
        assert gate.neutral_facts["draft_author_member_id"] == str(agent_id)
        assert gate.neutral_facts["requested_by_member_id"] == str(human_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_can_submit_but_gate_stays_pending_not_approved():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit.status_code == 200, r_submit.text
        assert r_submit.json()["status"] == "pending", "에이전트 상신인데 approved/auto_passed로 생성됐다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_same_content_is_idempotent():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        assert r1.json()["gate_id"] == r2.json()["gate_id"], "같은 내용 재상신인데 다른 게이트가 생겼다"
        assert r1.json()["content_sha256"] == r2.json()["content_sha256"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_after_approval_atomically_reopens_gate_to_pending():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        gate_id = uuid.UUID(r_submit.json()["gate_id"])
        sealed_before = r_submit.json()["content_sha256"]

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        # 승인 뒤 휴먼이 본문을 고친다 — 새 버전 생성과 같은 트랜잭션에서 게이트가 되돌아가야 한다.
        async with _client_for(app) as client:
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, title="2호 글(승인 후 수정)"),
            )
        assert r_edit.status_code == 201, r_edit.text
        assert r_edit.json()["version"] == 2

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        assert gate.status == "pending", "승인 후 수정인데 게이트가 approved로 남아있다(AC4 회귀)"
        assert gate.reapproval_required is True
        assert gate.resolver_id is None
        assert gate.sealed_content_sha256 == sealed_before, "봉인 값이 편집 훅에서 조용히 갱신됐다(불변 위반)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_with_content_diverged_from_sealed_hash_returns_409_and_keeps_old_public_body():
    """AC6의 실제 갭 — 기존 POST /site-posts는 임의 body(title/slug/body_md 등)를 그대로
    받는다(초안/버전 시스템과 무관하게 호출 가능, S1 이전부터 있던 계약). 게이트가 approved인
    동안 그 body만 다른 내용으로 바꿔 다시 호출하면(초안은 안 건드림 — AC4 훅이 아예 안 탄다),
    승인된 해시와 달라 서버가 막아야 한다는 것이 이 스토리의 핵심 실사고("승인된 같은 게이트로
    달라진 본문도 upsert한다") — AC4(초안 편집 시 재-pending)와는 별개 경로다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        # 최초 발행 — 승인된 그 내용 그대로.
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_publish1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts",
                json={
                    "work_item_id": str(story_id), "gate_id": str(gate_id),
                    "title": "2호 글", "slug": "2ho-blog", "lang": "ko",
                    "summary": "요약입니다", "tags": ["ai"], "body_md": "# 제목\n\n본문입니다.",
                },
            )
        assert r_publish1.status_code == 201, r_publish1.text

        # 초안은 안 건드리고, 같은(여전히 approved인) 게이트로 다른 본문을 직접 공개 시도.
        async with _client_for(app) as client:
            r_publish2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts",
                json={
                    "work_item_id": str(story_id), "gate_id": str(gate_id),
                    "title": "2호 글", "slug": "2ho-blog", "lang": "ko",
                    "summary": "요약입니다", "tags": ["ai"], "body_md": "# 제목\n\n승인 안 받은 본문입니다.",
                },
            )
        assert r_publish2.status_code == 409, r_publish2.text
        assert r_publish2.json()["error"]["code"] == "SITE_POST_REAPPROVAL_REQUIRED", r_publish2.text

        async with Session() as s:
            from app.models.site_post import SitePost
            from sqlalchemy import select
            row = (await s.execute(
                select(SitePost).where(SitePost.org_id == org_id, SitePost.slug == "2ho-blog")
            )).scalar_one()
        assert row.body_md == "# 제목\n\n본문입니다.", "409 거부인데 기존 공개 본문이 바뀌었다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_unknown_draft_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{uuid.uuid4()}/submit", json={},
            )
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_submit_unknown_version_id_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit",
                json={"version_id": str(uuid.uuid4())},
            )
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_drafts_origin_author_kind_distinguishes_agent_origin_human_latest():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, title="에이전트 원안"),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, title="휴먼 개정판"),
            )
            r_list = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
        assert r_list.status_code == 200, r_list.text
        item = r_list.json()[0]
        assert item["origin_author_kind"] == "agent"
        assert item["latest_author_kind"] == "human"
        assert item["current_version"] == 2
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
