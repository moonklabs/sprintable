"""story #3816(적기만, 페드루 PO 지적 2026-09-12 23:50Z) — Ghost 401(재서명 1회
재시도까지 실패, GHOST_AUTH_FAILED로 승격)이 `publication_command.py::
apply_command_failure`의 FAILURE_KIND_CONNECTION 분기(command는 blocked로 정확히
멈춤 — _CONNECTION_BLOCKED_CODES 등재 확認)까지는 닿았지만, 그 안에서 실제
`ChannelConnection.status`를 고르는 `graph_api_errors.connection_status_for_
error_code`의 매핑표(`CONNECTION_ERROR_CODE_TO_STATUS`)에 GHOST_AUTH_FAILED가
없어 매핑 밖 기본값 "expired"로 떨어졌다 — Ghost Admin API 키는 OAuth 토큰처럼
자연 만료되는 개념이 없다(사람이 재발급해야 풀리는 것이지 "시간이 지나 저절로
그렇게 된" 게 아니다), CHANNEL_CONNECTION_AUTH_ERROR와 같은 결(사유 불명 인증
실패)이라 "error"가 정확하다.

이 파일은 `tests.test_e4fc29fa_site_post_orchestration`의 기존 헬퍼(세션 팩토리·
승인·워커)를 그대로 재사용하고, `ghost_sandbox`의 결정적 마커([sandbox:ghost-
auth-failed])로 실제 site_post 발행 파이프라인 전체(제출→승인→워커)를 통해
이 매핑이 최종적으로 connection.status에 반영되는지 양성대조한다(단위 표
테스트는 test_3605_graph_error_family_generalize.py에 별도 추가)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _client_for,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
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
def _enable_ghost_sandbox_adapter(monkeypatch):
    """test_5b27b32f_sandbox_channel.py::_enable_sandbox_adapter·test_3523_generic_
    channel_sandbox.py와 동형 관례 — CI destructive-schema job은 SANDBOX_CHANNEL_
    ENABLED를 이 자리에 안 준다(로컬에서 셸 env로 줘도 CI 프로세스 시작 前 env와는
    별개 — 실측으로 발견, shard(7) AttributeError('NoneType' object has no
    attribute 'display_name')). env 파싱 자체는 그 두 파일의 subprocess 테스트가
    이미 독립 검증하므로, 여기는 dict 직접 주입으로 우회(실 channel_adapters.py의
    "ghost_sandbox" 선언값 그대로 복제 — 이 파일이 검증하는 건 라우팅/판정이지
    어댑터 필드 값 자체가 아니다)."""
    import app.services.channel_adapters as adapters_mod

    ghost_sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="", refresh_mode="manual",
        credential_kind="none", display_name="Ghost Sandbox", kind="blog",
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "ghost_sandbox", ghost_sandbox_config)


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    """test_e4fc29fa_site_post_orchestration.py와 동형(fixture는 파일 경계라
    import만으론 안 딸려 온다 — 이 파일에도 그대로 심는다). ghost_sandbox
    connection도 upsert_channel_connection 경유라 암호화 키가 필요하다."""
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


async def _seed_ghost_sandbox_connection(session, org_id, connected_by):
    """test_3523_generic_channel_sandbox.py와 동형 관례 — 직접 `ChannelConnection(...)`
    을 만들면 `encrypted_access_token`이 비어 `decrypt_for_use`가 None을 돌려주고,
    site_posts.py의 사전 검사(`app_password is None`)가 GHOST_AUTH_FAILED가
    닿기도 前에 CHANNEL_CONNECTION_NOT_ACTIVE로 먼저 끊어버린다(credential_kind
    ='none'이라도 이 사전 검사는 "값이 있는가"만 본다 — 값의 진위는 안 따진다).
    `upsert_channel_connection`을 거쳐 더미값이라도 암호화된 access_token을
    채운다(ghost_sandbox_publish.py 자신은 이 값을 실제로 안 쓴다, 시그니처
    호환용)."""
    from app.services.channel_adapters import get_channel_adapter
    from app.services.channel_connection import upsert_channel_connection

    adapter = get_channel_adapter("ghost_sandbox")
    conn = await upsert_channel_connection(
        session, org_id=org_id, channel="ghost_sandbox", account_id="https://ghost-sandbox.invalid",
        account_label=adapter.display_name, credential_kind=adapter.credential_kind,
        access_token="sandbox-dummy-access-token", refresh_token=None,
        token_expires_at=None, refresh_mode=adapter.refresh_mode,
        scopes=[], connected_by=connected_by,
    )
    return conn.id


@pytest.mark.anyio
async def test_ghost_sandbox_auth_failed_marker_promotes_connection_to_error_not_expired():
    """⭐양성대조(story #3816 적기만) — [sandbox:ghost-auth-failed] 마커로 실제
    publish 파이프라인(제출→승인→워커)을 끝까지 태워, command가 blocked로 멈추고
    connection.status가 "error"(사람이 키를 재발급해야 풀리는 것)로 정확히
    승격되는지 잰다. 뮤테이션 대상 — CONNECTION_ERROR_CODE_TO_STATUS에서
    GHOST_AUTH_FAILED 항목을 걷으면 status가 "expired"로 떨어져 이 assert가 RED."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_ghost_sandbox_connection(s, org_id, human_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_user_id, agent=False)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "[sandbox:ghost-auth-failed]", "slug": "post-ghost-auth",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
                    "connection_id": str(connection_id),
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = uuid.UUID(r_draft.json()["draft_id"])
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={})
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            await process_due_publication_commands(s)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import select

            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            assert cmd.status == "blocked", (
                f"GHOST_AUTH_FAILED가 FAILURE_KIND_CONNECTION 분기를 안 탔다(command={cmd.status})"
            )
            assert cmd.reason_code == "GHOST_AUTH_FAILED"

            connection = await s.get(ChannelConnection, connection_id)
            assert connection.status == "error", (
                f"GHOST_AUTH_FAILED가 connection.status를 매핑표 밖 기본값(expired)으로 "
                f"떨어뜨렸다 — CONNECTION_ERROR_CODE_TO_STATUS 등재 필요(실제 status={connection.status!r})"
            )
            assert connection.last_error_code == "GHOST_AUTH_FAILED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ghost_sandbox_provider_error_marker_still_leaves_connection_active_no_regression():
    """양성대조(회귀 0) — 같은 ghost_sandbox 파이프라인에서 5xx([sandbox:provider-
    error])는 transient(CHANNEL_PUBLISH_PROVIDER_ERROR)라 connection.status가
    active 그대로 무변경이어야 한다(GHOST_AUTH_FAILED 매핑 추가가 다른 코드축을
    안 건드린다는 증거)."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_ghost_sandbox_connection(s, org_id, human_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_user_id, agent=False)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "[sandbox:provider-error]", "slug": "post-ghost-provider",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
                    "connection_id": str(connection_id),
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = uuid.UUID(r_draft.json()["draft_id"])
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={})
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            await process_due_publication_commands(s)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import select

            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            assert cmd.failure_kind == "transient", cmd.failure_kind

            connection = await s.get(ChannelConnection, connection_id)
            assert connection.status == "active", connection.status
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
