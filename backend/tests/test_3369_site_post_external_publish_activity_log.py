"""story #3369 후속(자기점검 2차, 유나 실측·페드루 지시 2026-09-10) — 외부 목적지
(WordPress·webhook) site_post 발행 경로(`site_posts.py::publish_site_post_external_
command`, 워커가 호출)는 `activity_logs`에 `site_post_published`를 한 번도 남기지
않고 있었다. hosted_site 동기 경로(`publish_site_post_from_draft`)는 매 호출마다
이 액션을 남기는데, 이 워커 경로는 e4fc29fa③c로 나중에 별도 구현이 추가되면서 그
기록이 안 옮겨왔다(channel_post는 즉시/예약 두 경로가 `publish_channel_post_draft`
하나를 공유해 이 종류의 드리프트가 원천적으로 없다 — site_post만 걸린 결함).

세팅 헬퍼는 test_3474_publication_attempts.py::_seed_and_approve와 동형(그 파일이
이미 test_e4fc29fa_site_post_orchestration.py에서 중복 재발명 금지로 재사용한 것을
한 번 더 재사용)."""
from __future__ import annotations

import os

import pytest

from tests.test_3474_publication_attempts import _seed_and_approve
from tests.test_e4fc29fa_site_post_orchestration import (
    live_wordpress_stub,  # noqa: F401 — pytest fixture import
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
async def test_external_publish_records_site_post_published_activity_log(live_wordpress_stub):
    """뮤테이션 대상: site_posts.py::publish_site_post_external_command의 신규
    ActivityLogService.record(action="site_post_published", ...) 호출을 지우면 이
    테스트가 RED가 되어야 한다(행이 0개)."""
    from sqlalchemy import select

    from app.models.activity_log import ActivityLog
    from app.models.channel_publication import ChannelPublication
    from app.services.publication_command import process_due_publication_commands

    engine, Session, app, org_id, _draft_id, gate_id, human_id = await _seed_and_approve(
        live_wordpress_stub_url=live_wordpress_stub,
    )
    try:
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            logs = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.org_id == org_id, ActivityLog.action == "site_post_published",
                )
            )).scalars().all()
            pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalar_one()

        assert len(logs) == 1, "외부 목적지 발행도 hosted_site와 동형으로 감사 행을 남겨야 한다"
        log = logs[0]
        assert log.actor_type == "platform"
        assert log.entity_type == "channel_publication"
        assert log.entity_id == pub.id
        assert log.context["gate_id"] == str(gate_id)
        assert log.context["requested_by_member_id"] == str(human_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
