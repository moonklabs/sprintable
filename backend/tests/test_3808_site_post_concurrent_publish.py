"""story #3808(Phase3·3-3 PR2, 페드루 PO 追加 지적 2026-09-11 21:11Z — 카디르 QA
실측 2번째) — `site_posts.py::publish_site_post_external_command`도 channel_posts.py
와 같은 하드코딩 클래스였다: 동시 발행 경합 IntegrityError 판정이 옛 제약 이름
`uq_channel_publications_gate_version`을 문자열로 물고 있어, `channel_publications`
UNIQUE 제약이 `uq_channel_publications_gate_version_sequence`로 바뀌면서(이 PR)
그 판정이 항상 `raise`로 떨어졌다 — #3395/PR#3752가 site_post 경로엔 애초에 커버리지가
없어 안 걸렸을 뿐, channel_posts.py와 똑같이 동시 발행 2건이 500으로 재발할 자리였다.
처방은 channel_posts.py와 동형(모델 상수 `UQ_GATE_VERSION_SEQUENCE_CONSTRAINT_NAME`
재사용) — 이 파일은 site_post 경로 전용 격리 재현."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _client_for,
    _create_and_submit_site_post_draft,
    _seed_agent,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _seed_wordpress_connection,
    _session_factory,
    _setup_org_scoped_app,
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
async def test_true_concurrent_site_post_publish_no_500_single_channel_publication_row(live_wordpress_stub):
    """⭐AC — channel_posts.py의 test_true_concurrent_publish_requests_no_500_
    single_provider_call과 동형(diff PR2 처방 前 head에서 RED 직접 재현 확認,
    뮤테이션 셀프체크로도 재확認). 같은 (gate_id, version_id)를 가리키는 두
    PublicationCommand 처리를 barrier로 강제 동시화 — 둘 다 예외 없이 끝나고
    ChannelPublication 행이 정확히 1개만 남아야 한다."""
    import asyncio as _asyncio
    from unittest.mock import AsyncMock, patch
    from sqlalchemy import select
    import app.services.site_posts as sp
    from app.models.publication_command import PublicationCommand
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            _human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url=live_wordpress_stub)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()
            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            command_id = command.id

        arrived = _asyncio.Event()
        arrived_count = 0

        async def _barrier_call_blog_module_publish(*args, **kwargs):
            nonlocal arrived_count
            arrived_count += 1
            if arrived_count >= 2:
                arrived.set()
            await arrived.wait()  # 둘 다 여기서 겹쳐야 INSERT 직전 경합이 실제로 재현된다.
            return f"ext-{uuid.uuid4().hex[:8]}", "https://sandbox.invalid/wp/post"

        with patch.object(sp, "_call_blog_module_publish", AsyncMock(side_effect=_barrier_call_blog_module_publish)):
            async def _run_once():
                async with Session() as s:
                    cmd = (await s.execute(
                        select(PublicationCommand).where(PublicationCommand.id == command_id)
                    )).scalar_one()
                    await sp.publish_site_post_external_command(s, cmd)
                    await s.commit()  # commit은 호출자 몫(함수 docstring 하단 주석 그대로).

            results = await _asyncio.gather(_run_once(), _run_once(), return_exceptions=True)
        exceptions = [r for r in results if isinstance(r, Exception)]
        assert exceptions == [], f"동시 발행 요청 중 예외 발생(500류 재발): {exceptions}"

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication

            rows = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalars().all()
        assert len(rows) == 1, f"ChannelPublication 행이 정확히 1개여야 하는데 {len(rows)}개"
        assert rows[0].status == "published"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
