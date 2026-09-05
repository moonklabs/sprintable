"""story #3525(결함·FE/BE, 페드루 PO 確定 2026-09-06, 유나 §22-12) — 발행 済 draft에
새 버전이 생겨도 조회 뷰의 `publication_id`는 «마지막 발행»(published_pub, 버전
무관)을 계속 가리켜야 한다. 이전엔 `latest_pub`(현재 최신 버전에 매칭되는 것만)에서
와 새 버전이 아직 발행 前이면 null이 돼 상세 화면이 밖에 살아 있는 게시물의 댓글·
인사이트를 감췄다(표본 draft 2220797b, 배포 33).

세팅 헬퍼는 test_3403_channel_post_draft_detail.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_3403_channel_post_draft_detail import (
    _approve_gate_directly, _client_for, _seed_agent, _seed_connection, _seed_default_role,
    _seed_human, _seed_org, _seed_story, _seed_submit_approve, _session_factory, _setup_org_scoped_app,
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
async def test_new_version_after_publish_keeps_publication_id_pointing_at_last_published():
    """AC1 — v2 생성 뒤 목록·단건 GET 둘 다: publication_id는 v1 발행 그대로(버전
    무관)·current_version=2·gate_status=pending이 동시에 성립. published_at/
    permalink/external_id도 함께 살아남는다(같은 published_pub 객체라 구조적으로
    같이 간다 — 처방의 핵심)."""
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

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _seed_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with (
            patch.object(tp, "create_container", AsyncMock(return_value="creation-1")),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-1")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-1")),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_publish.status_code == 200, r_publish.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_before = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert r_before.status_code == 200, r_before.text
            before = r_before.json()
            assert before["publication_id"] is not None
            assert before["published_at"] is not None
            publication_id_after_v1 = before["publication_id"]

            # story #3525 재현 — 같은 work_item+connection에 새 draft 생성 요청을
            # 다시 보내면(create_channel_post_draft_version의 upsert 분기) 기존
            # draft에 v2가 추가된다. submit은 호출 안 함(실측 재현 그대로).
            r_v2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "버전 2 본문"},
            )
            assert r_v2.status_code == 201, r_v2.text
            assert r_v2.json()["draft_id"] == draft_id, "같은 draft에 버전만 추가돼야 함(신규 draft 아님)"
            assert r_v2.json()["version"] == 2

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")

        assert r_detail.status_code == 200, r_detail.text
        detail = r_detail.json()
        list_row = next(it for it in r_list.json() if it["draft_id"] == draft_id)

        for label, body in (("detail", detail), ("list", list_row)):
            assert body["current_version"] == 2, label
            assert body["gate_status"] == "pending", label
            assert body["reapproval_required"] is True, label
            # 처방의 핵심 — publication_id가 v1 발행 그대로(null로 안 떨어짐).
            assert body["publication_id"] == publication_id_after_v1, label
            assert body["published_at"] is not None, label
            assert body["permalink"] == "https://www.threads.net/@demo/post/media-1", label
            assert body["external_id"] == "media-1", label
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
