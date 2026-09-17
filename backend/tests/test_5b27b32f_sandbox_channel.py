"""story 5b27b32f(Phase1·BE·테스트 인프라, 페드루 PO 확定 2026-09-04) — dev 전용
샌드박스 채널 어댑터. AC1~5 QA: 어댑터 등재 게이트(env 실측)·연결 생성 endpoint(owner/
admin)·마커 5종(단위+통합)·prod fail-closed·발행/취소/회수 경로 라이브 재현.

`CHANNEL_ADAPTERS["sandbox"]`는 모듈 import 시점에 `SANDBOX_CHANNEL_ENABLED` env를
1회 읽어 등재하므로(channel_adapters.py), 개별 테스트는 `monkeypatch.setitem`으로
그 dict에 직접 항목을 넣고 뺀다(reload 불요 — channel_adapters.py엔 예외 클래스가
없어 애초에 그 함정도 없지만, dict 직접 조작이 더 단순·명확하다). env 게이트 자체가
실제로 동작하는지는 별도 subprocess 테스트로 독립 검증."""
from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

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


@pytest.fixture(autouse=True)
def _enable_sandbox_adapter(monkeypatch):
    """dict 항목 직접 주입 — SANDBOX_CHANNEL_ENABLED env 파싱 자체는 별도
    test_sandbox_env_flag_gates_registration_via_subprocess가 독립 검증한다.

    story #4009 — `is_test_channel=True`를 명시로 넣는다(기본값 False 그대로 두면
    assert_sandbox_channel_not_registered_in_prod()가 이 주입을 더 이상 sandbox
    채널로 못 알아본다 — 실 모듈 등록 코드와 같은 기준을 이 픽스처도 지켜야 한다)."""
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test", supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=1,
        is_test_channel=True,
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)
    yield


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

    org = Organization(id=uuid.uuid4(), name="5b27b32f Sandbox Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, project_id, *, role="owner"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    """페드루 리뷰 B1 — test_3373_channel_connections_auth.py::_seed_agent와 동형."""
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="채널 포스트"):
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


async def _approve_gate_directly(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


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


async def _create_sandbox_connection(client, org_id) -> uuid.UUID:
    r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox")
    assert r.status_code == 201, r.text
    return uuid.UUID(r.json()["id"])


async def _create_draft_submit_approve(client, s, *, org_id, connection_id, story_id, text="샌드박스 포스트"):
    r_draft = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": text},
    )
    assert r_draft.status_code == 201, r_draft.text
    draft_id = r_draft.json()["draft_id"]
    r_submit = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
    )
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    await _approve_gate_directly(s, gate_id)
    return draft_id, gate_id


# ─── AC1 — env 게이트 실측(subprocess, monkeypatch 아님) ─────────────────────

_ALL_TEST_CHANNELS = (
    "sandbox", "instagram_sandbox", "facebook_sandbox", "ads_sandbox",
    "x_sandbox", "youtube_sandbox", "stibee_sandbox", "ghost_sandbox",
)


def test_sandbox_env_flag_gates_registration_via_subprocess():
    """subprocess로 실제 프로세스 기동+import 순서를 그대로 재현 — dict 직접주입이
    아니라 진짜 env var 파싱 경로 자체를 검증한다(AC1).

    story #4009(critical, AC2) — 8개 테스트용 채널 전수. facebook_sandbox/
    ads_sandbox/x_sandbox/youtube_sandbox는 이전엔 이 게이트 밖(모듈 최상위)에
    무조건 등록돼 있었다(prod 노출 사고의 뿌리) — 이제 나머지 4개와 동형으로
    같은 env 게이트를 통과해야만 등재된다."""
    import subprocess
    import sys

    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    channels_repr = repr(_ALL_TEST_CHANNELS)
    script = (
        "from app.services.channel_adapters import CHANNEL_ADAPTERS\n"
        f"for ch in {channels_repr}:\n"
        "    assert ch in CHANNEL_ADAPTERS, f'enabled인데 미등재: {ch}'\n"
        "    assert CHANNEL_ADAPTERS[ch].is_test_channel, f'is_test_channel 미선언: {ch}'\n"
    )
    r_on = subprocess.run(
        [sys.executable, "-c", script], cwd=backend_dir, capture_output=True, text=True,
        env={**os.environ, "SANDBOX_CHANNEL_ENABLED": "true"},
    )
    assert r_on.returncode == 0, r_on.stderr

    script_off = (
        "from app.services.channel_adapters import CHANNEL_ADAPTERS\n"
        f"for ch in {channels_repr}:\n"
        "    assert ch not in CHANNEL_ADAPTERS, f'unset인데 등재됨(prod 사고 위험): {ch}'\n"
        "assert not any(cfg.is_test_channel for cfg in CHANNEL_ADAPTERS.values()), "
        "'unset인데 is_test_channel 어댑터가 남아있음'\n"
    )
    env_off = {k: v for k, v in os.environ.items() if k != "SANDBOX_CHANNEL_ENABLED"}
    r_off = subprocess.run(
        [sys.executable, "-c", script_off], cwd=backend_dir, capture_output=True, text=True, env=env_off,
    )
    assert r_off.returncode == 0, r_off.stderr


_LOOKS_SANDBOX_NAMED_SNIPPET = (
    "def looks_sandbox_named(ch):\n"
    "    return ch == 'sandbox' or ch.endswith('_sandbox')\n"
)


def test_test_channel_registration_matches_naming_convention_both_directions():
    """story #4009 CHANGES(페드루 PO 지적 2026-09-17) — 위
    test_sandbox_env_flag_gates_registration_via_subprocess는 `_ALL_TEST_CHANNELS`
    (이름 8개 하드코딩)만 순회한다. 9번째 sandbox 채널이 이번 사고와 같은 모양
    (모듈 최상위에 등록·`is_test_channel` 미선언)으로 추가되면 그 하드코딩 목록엔
    원래 없으니 그 테스트는 초록 그대로였을 것 — 사고 클래스를 여전히 «손으로 적은
    이름 목록»이 닫고 있는 셈이었다.

    이 테스트는 `CHANNEL_ADAPTERS`를 그 자체로(이름 목록 없이) 순회해 양방향
    대조한다: `is_test_channel` 선언과 `_sandbox` 접미(또는 단독 `sandbox`) 명명
    관례가 모든 키에서 항상 같은 값이어야 한다 — 한쪽만 참이면(이름은 sandbox인데
    속성이 없거나, 속성은 있는데 이름이 관례를 안 따르거나) 그 자체가 이번 실제
    사고의 정확한 모양이라 RED."""
    import subprocess
    import sys

    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    check_script = (
        "from app.services.channel_adapters import CHANNEL_ADAPTERS\n"
        + _LOOKS_SANDBOX_NAMED_SNIPPET
        + "mismatches = [ch for ch, cfg in CHANNEL_ADAPTERS.items() "
        "if cfg.is_test_channel != looks_sandbox_named(ch)]\n"
        "assert not mismatches, f'is_test_channel과 명명 관례 불일치: {mismatches}'\n"
    )
    r_on = subprocess.run(
        [sys.executable, "-c", check_script], cwd=backend_dir, capture_output=True, text=True,
        env={**os.environ, "SANDBOX_CHANNEL_ENABLED": "true"},
    )
    assert r_on.returncode == 0, r_on.stderr

    off_script = check_script + (
        "assert not any(cfg.is_test_channel for cfg in CHANNEL_ADAPTERS.values()), "
        "'flag off인데 is_test_channel 어댑터가 남음'\n"
        "assert not any(looks_sandbox_named(ch) for ch in CHANNEL_ADAPTERS), "
        "'flag off인데 sandbox 명명 채널이 남음'\n"
    )
    env_off = {k: v for k, v in os.environ.items() if k != "SANDBOX_CHANNEL_ENABLED"}
    r_off = subprocess.run(
        [sys.executable, "-c", off_script], cwd=backend_dir, capture_output=True, text=True, env=env_off,
    )
    assert r_off.returncode == 0, r_off.stderr


def test_test_channel_registration_consistency_check_catches_synthetic_violation(monkeypatch):
    """양성 대조(페드루 PO 요청) — 위 양방향 대조 로직 자체가 늘 그린인 무의미한
    검사가 아님을 증명한다. `_sandbox` 접미로 이름 짓고 `is_test_channel`을 안 든
    합성 채널을 주입하면(이번 실제 사고 — facebook_sandbox 등 4개가 겪은 것과
    정확히 같은 모양: 이름은 관례를 따르는데 속성 선언이 빠짐) 같은 로직이
    반드시 이 채널을 mismatch로 잡아야 한다."""
    import app.services.channel_adapters as adapters_mod

    bad_channel = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="", refresh_mode="manual",
        credential_kind="none", display_name="Foo Sandbox(합성 결함 재현)",
        # is_test_channel 기본값 False로 방치 — 이번 실제 사고와 동형(이름은
        # _sandbox 관례를 따르는데 속성 선언이 빠진 자리).
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "foo_sandbox", bad_channel)

    def looks_sandbox_named(ch: str) -> bool:
        return ch == "sandbox" or ch.endswith("_sandbox")

    mismatches = [
        ch for ch, cfg in adapters_mod.CHANNEL_ADAPTERS.items()
        if cfg.is_test_channel != looks_sandbox_named(ch)
    ]
    assert "foo_sandbox" in mismatches, "합성 결함(이름 sandbox·속성 없음)을 못 잡음 — 대조 로직 자체가 무의미"


def test_get_publish_client_module_dispatches_by_channel():
    from app.services import sandbox_publish, threads_publish
    from app.services.channel_adapters import ChannelPublishDispatchNotImplementedError, get_publish_client_module

    assert get_publish_client_module("sandbox") is sandbox_publish
    assert get_publish_client_module("threads") is threads_publish
    # story #3320(페드루 PO 確定) — 미등록 채널이 threads_publish로 조용히 떨어지던
    # 옛 기본값(회귀 축)은 근본처방으로 제거됨. 지금은 fail-closed 예외가 정본
    # (test_3320_instagram_connector.py에 뮤테이션 자가검증 포함 더 자세히 있음).
    with pytest.raises(ChannelPublishDispatchNotImplementedError):
        get_publish_client_module("unknown-channel")


# ─── AC5 — prod fail-closed ───────────────────────────────────────────────

def test_prod_with_sandbox_registered_raises(monkeypatch):
    from app.core.config import settings
    from app.services.channel_adapters import assert_sandbox_channel_not_registered_in_prod

    monkeypatch.setattr(settings, "deploy_env", "prod")
    with pytest.raises(RuntimeError, match="fail-closed"):
        assert_sandbox_channel_not_registered_in_prod()


def test_dev_with_sandbox_registered_does_not_raise(monkeypatch):
    from app.core.config import settings
    from app.services.channel_adapters import assert_sandbox_channel_not_registered_in_prod

    monkeypatch.setattr(settings, "deploy_env", "dev")
    assert_sandbox_channel_not_registered_in_prod()  # no raise


def test_prod_without_sandbox_registered_does_not_raise(monkeypatch):
    """story #4009 — 가드가 이제 is_test_channel=True 전부를 보므로("sandbox" 한
    키만 보던 예전과 다름), pytest 세션(conftest.py 기본값)이 이미 등록해 둔
    나머지 7개(instagram_sandbox 등)도 같이 지워야 "테스트 채널 0건" 상태를
    정확히 재현한다."""
    import app.services.channel_adapters as adapters_mod
    from app.core.config import settings

    monkeypatch.setattr(settings, "deploy_env", "prod")
    for ch, cfg in list(adapters_mod.CHANNEL_ADAPTERS.items()):
        if cfg.is_test_channel:
            monkeypatch.delitem(adapters_mod.CHANNEL_ADAPTERS, ch, raising=False)
    adapters_mod.assert_sandbox_channel_not_registered_in_prod()  # no raise


def test_prod_with_only_one_of_four_previously_ungated_channels_raises(monkeypatch):
    """story #4009(critical, AC3) — 가드가 리터럴 "sandbox" 하나만 보던 이전 결함을
    정정한다: facebook_sandbox/ads_sandbox/x_sandbox/youtube_sandbox 中 아무거나
    하나만 등록돼 있어도(다른 7개는 없어도) 잡혀야 한다("sandbox" 키가 아예 없는
    조합으로 이전 가드가 실제로 뚫렸던 상태를 정확히 재현)."""
    import app.services.channel_adapters as adapters_mod
    from app.core.config import settings

    monkeypatch.setattr(settings, "deploy_env", "prod")
    for ch, cfg in list(adapters_mod.CHANNEL_ADAPTERS.items()):
        if cfg.is_test_channel:
            monkeypatch.delitem(adapters_mod.CHANNEL_ADAPTERS, ch, raising=False)
    only_ads_sandbox = adapters_mod.ChannelAdapterConfig(
        authorize_url="https://www.facebook.com/v21.0/dialog/oauth",
        token_url="https://graph.facebook.com/v21.0/oauth/access_token",
        scope="ads_management", refresh_mode="reissue_from_access_token",
        credential_kind="oauth", display_name="Meta Ads Sandbox", kind="ads",
        requires_connection=True, is_test_channel=True,
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "ads_sandbox", only_ads_sandbox)
    with pytest.raises(RuntimeError, match="fail-closed"):
        adapters_mod.assert_sandbox_channel_not_registered_in_prod()


# ─── AC2 — 연결 생성 endpoint ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_sandbox_connection_as_owner_succeeds():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["channel"] == "sandbox"
        assert body["status"] == "active"
        assert body["account_label"] == "Sandbox"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_sandbox_connection_as_admin_succeeds():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id, role="admin")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox")
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_sandbox_connection_as_member_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id, role="member")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox")
        assert r.status_code == 403, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_sandbox_connection_as_agent_returns_403():
    """페드루 리뷰 B1 — 샌드박스 연결은 "OAuth 없이 agent-callable"이 아니다. 실제로는
    `_require_owner_or_admin`이 `_require_human`을 거치므로(channel_connections.py:76,51)
    에이전트 키는 사람과 똑같이 403(CHANNEL_CONNECTION_HUMAN_ONLY) — 실 OAuth 연결
    (test_3373_channel_connections_auth.py::test_agent_gets_403_on_every_endpoint)과 동일
    가드가 이 신규 endpoint에도 그대로 적용됨을 고정."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox")
        assert r.status_code == 403, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_CONNECTION_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_sandbox_connection_disabled_returns_404(monkeypatch):
    """어댑터가 등재 안 돼 있으면(prod 정상 상태) 엔드포인트 자체는 살아있되 404 —
    fail-closed 축이 어댑터 레지스트리 하나로 모여 있는지 확인."""
    from app.main import app
    import app.services.channel_adapters as adapters_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id, role="owner")

        monkeypatch.delitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", raising=False)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox")
        assert r.status_code == 404, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_SANDBOX_DISABLED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_sandbox_connection_idempotent_upsert():
    """같은 org 재호출 = 새 행이 아니라 기존 행 갱신(AC2, story #3373 AC8 재사용)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox")
            r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/sandbox")
        assert r1.json()["id"] == r2.json()["id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC3 — sandbox_publish 마커 단위 검증 ─────────────────────────────────

@pytest.mark.anyio
async def test_sandbox_publish_default_success_flow():
    from app.services import sandbox_publish as sp

    creation_id = await sp.create_container(
        None, access_token="x", threads_user_id="u", text="마커 없는 평범한 글",
    )
    status, err = await sp.get_container_status(None, access_token="x", creation_id=creation_id)
    assert status == "FINISHED"
    assert err is None
    media_id = await sp.publish_container(None, access_token="x", threads_user_id="u", creation_id=creation_id)
    permalink = await sp.get_permalink(None, access_token="x", media_id=media_id)
    assert permalink == f"https://sandbox.invalid/{media_id}"


@pytest.mark.anyio
async def test_sandbox_publish_429_marker():
    from app.services import sandbox_publish as sp
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError) as exc_info:
        await sp.create_container(None, access_token="x", threads_user_id="u", text="본문 [sandbox:429] 마커")
    assert exc_info.value.status_code == 429


@pytest.mark.anyio
async def test_sandbox_publish_provider_error_marker():
    from app.services import sandbox_publish as sp
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError) as exc_info:
        await sp.create_container(None, access_token="x", threads_user_id="u", text="[sandbox:provider-error]")
    assert exc_info.value.status_code == 502


@pytest.mark.anyio
async def test_sandbox_publish_expired_token_marker():
    from app.services import sandbox_publish as sp
    from app.services.threads_publish import ThreadsPublishError

    with pytest.raises(ThreadsPublishError) as exc_info:
        await sp.create_container(None, access_token="x", threads_user_id="u", text="[sandbox:expired-token]")
    assert exc_info.value.status_code == 401


# story #3598 — 3595 표 행 ②③④(권한 회수·페이지 연결 해제·앱 비활성) 시뮬레이션
# 마커 3종. 각 1 테스트(AC2) — 마커가 401을 내는 것뿐 아니라 그 401이 실제로
# _classify_threads_error를 거쳐 CHANNEL_CONNECTION_REVOKED(신설, expired가 아님)로
# 분류되는지까지 확認한다 — 마커만 있고 분류가 안 되면 3595 표는 여전히 "미감지".
@pytest.mark.anyio
async def test_sandbox_publish_revoked_marker_classifies_as_connection_revoked():
    import uuid
    from app.services import sandbox_publish as sp
    from app.services.threads_publish import ThreadsPublishError
    from app.services.channel_posts import _classify_threads_error

    with pytest.raises(ThreadsPublishError) as exc_info:
        await sp.create_container(None, access_token="x", threads_user_id="u", text="[sandbox:revoked]")
    assert exc_info.value.status_code == 401
    error_code, _ = _classify_threads_error(exc_info.value, connection_id=uuid.uuid4())
    assert error_code == "CHANNEL_CONNECTION_REVOKED"


@pytest.mark.anyio
async def test_sandbox_publish_page_unlinked_marker_classifies_as_connection_revoked():
    import uuid
    from app.services import sandbox_publish as sp
    from app.services.threads_publish import ThreadsPublishError
    from app.services.channel_posts import _classify_threads_error

    with pytest.raises(ThreadsPublishError) as exc_info:
        await sp.create_container(None, access_token="x", threads_user_id="u", text="[sandbox:page-unlinked]")
    assert exc_info.value.status_code == 401
    error_code, _ = _classify_threads_error(exc_info.value, connection_id=uuid.uuid4())
    assert error_code == "CHANNEL_CONNECTION_REVOKED"


@pytest.mark.anyio
async def test_sandbox_publish_app_inactive_marker_classifies_as_connection_revoked():
    import uuid
    from app.services import sandbox_publish as sp
    from app.services.threads_publish import ThreadsPublishError
    from app.services.channel_posts import _classify_threads_error

    with pytest.raises(ThreadsPublishError) as exc_info:
        await sp.create_container(None, access_token="x", threads_user_id="u", text="[sandbox:app-inactive]")
    assert exc_info.value.status_code == 401
    error_code, _ = _classify_threads_error(exc_info.value, connection_id=uuid.uuid4())
    assert error_code == "CHANNEL_CONNECTION_REVOKED"


@pytest.mark.anyio
async def test_sandbox_publish_permission_error_marker_classifies_as_connection_auth_error():
    """story #3605 — code==10(190 밖 family) 시뮬레이션. 위 세 마커(revoked류)와
    달리 CHANNEL_CONNECTION_AUTH_ERROR(사유 불명, fail-closed)로 분류돼야 한다."""
    import uuid
    from app.services import sandbox_publish as sp
    from app.services.threads_publish import ThreadsPublishError
    from app.services.channel_posts import _classify_threads_error

    with pytest.raises(ThreadsPublishError) as exc_info:
        await sp.create_container(None, access_token="x", threads_user_id="u", text="[sandbox:permission-error]")
    assert exc_info.value.status_code == 401
    assert exc_info.value.provider_error_code == 10
    error_code, _ = _classify_threads_error(exc_info.value, connection_id=uuid.uuid4())
    assert error_code == "CHANNEL_CONNECTION_AUTH_ERROR"


@pytest.mark.anyio
async def test_sandbox_publish_container_error_marker():
    from app.services import sandbox_publish as sp

    creation_id = await sp.create_container(
        None, access_token="x", threads_user_id="u", text="[sandbox:container-error]",
    )
    status, err = await sp.get_container_status(None, access_token="x", creation_id=creation_id)
    assert status == "ERROR"
    assert err is not None


@pytest.mark.anyio
async def test_sandbox_publish_container_slow_marker_two_ticks(monkeypatch):
    """AC3 "container IN_PROGRESS→FINISHED 2 tick" — 첫 폴링(경과 0초)엔 IN_PROGRESS,
    지연 경과 뒤엔 FINISHED. 실제 40초를 기다리지 않고 time.time()을 목으로 진행시킨다."""
    import app.services.sandbox_publish as sp

    fake_now = [1_000_000.0]
    monkeypatch.setattr(sp.time, "time", lambda: fake_now[0])

    creation_id = await sp.create_container(
        None, access_token="x", threads_user_id="u", text="[sandbox:container-slow]",
    )
    status1, _ = await sp.get_container_status(None, access_token="x", creation_id=creation_id)
    assert status1 == "IN_PROGRESS"

    fake_now[0] += sp._CONTAINER_SLOW_DELAY_SECONDS + 1
    status2, _ = await sp.get_container_status(None, access_token="x", creation_id=creation_id)
    assert status2 == "FINISHED"


@pytest.mark.anyio
async def test_sandbox_publish_delete_media_always_succeeds():
    from app.services import sandbox_publish as sp

    result = await sp.delete_media(None, access_token="x", media_id="sandbox-media-abc")
    assert result is None  # 예외 없이 반환 = 성공(threads_publish.delete_media와 동형 계약)


# ─── AC3 — 통합: 발행 오케스트레이션을 sandbox로 실제로 태움 ──────────────────

@pytest.mark.anyio
async def test_publish_via_sandbox_default_success():
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            connection_id = await _create_sandbox_connection(client, org_id)
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                text="평범한 샌드박스 발행",
            )
            publication = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
            )
        assert publication.status == "published"
        assert publication.permalink.startswith("https://sandbox.invalid/")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_via_sandbox_429_marker_returns_rate_limited():
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft, ChannelRateLimitedError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            connection_id = await _create_sandbox_connection(client, org_id)
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                text="한도 초과 테스트 [sandbox:429]",
            )
            with pytest.raises(ChannelRateLimitedError):
                await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_via_sandbox_expired_token_marker_via_http():
    """HTTP 레벨까지 — 즉시발행 엔드포인트가 CHANNEL_TOKEN_EXPIRED 409를 정확히 낸다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            connection_id = await _create_sandbox_connection(client, org_id)
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                text="토큰 만료 테스트 [sandbox:expired-token]",
            )
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r.status_code == 409, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_TOKEN_EXPIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_via_sandbox_container_error_marker_inert_on_text_path():
    """TEXT 발행은 컨테이너 생성 뒤 곧바로 publish까지 진행하고 폴링 자체가 없다(story
    620beefc B3 — IN_PROGRESS 폴링은 IMAGE 경로 전용). `[sandbox:container-error]`
    마커는 get_container_status가 호출돼야만 관측되므로, TEXT 경로에서는 이 마커가
    무해해야 한다(발행이 정상 성공) — 단위 테스트(test_sandbox_publish_container_error_
    marker)가 이미 ERROR 상태 자체는 검증했으니, 여기서는 "그 상태가 TEXT 경로에선
    아예 안 보인다"는 통합 계약을 고정한다."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            connection_id = await _create_sandbox_connection(client, org_id)
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                text="TEXT 발행은 폴링이 없다 [sandbox:container-error]",
            )
            publication = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
            )
        assert publication.status == "published"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_via_sandbox_container_slow_marker_inert_on_text_path():
    """페드루 리뷰 B2 — `[sandbox:container-error]`와 동일 이유로 `[sandbox:container-
    slow]`도 TEXT 경로에서는 폴링 자체가 없어(has_image=False면 get_container_status
    호출 안 함, story 620beefc B3) 즉시 published여야 한다 — 지연이 전혀 관측되면 안
    된다(관측되면 TEXT/IMAGE 분기 자체가 깨진 것)."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            connection_id = await _create_sandbox_connection(client, org_id)
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                text="TEXT 발행은 폴링이 없다 [sandbox:container-slow]",
            )
            publication = await publish_channel_post_draft(
                s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
            )
        assert publication.status == "published"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC4 실효 — cancel-scheduled·unpublish가 sandbox로 라이브 왕복 가능한지 ────

@pytest.mark.anyio
async def test_cancel_scheduled_via_sandbox():
    from app.main import app
    from app.services.channel_posts import cancel_scheduled_publication
    from app.models.publication_command import PublicationCommand

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            connection_id = await _create_sandbox_connection(client, org_id)
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id,
                destination=connection_id, approved_version=uuid.uuid4(),
                status="pending", requested_by_member_id=human_id,
            )
            s.add(cmd)
            await s.commit()

            cancelled = await cancel_scheduled_publication(
                s, org_id=org_id, draft_id=draft_id, cancelled_by_member_id=human_id,
            )
        assert cancelled.status == "cancelled"
        assert cancelled.reason_code == "CANCELLED_BY_HUMAN"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_via_sandbox():
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft, unpublish_channel_post

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            connection_id = await _create_sandbox_connection(client, org_id)
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )
            await publish_channel_post_draft(s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id)
            pub = await unpublish_channel_post(s, org_id=org_id, draft_id=draft_id, unpublished_by_member_id=human_id)
        assert pub.status == "unpublished"
        assert pub.external_id is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
