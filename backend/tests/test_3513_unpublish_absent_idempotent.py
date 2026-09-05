"""story #3513(Phase1·BE·결함·소형, 페드루 PO 確定 2026-09-05) — 회수(unpublish) 어댑터
delete가 원격에 이미 없는 글(404/410)을 "일시적 provider 오류"로 오분류해 영원히
재시도하다 dead_letter로 끝나던 결함. 실측: A 회수 명령 5d4d1e2d(재배포로 스텁
인메모리가 비어 원격 posts/1이 404).

fix — 회수만의 축(publish와 공유하는 `_blog_publish_error_code`/`_classify_threads_
error`는 안 건드림): 404/410은 "이미 없음=회수 완료"(멱등)로 즉시 성공 처리. 401/403/
5xx는 기존 그대로(회귀 테스트만 — publish 시점 401/403은 connection 승격, 5xx는
CHANNEL_PUBLISH_PROVIDER_ERROR로 이미 기존 테스트가 지키고 있다, 여기서는 unpublish
시점에도 그 분류가 안 바뀌었는지).

site_post(WordPress)는 워커 커맨드 경로(`process_due_publication_commands`)라
`wordpress_publish.publish`/`unpublish`를 직접 monkeypatch해 실 HTTP 없이 상태코드를
결정적으로 제어한다(live_wordpress_stub 없이도 됨 — 이 스토리의 관심사는 상태코드
분류지 실 왕복 자체가 아니다, AC7 실왕복은 e4fc29fa가 이미 짐). channel_post(Threads)
는 test_3419_cancel_unpublish.py와 동형(threads_publish.delete_media monkeypatch)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _client_for as _site_client_for,
    _create_and_submit_site_post_draft,
    _seed_agent as _seed_site_agent,
    _seed_default_role as _seed_site_default_role,
    _seed_human as _seed_site_human,
    _seed_org as _seed_site_org,
    _seed_story as _seed_site_story,
    _seed_wordpress_connection,
    _session_factory as _site_session_factory,
    _setup_org_scoped_app as _setup_site_org_scoped_app,
)
from tests.test_3419_cancel_unpublish import (
    _client_for as _cp_client_for,
    _publish_immediately,
    _seed_agent as _seed_cp_agent,
    _seed_connection as _seed_cp_connection,
    _seed_default_role as _seed_cp_default_role,
    _seed_human as _seed_cp_human,
    _seed_org as _seed_cp_org,
    _seed_story as _seed_cp_story,
    _session_factory as _cp_session_factory,
    _setup_org_scoped_app as _setup_cp_org_scoped_app,
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


# ─── site_post(WordPress) — 워커 커맨드 경로 ─────────────────────────────────


async def _publish_then_request_unpublish_via_worker(*, monkeypatch, unpublish_side_effect=None):
    """publish(monkeypatch로 성공 고정)→worker tick 1회(완료)→회수 요청→worker tick
    2회째(이 함수가 통제하는 unpublish 동작)까지 공통 준비. 반환: (Session, org_id,
    gate_id, command, pub) — 호출부가 이후 상태만 assert하면 되게."""
    import app.services.wordpress_publish as wp
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.services.site_posts import request_site_post_external_unpublish
    from app.main import app

    monkeypatch.setattr(wp, "publish", lambda *a, **k: _AwaitableResult(("123", "https://example.com/123")))

    engine, Session = await _site_session_factory()
    org_id, project_id = None, None
    async with Session() as s:
        org_id, project_id = await _seed_site_org(s)
        await _seed_site_default_role(s, org_id)
        agent_id = await _seed_site_agent(s, org_id, project_id)
        _human_user_id, human_id = await _seed_site_human(s, org_id)
        story_id = await _seed_site_story(s, org_id, project_id)
        connection_id = await _seed_wordpress_connection(s, org_id, site_url="https://example.com")

    _setup_site_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
    async with _site_client_for(app) as client:
        draft_id, gate_id = await _create_and_submit_site_post_draft(
            client, org_id=org_id, story_id=story_id, connection_id=connection_id,
        )

    async with Session() as s:
        await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
        await s.commit()

    async with Session() as s:
        counts = await process_due_publication_commands(s)
    assert counts["completed"] == 1, counts

    async with Session() as s:
        await request_site_post_external_unpublish(
            s, org_id=org_id, draft_id=draft_id, requested_by_member_id=human_id,
        )

    if unpublish_side_effect is not None:
        monkeypatch.setattr(wp, "unpublish", unpublish_side_effect)

    async with Session() as s:
        await process_due_publication_commands(s)

    async with Session() as s:
        from app.models.channel_publication import ChannelPublication
        from app.models.publication_command import PublicationCommand
        from app.models.publication_attempt import PublicationAttempt
        from sqlalchemy import select

        pub = (await s.execute(
            select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
        )).scalar_one()
        command = (await s.execute(
            select(PublicationCommand).where(
                PublicationCommand.gate_id == gate_id, PublicationCommand.operation == "unpublish",
            )
        )).scalar_one()
        attempts = (await s.execute(
            select(PublicationAttempt)
            .where(PublicationAttempt.command_id == command.id)
            .order_by(PublicationAttempt.started_at.desc())
        )).scalars().all()

    await engine.dispose()
    app.dependency_overrides.clear()
    return pub, command, attempts


class _AwaitableResult:
    """monkeypatch 대상 함수가 `await module.publish(...)` 형태로 호출되므로, 동기
    lambda가 반환하는 값 자체가 awaitable이어야 한다(코루틴 흉내 최소형)."""

    def __init__(self, value):
        self._value = value

    def __await__(self):
        async def _coro():
            return self._value
        return _coro().__await__()


def _wordpress_error_side_effect(status_code: int):
    from app.services.wordpress_publish import WordPressPublishError

    async def _raise(*args, **kwargs):
        raise WordPressPublishError(status_code=status_code, body="stub body")
    return _raise


@pytest.mark.anyio
async def test_site_post_unpublish_404_completes_as_already_absent(monkeypatch):
    pub, command, attempts = await _publish_then_request_unpublish_via_worker(
        monkeypatch=monkeypatch, unpublish_side_effect=_wordpress_error_side_effect(404),
    )
    assert command.status == "completed", f"404를 여전히 실패로 처리했다(status={command.status})"
    assert pub.status == "unpublished"
    assert attempts[0].result_code == "already_absent"


@pytest.mark.anyio
async def test_site_post_unpublish_410_completes_as_already_absent(monkeypatch):
    pub, command, attempts = await _publish_then_request_unpublish_via_worker(
        monkeypatch=monkeypatch, unpublish_side_effect=_wordpress_error_side_effect(410),
    )
    assert command.status == "completed"
    assert pub.status == "unpublished"
    assert attempts[0].result_code == "already_absent"


@pytest.mark.anyio
async def test_site_post_unpublish_401_still_blocks_connection_regression(monkeypatch):
    """회귀 — 401은 여전히 «자격 문제»(connection 승격)로 남는다, already_absent로
    잘못 흡수되면 안 된다."""
    pub, command, _attempts = await _publish_then_request_unpublish_via_worker(
        monkeypatch=monkeypatch, unpublish_side_effect=_wordpress_error_side_effect(401),
    )
    assert command.status == "blocked", f"401이 completed로 잘못 흡수됐다(status={command.status})"
    assert command.failure_kind == "connection"
    assert pub.status == "published", "실패했는데 unpublished로 바뀜(회귀)"


@pytest.mark.anyio
async def test_site_post_unpublish_5xx_still_retries_transient_regression(monkeypatch):
    """회귀 — 5xx는 여전히 transient(재시도 큐), completed로 잘못 흡수되면 안 된다."""
    pub, command, _attempts = await _publish_then_request_unpublish_via_worker(
        monkeypatch=monkeypatch, unpublish_side_effect=_wordpress_error_side_effect(500),
    )
    assert command.status == "pending", f"5xx가 completed/dead_letter로 잘못 끝났다(status={command.status})"
    assert command.failure_kind == "transient"
    assert command.attempt_count == 1
    assert pub.status == "published"


# ─── channel_post(Threads) — 직접 호출(라우터 동기 경로) ────────────────────────


@pytest.mark.anyio
async def test_channel_post_unpublish_404_succeeds_idempotent():
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.threads_publish import ThreadsPublishError
    from app.main import app

    engine, Session = await _cp_session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_cp_org(s)
            await _seed_cp_default_role(s, org_id)
            agent_id = await _seed_cp_agent(s, org_id, project_id)
            human_id = await _seed_cp_human(s, org_id, role="owner")
            story_id = await _seed_cp_story(s, org_id, project_id)
            connection_id = await _seed_cp_connection(
                s, org_id, scopes=["threads_basic", "threads_content_publish", "threads_delete"],
            )

        draft_id, gate_id, _external_id = await _publish_immediately(
            app, Session, org_id=org_id, connection_id=connection_id, story_id=story_id,
            agent_id=agent_id, human_id=human_id,
        )
        with patch.object(
            tp, "delete_media",
            AsyncMock(side_effect=ThreadsPublishError("THREADS_MEDIA_NOT_FOUND", "gone", status_code=404)),
        ) as mock_delete:
            async with _cp_client_for(app) as client:
                r_unpub = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/unpublish",
                )
        assert r_unpub.status_code == 200, r_unpub.text
        body = r_unpub.json().get("data") or r_unpub.json()
        assert body["status"] == "unpublished"
        assert mock_delete.await_count == 1

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select
            pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalar_one()
            assert pub.status == "unpublished"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_unpublish_401_still_raises_token_expired_regression():
    """회귀 — 401은 여전히 CHANNEL_TOKEN_EXPIRED(재인증 유도), already_absent로
    흡수되면 안 된다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.threads_publish import ThreadsPublishError
    from app.main import app

    engine, Session = await _cp_session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_cp_org(s)
            await _seed_cp_default_role(s, org_id)
            agent_id = await _seed_cp_agent(s, org_id, project_id)
            human_id = await _seed_cp_human(s, org_id, role="owner")
            story_id = await _seed_cp_story(s, org_id, project_id)
            connection_id = await _seed_cp_connection(
                s, org_id, scopes=["threads_basic", "threads_content_publish", "threads_delete"],
            )

        draft_id, gate_id, _external_id = await _publish_immediately(
            app, Session, org_id=org_id, connection_id=connection_id, story_id=story_id,
            agent_id=agent_id, human_id=human_id,
        )
        with patch.object(
            tp, "delete_media",
            AsyncMock(side_effect=ThreadsPublishError("THREADS_AUTH_REJECTED", "denied", status_code=401)),
        ):
            async with _cp_client_for(app) as client:
                r_unpub = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/unpublish",
                )
        assert r_unpub.status_code != 200, "401이 성공(already_absent)으로 잘못 흡수됐다"
        error = r_unpub.json().get("error") or r_unpub.json()
        assert error["code"] == "CHANNEL_TOKEN_EXPIRED"

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select
            pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalar_one()
            assert pub.status == "published", "실패했는데 unpublished로 바뀜(회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
