"""story #3471(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙
GET/PUT API + create/submit lint 배선(API·real DB). 순수 `lint_content()` 단위
테스트는 tests/test_3471_content_rules_lint_unit.py(destructive_schema 마커
불요·이 파일은 Base.metadata.create_all을 호출해 story 8236bbc3/#2643 가드가
마커를 강제한다)."""
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

    org = Organization(id=uuid.uuid4(), name="3471 Content Rules Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_story(session, org_id, project_id, *, title="콘텐츠"):
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


async def _seed_connection(session, org_id, *, channel="threads"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential("plain-access-token"),
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


# ══════════════════════════════════════════════════════════════════════════════
# API 테스트
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_owner_put_content_rules_reflected_in_get_and_version_plus_one():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_get0 = await client.get(f"/api/v2/organizations/{org_id}/content-rules")
            assert r_get0.status_code == 200, r_get0.text
            assert r_get0.json() == {"org_id": str(org_id), "rules": {}, "version": 0}

            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["테스트금칙"], "require_utm": True}, "expected_version": 0},
            )
            assert r_put.status_code == 200, r_put.text
            assert r_put.json()["version"] == 1

            r_get1 = await client.get(f"/api/v2/organizations/{org_id}/content-rules")
        assert r_get1.json()["rules"]["banned_terms"] == ["테스트금칙"]
        assert r_get1.json()["version"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ══════════════════════════════════════════════════════════════════════════════
# story #3501(doc a0da40c9 §20, 페드루 PO REQUIRED — PR#3856 리뷰) — 낙관적 잠금 CAS
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_put_missing_expected_version_returns_422():
    """AC1 — expected_version 누락은 pydantic이 자동 422(별도 처리 없이 그 자체가 답)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules", json={"rules": {"banned_terms": ["x"]}},
            )
        assert r.status_code == 422, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_put_version_mismatch_returns_409_with_current_version_and_updated_by():
    """AC1 — expected_version 불일치 409, current_version·updated_by(이름 해소) 동봉."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put1 = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["첫저장"]}, "expected_version": 0},
            )
            assert r_put1.status_code == 200, r_put1.text
            assert r_put1.json()["version"] == 1

            # 이미 version=1인데 expected_version=0(구식)으로 다시 저장 시도 — 409.
            r_put2 = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["충돌시도"]}, "expected_version": 0},
            )
        assert r_put2.status_code == 409, r_put2.text
        error = r_put2.json()["error"]
        assert error["code"] == "CONTENT_RULES_VERSION_CONFLICT"
        assert error["current_version"] == 1
        # updated_by_member_id 컬럼이 이미 있어(첫 PUT이 owner로 채웠다) 이름을 해소해
        # 싣는다 — §20-2 "서버가 «누가»를 주면 그때 이름을 쓴다".
        assert error["updated_by"] is not None
        assert error["updated_by"]["name"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_put_matching_version_via_cas_update_path_succeeds():
    """CAS UPDATE 경로(row가 이미 있음, expected_version>0) 자체를 직접 때린다 —
    INSERT 경로(expected_version=0)와 별개 분기라 따로 확認할 값어치가 있다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put1 = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["v1"]}, "expected_version": 0},
            )
            assert r_put1.json()["version"] == 1

            r_put2 = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["v2"]}, "expected_version": 1},
            )
        assert r_put2.status_code == 200, r_put2.text
        assert r_put2.json()["version"] == 2
        assert r_put2.json()["rules"]["banned_terms"] == ["v2"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_put_service_layer_cas_two_calls_same_expected_version_only_one_succeeds():
    """페드루 PO REQUIRED(2026-09-05, PR#3856 리뷰) 핵심 — "읽기→비교→쓰기" 3단계가
    원자가 아니면 같은 version을 든 두 호출이 «둘 다» 비교를 통과해 last-write-wins가
    동시 경로에 남는다. 서비스 함수를 같은 expected_version으로 두 번 연달아 불러
    (순서만 정해지면 참이 되는 성질 — 진짜 스레드 동시성이 없어도 CAS의 정확성은
    "이미 버전이 옮겨간 뒤의 두 번째 쓰기가 막히는가"로 검증된다) 하나만 성공하고
    나머지는 ContentRulesVersionConflictError를 받는지 직접 확認한다.

    ⚠️뮤테이션 확認 완료(2026-09-05, 로컬 homebrew postgresql@16 — docker 데몬은 여전히
    못 띄웠으나 이 realdb 스위트 자체는 실제로 돌렸다) — `put_org_content_rules`의 CAS
    UPDATE에서 `OrgContentRule.version == expected_version` 절을 지우면(org_id만 남기면)
    이 테스트가 `DID NOT RAISE`로 RED로 뒤집히는 것을 직접 확認하고 원복했다."""
    from app.services.content_rules import ContentRulesVersionConflictError, put_org_content_rules

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        async with Session() as s1, Session() as s2:
            row1 = await put_org_content_rules(
                s1, org_id=org_id, rules={"banned_terms": ["첫탭"]}, updated_by_member_id=owner_id, expected_version=0,
            )
            assert row1.version == 1

            # 두 세션 모두 "지금 서버는 version=1"이라고 믿는 상태(같은 expected_version)
            # 에서 각자 저장을 시도한다 — 세션1이 먼저 커밋해 실제로 version=2가 된다.
            row2 = await put_org_content_rules(
                s1, org_id=org_id, rules={"banned_terms": ["세션1_승리"]}, updated_by_member_id=owner_id, expected_version=1,
            )
            assert row2.version == 2

            # 세션2는 아직 자신이 "version=1"이라고 믿은 채(구식) 같은 expected_version=1로
            # 시도 — CAS WHERE가 실제 저장된 version=2와 안 맞아 rowcount=0 → 409 동형 예외.
            with pytest.raises(ContentRulesVersionConflictError) as exc_info:
                await put_org_content_rules(
                    s2, org_id=org_id, rules={"banned_terms": ["세션2_패배"]}, updated_by_member_id=owner_id, expected_version=1,
                )
            assert exc_info.value.current_version == 2
    finally:
        # 서비스 함수를 직접 부르는 테스트라 FastAPI app 자체가 없다(app.dependency_overrides
        # 정리는 HTTP 왕복 테스트 전용 — 이 테스트엔 해당 없음).
        await engine.dispose()


@pytest.mark.anyio
async def test_put_string_banned_terms_returns_422_not_char_by_char():
    """페드루 PO 리뷰 보정(2026-09-05, PR#3825) — banned_terms에 문자열을 그대로
    보내면(리스트가 아니라) 예전엔 글자 단위(s·p·a·m)로 쪼개져 조용히 통과했다 —
    이제 pydantic이 422로 거부한다(「오타로 써도 통과하나」의 자리)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": "spam"}, "expected_version": 0},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CONTENT_RULES_INVALID"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_put_unknown_key_returns_422():
    """오타로 다른 철자를 쳐도(예: `bannned_terms`) 조용히 무시되는 대신 422로 알린다
    (`extra="forbid"`, 페드루 PO 리뷰 보정)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"bannned_terms": ["오타"]}, "expected_version": 0},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "CONTENT_RULES_INVALID"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_put_returns_403_owner_field_untouched():
    """story #3490 — 옛 코드 CONTENT_RULES_OWNER_ONLY는 이제 없다(부재 검산).
    member는 여전히 403(회귀 0), 새 코드는 CONTENT_RULES_ADMIN_ONLY."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            member_id = await _seed_human(s, org_id, role="member")

        _setup_org_scoped_app(app, Session, org_id, user_id=member_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["x"]}, "expected_version": 0},
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "CONTENT_RULES_ADMIN_ONLY"
        assert "CONTENT_RULES_OWNER_ONLY" not in r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_admin_put_content_rules_succeeds():
    """story #3490(PO 決定 2026-09-05) — owner만이던 편집 자격을 owner·admin으로
    넓힌다(채널 연결 생성과 동형 권한 폭). dev org의 유일 owner가 대표뿐이라 admin
    운영자가 규칙을 못 넣던 비대칭을 해소."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            admin_id = await _seed_human(s, org_id, role="admin")

        _setup_org_scoped_app(app, Session, org_id, user_id=admin_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["금칙어"]}, "expected_version": 0},
            )
        assert r.status_code == 200, r.text
        assert r.json()["rules"]["banned_terms"] == ["금칙어"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_get_sees_declaration_slots_but_put_is_403():
    """에이전트: GET(톤·택소노미·채널 우선순위·브랜드 킷 그대로 실림) 허용 · PUT 403."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={
                    "rules": {"tone": "친근한", "taxonomy": ["블로그"], "channel_priority": ["threads"]},
                    "expected_version": 0,
                },
            )
            assert r_put.status_code == 200, r_put.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_get = await client.get(f"/api/v2/organizations/{org_id}/content-rules")
            assert r_get.status_code == 200, r_get.text
            assert r_get.json()["rules"]["tone"] == "친근한"
            assert r_get.json()["rules"]["taxonomy"] == ["블로그"]

            r_put_agent = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"tone": "x"}, "expected_version": 1},
            )
        assert r_put_agent.status_code == 403, r_put_agent.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_rules_isolated():
    """A org 규칙이 B org 초안에 안 걸린다 — GET도 org별로 독립."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, project_b = await _seed_org(s)
            owner_a = await _seed_human(s, org_a, role="owner")
            owner_b = await _seed_human(s, org_b, role="owner")

        _setup_org_scoped_app(app, Session, org_a, user_id=owner_a)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_a}/content-rules",
                json={"rules": {"banned_terms": ["A전용금칙"]}, "expected_version": 0},
            )
            assert r.status_code == 200, r.text

        _setup_org_scoped_app(app, Session, org_b, user_id=owner_b)
        async with _client_for(app) as client:
            r_get_b = await client.get(f"/api/v2/organizations/{org_b}/content-rules")
        assert r_get_b.json() == {"org_id": str(org_b), "rules": {}, "version": 0}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_draft_create_reports_violation_then_submit_422_then_clear_and_pass():
    """AC1·AC2 실물 — 금칙어 있는 초안 create 응답에 violations 실림 → submit 422
    CONTENT_RULE_VIOLATION → 금칙어 없는 새 버전 create → submit 200."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            owner_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["테스트금칙"]}, "expected_version": 0},
            )
            assert r_put.status_code == 200, r_put.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "이 글에는 테스트금칙 단어가 있습니다",
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            body = r_draft.json()
            assert len(body["violations"]) == 1
            assert body["violations"][0]["code"] == "banned_term"
            draft_id = body["draft_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 422, r_submit.text
            assert r_submit.json()["error"]["code"] == "CONTENT_RULE_VIOLATION"
            assert r_submit.json()["error"]["violations"][0]["code"] == "banned_term"

            r_draft2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "깨끗한 본문입니다",
                },
            )
            assert r_draft2.status_code == 201, r_draft2.text
            assert r_draft2.json()["violations"] == []

            r_submit2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit2.status_code == 200, r_submit2.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_draft_banned_term_in_title_blocks_submit():
    """story #3482(2026-09-05 후속) — site_post는 title·summary·body_md 각각 lint한다
    (#3471의 결합 텍스트 한 덩이 방식은 폐기 — field가 항상 "text"로 와 site_post
    화면이 어느 필드 아래인지 못 정했다). 제목에 금칙어가 있으면 field="title"로
    잡혀야 한다(body_md만 보면 놓친다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            owner_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["금지어"]}, "expected_version": 0},
            )
            assert r_put.status_code == 200, r_put.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "금지어가 있는 제목", "slug": "banned-title-post",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            assert len(r_draft.json()["violations"]) == 1
            assert r_draft.json()["violations"][0]["field"] == "title"
            draft_id = r_draft.json()["draft_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit.status_code == 422, r_submit.text
        assert r_submit.json()["error"]["code"] == "CONTENT_RULE_VIOLATION"
        assert r_submit.json()["error"]["violations"][0]["field"] == "title"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_lint_result_snapshot_preserves_rules_version_after_later_put():
    """AC 「과거 evidence 보존」 — 규칙 PUT 뒤에도 이미 저장된 draft.lint_result.
    rules_version은 그대로(실시간 재계산 아님)."""
    from sqlalchemy import select
    from app.models.channel_post_draft import ChannelPostDraft
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put1 = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": []}, "expected_version": 0},
            )
            assert r_put1.status_code == 200, r_put1.text
            assert r_put1.json()["version"] == 1

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "본문",
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = uuid.UUID(r_draft.json()["draft_id"])

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put2 = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["새로생긴금칙"]}, "expected_version": 1},
            )
            assert r_put2.status_code == 200, r_put2.text
            assert r_put2.json()["version"] == 2

        async with Session() as s:
            draft = (await s.execute(
                select(ChannelPostDraft).where(ChannelPostDraft.id == draft_id)
            )).scalar_one()
            assert draft.lint_result["rules_version"] == 1, "규칙 PUT 뒤에도 옛 스냅샷의 rules_version이 바뀌면 안 된다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
