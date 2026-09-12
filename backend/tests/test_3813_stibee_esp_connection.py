"""story #3813(Phase3·3-4 PR1, 페드루 PO 確定 2026-09-12) — 뉴스레터(ESP=전달만)
첫 조각: 스티비(Stibee) Auth Key 붙여넣기 연결+`stibee_sandbox` 미러. wordpress/
webhook(story e4fc29fa 조각⑤)의 pasted_secret 관례를 그대로 재사용(신규 기전 0)
— 세팅·헬퍼는 test_e4fc29fa_channel_connection_creation.py 재사용(중복 재발명 금지).
`stibee_sandbox`는 credential_kind="none" 계열(sandbox/instagram_sandbox와 동형,
facebook_sandbox/ads_sandbox류의 "진짜 OAuth 콜백" 계열이 아니다 — stibee 자체가
OAuth가 없어서)이라 범용 `/{org_id}/channel-connections/{channel}/sandbox`
엔드포인트(story #3523)가 신규 라우트 0으로 그대로 받는다."""
from __future__ import annotations

import os

import pytest

from tests.test_e4fc29fa_channel_connection_creation import (
    _client_for,
    _seed_agent,
    _seed_human,
    _seed_org,
    _session_factory,
    _setup_org_scoped_app,
)

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
def _register_stibee_sandbox(monkeypatch):
    """`stibee_sandbox`는 CHANNEL_ADAPTERS의 SANDBOX_CHANNEL_ENABLED 조건부 블록
    안에 등재된다(sandbox/instagram_sandbox와 동형) — 모듈이 이미 import된 뒤라
    딕셔너리에 직접 주입(test_3320_instagram_connector.py 선례와 동형)."""
    import app.services.channel_adapters as adapters_mod

    stibee_sandbox_cfg = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="",
        refresh_mode="manual", credential_kind="none", display_name="스티비 샌드박스", kind="social",
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "stibee_sandbox", stibee_sandbox_cfg)
    yield


def test_stibee_kind_is_not_blog_so_channel_post_pipeline_dispatch_stays_open():
    """story 3-4 PR2 그라운딩 발견(2026-09-12 자가정정) — `get_publish_client_module`
    (channel_adapters.py:677-678)은 `adapter.kind == "blog"`면 무조건
    `BlogChannelDispatchNotImplementedError`로 거부한다(story e4fc29fa 리뷰 B2
    설계). PR2가 뉴스레터 초안을 `ChannelPostDraft`/`ChannelPostVersion`(=이 함수가
    다루는 그 파이프라인) 파이프라인에 태우기로 確定됐는데, PR1이 처음 kind="blog"로
    등재했다면 그 시점에 이미 구조적으로 막혀 있었을 것 — kind="social"로 정정한
    뒤 이 fail-closed 분기를 안 타는지(다른 이유로는 여전히 막힐 수 있다 — 실
    dispatch 모듈은 PR2가 심는다, 그건 이 테스트의 관심사가 아니다) 회귀로 고정."""
    from app.services.channel_adapters import (
        BlogChannelDispatchNotImplementedError,
        ChannelPublishDispatchNotImplementedError,
        get_publish_client_module,
    )

    try:
        get_publish_client_module("stibee")
    except BlogChannelDispatchNotImplementedError:
        pytest.fail("stibee가 kind='blog'로 등재돼 channel_post 파이프라인이 구조적으로 막혀 있다")
    except ChannelPublishDispatchNotImplementedError:
        pass  # 기대대로 — PR2가 아직 실 dispatch 모듈을 안 심었을 뿐(정상 현재 상태).


@pytest.mark.anyio
async def test_owner_creates_stibee_connection():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/stibee",
                json={"api_key": "stibee-auth-key-abcdef"},
            )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["channel"] == "stibee"
        assert body["account_id"] == "default"
        assert body["credential_kind"] == "pasted_secret"
        assert body["status"] == "active"
        # story #3373 AC6과 동형 — 응답에 자격 자체(api_key)가 어떤 필드로도 안 실린다.
        assert "api_key" not in body and "encrypted_access_token" not in body
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_stibee_missing_api_key_rejected():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/stibee", json={},
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "STIBEE_FIELDS_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_stibee_agent_forbidden():
    """AC6과 동형 — 에이전트는 ESP 자격을 만들거나 읽을 수 없다(그라운딩 주어 가르기:
    휴먼=API 키 입력)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/stibee",
                json={"api_key": "stibee-auth-key-abcdef"},
            )
        assert r.status_code == 403, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_CONNECTION_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reconnect_stibee_is_idempotent_upsert():
    """story #3373 AC8 재사용 — 같은 (org, stibee, "default") 재호출은 새 행이 아니라
    기존 행 갱신(id 불변, Auth Key 교체)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/stibee",
                json={"api_key": "old-key"},
            )
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/stibee",
                json={"api_key": "new-key"},
            )
        assert r1.status_code == 201, r1.text
        assert r2.status_code == 201, r2.text
        assert r1.json()["id"] == r2.json()["id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_replace_stibee_credential_in_place():
    """story #3492 동형 — 제자리 교체(id 불변). PATCH .../credentials가 create와
    별개 경로임을 확認(create를 두 번 부르지 않고도 회전 가능)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            created = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/stibee",
                json={"api_key": "old-key"},
            )
            connection_id = created.json()["id"]
            replaced = await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={"api_key": "rotated-key"},
            )
        assert replaced.status_code == 200, replaced.text
        assert replaced.json()["id"] == connection_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_replace_stibee_credential_missing_field_rejected():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            created = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/stibee",
                json={"api_key": "old-key"},
            )
            connection_id = created.json()["id"]
            replaced = await client.patch(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/credentials",
                json={},
            )
        assert replaced.status_code == 422, replaced.text
        error = replaced.json().get("error") or replaced.json()
        assert error["code"] == "STIBEE_FIELDS_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_stibee_sandbox_connection_via_generic_endpoint():
    """story #3523 재사용 — 범용 `/{channel}/sandbox` 엔드포인트가 신규 라우트 0으로
    stibee_sandbox를 그대로 받는다(credential_kind="none")."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-connections/stibee_sandbox/sandbox")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["channel"] == "stibee_sandbox"
        assert body["credential_kind"] == "none"
        assert body["account_id"] == f"stibee-sandbox-{org_id}"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_stibee_sandbox_rejects_pasted_secret_endpoint():
    """stibee_sandbox는 credential_kind="none"이라 붙여넣기 엔드포인트 대상이 아니다
    (fail-closed 가드가 correct 채널만 credential_kind로 정확히 가른다는 회귀)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-connections/stibee_sandbox",
                json={"api_key": "irrelevant"},
            )
        assert r.status_code == 404, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_NOT_PASTED_SECRET"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
