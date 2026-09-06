"""story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 발행 명령 경계·인가 축
(429 응답 모양·재시도 엔드포인트 인가·cron 엔드포인트 인가·인사이트 예외 격리).
story #3562(2026-09-06, 페드루 PO 確定) 후속으로 `test_3414_publication_command.py`
(22 테스트·1574줄)에서 분리 — 원본 파일이 CI 60초 러너 정규화 가드 상한에 걸터앉아
주제별 3-way 분할(core·cron_retry·edges). 세팅 헬퍼·픽스처는
`test_3414_publication_command_core.py`에서 그대로 재사용(중복 재발명 0) — autouse
픽스처만 pytest 관례상 파일마다 재선언.

이 파일 담당 — 즉시발행 429 응답 모양·retry 엔드포인트 에이전트 금지·cron 엔드포인트
CRON_SECRET 인가·insight_snapshots 예외가 publication_commands 카운트를 오염 안 시키는지."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3414_publication_command_core import (
    _client_for,
    _create_draft_submit_approve,
    _seed_agent,
    _seed_connection,
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


@pytest.mark.anyio
async def test_publish_immediate_rate_limited_returns_retry_after_header_and_command_state():
    """페드루 리뷰 블로커E·F — 즉시 발행이 429(quota)로 실패하면 응답에 Retry-After
    헤더(실값)가 실리고, body(error 객체)에도 command_status·next_attempt_at이 함께
    나가 사람이 "언제 자동 재시도되는지" 알 수 있는지."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        from app.main import app as _app
        _setup_org_scoped_app(_app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(_app) as client, Session() as s:
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(250, 250, 300))):
            _setup_org_scoped_app(_app, Session, org_id, user_id=human_id)
            async with _client_for(_app) as client:
                r_pub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

        assert r_pub.status_code == 429, r_pub.text
        assert r_pub.headers.get("retry-after") == "300", dict(r_pub.headers)
        body = r_pub.json()
        error = body.get("error") or body
        assert error["command_status"] == "pending"
        assert error["next_attempt_at"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_retry_command_endpoint_agent_caller_forbidden():
    """페드루 리뷰 nit L — 발행 엔드포인트처럼 retry도 human-only(_require_human)인지
    에이전트 키 호출로 확인(기존엔 발행 human-only 테스트만 있고 retry는 없었다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                approved_version=uuid.uuid4(), operation="publish", status="dead_letter",
                requested_by_member_id=uuid.uuid4(),
            )
            s.add(cmd)
            await s.commit()
            cmd_id = cmd.id

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/publication-commands/{cmd_id}/retry")
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_endpoint_requires_cron_secret(monkeypatch):
    """기존 cron.py 다른 엔드포인트와 동일 가드(CRON_SECRET Bearer) 재사용 확認 — DB
    세션(`get_worker_db`)까지 스캐폴딩(override_db_and_read가 안 거는 별도 dependency
    key)해서 진짜로 verify_cron()이 거부하는지 본다(연결 실패로 500이 나면 이 테스트가
    실제로 뭘 검증했는지 알 수 없다)."""
    import app.routers.cron as cron_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    engine, Session = await _session_factory()
    try:
        async def _worker_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_worker_db] = _worker_db
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r_no_auth = await client.post("/api/v2/internal/cron/publication-commands")
            assert r_no_auth.status_code == 401, r_no_auth.text
            r_wrong_auth = await client.post(
                "/api/v2/internal/cron/publication-commands",
                headers={"Authorization": "Bearer wrong-secret"},
            )
            assert r_wrong_auth.status_code == 401, r_wrong_auth.text
            r_right_auth = await client.post(
                "/api/v2/internal/cron/publication-commands",
                headers={"Authorization": "Bearer test-cron-secret"},
            )
            assert r_right_auth.status_code == 200, r_right_auth.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_insight_snapshot_exception_does_not_corrupt_publication_command_counts(monkeypatch):
    """story #3497 조각3(카디르 QA①) — cron.py::publication_commands_tick의 독립 try
    (`process_due_insight_snapshots` 예외를 `counts["insight_snapshots"]={"error":
    "unhandled"}`로 흡수, 이미 처리된 publication_commands 결과까지 500으로 덮지 않는다)
    가 실제로 격리되는지 확認. 큐가 비어 있어도(=publication_commands 쪽 counts가
    전부 0) 증명 대상은 동일하다 — 이 테스트가 재는 것은 "명령 처리 로직 자체의
    정확성"(그건 이 파일의 다른 테스트들이 이미 잰다)이 아니라 "인사이트 축 예외가
    응답 딕셔너리·상태코드를 오염시키는가"이므로."""
    import app.routers.cron as cron_module
    import app.services.insight_snapshots as insight_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    async def _boom(*args, **kwargs):
        raise RuntimeError("insight snapshot boom(테스트 주입)")

    monkeypatch.setattr(insight_module, "process_due_insight_snapshots", _boom)

    engine, Session = await _session_factory()
    try:
        async def _worker_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_worker_db] = _worker_db
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r = await client.post(
                "/api/v2/internal/cron/publication-commands",
                headers={"Authorization": "Bearer test-cron-secret"},
            )
        assert r.status_code == 200, r.text
        body = r.json()["data"]
        assert body["insight_snapshots"] == {"error": "unhandled"}
        assert body["completed"] == 0 and body["error"] == 0, (
            "insight_snapshots 축 예외가 publication_commands 카운트 필드까지 오염시켰다"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
