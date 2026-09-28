"""story #4262 — 발송 게이트 단건 응답(`GET /gates/{id}`)의 `newsletter_send_command`(PO 13:39Z 조건 넷).

- 그 게이트에 묶인 이 조직의 발송 명령 중 가장 최근 1(생성 시각 내림차순). 다른 조직 · 다른 게이트 명령은 섞이지 않는다.
- 뉴스레터 게이트가 아니면 null · 명령이 없으면 null(응답 계약은 추가만).
- 목록(`GET /gates`)은 싣지 않는다 — 발행 명령 테이블을 아예 읽지 않는다(게이트마다 조회하는 N+1 0).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3475_publishing_metrics import _client_for, _seed_human, _setup_org_scoped_app
from tests.test_3806_ads_boost_gate import _seed_publication
from tests.test_3813_newsletter_calendar_and_approval_card import _seed_newsletter_send_gate
from tests.test_e4fc29fa_site_post_orchestration import _seed_default_role, _seed_org, _session_factory
from tests.test_f8f7cb0f_channel_post_publish import _seed_connection as _seed_oauth_connection
from tests.test_f8f7cb0f_channel_post_publish import _seed_story

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
    import app.services.channel_credential_crypto as crypto_module

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


def _command(*, org_id, gate_id, status, created_at, requester, failure_kind=None, reason_code=None):
    from app.models.publication_command import PublicationCommand

    return PublicationCommand(
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=uuid.uuid4(), approved_version=uuid.uuid4(),
        content_kind="newsletter_send", status=status, requested_by_member_id=requester, created_at=created_at,
        failure_kind=failure_kind, reason_code=reason_code,
    )


async def _world(Session):
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        human_id = await _seed_human(s, org_id, role="owner")
        connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")
        story_id = await _seed_story(s, org_id, project_id)
        pub, work_item_id = await _seed_publication(
            s, org_id=org_id, connection_id=connection_id, channel="stibee_sandbox", work_item_id=story_id,
        )
        gate = await _seed_newsletter_send_gate(
            s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id, status="approved", resolver_id=human_id,
        )
    return {"org_id": org_id, "project_id": project_id, "human_id": human_id, "gate": gate, "story_id": story_id}


@pytest.mark.anyio
async def test_the_newsletter_gate_carries_its_latest_send_command_from_its_own_org_only():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        now = datetime.now(timezone.utc)
        async with Session() as s:
            other_org, _ = await _seed_org(s)
            latest = _command(
                org_id=w["org_id"], gate_id=w["gate"].id, status="dead_letter", created_at=now,
                requester=w["human_id"], failure_kind="needs_check", reason_code="STIBEE_SEND_FAILED",
            )
            s.add_all([
                _command(org_id=w["org_id"], gate_id=w["gate"].id, status="completed", created_at=now - timedelta(hours=1),
                         requester=w["human_id"]),
                latest,
                # 다른 조직 · 다른 게이트의 더 새 명령 — 섞이면 안 된다.
                _command(org_id=other_org, gate_id=w["gate"].id, status="blocked", created_at=now + timedelta(minutes=5),
                         requester=w["human_id"]),
                _command(org_id=w["org_id"], gate_id=uuid.uuid4(), status="blocked", created_at=now + timedelta(minutes=5),
                         requester=w["human_id"]),
            ])
            await s.commit()

        _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["human_id"], agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/gates/{w['gate'].id}")
        assert r.status_code == 200, r.text
        assert r.json()["newsletter_send_command"] == {
            "id": str(latest.id), "status": "dead_letter", "failure_kind": "needs_check", "reason_code": "STIBEE_SEND_FAILED",
            "next_attempt_at": None, "reason_reset_at": None,
            # story #4290 — 재시도 엔드포인트와 같은 한 판정(`human_retryable`) · dead_letter라 참.
            "command_retryable": True,
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_command_or_a_non_newsletter_gate_gives_null():
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        async with Session() as s:
            other_gate = Gate(
                id=uuid.uuid4(), org_id=w["org_id"], work_item_id=w["story_id"], work_item_type="story",
                gate_type="external_publish", status="pending",
            )
            s.add(other_gate)
            s.add(_command(org_id=w["org_id"], gate_id=other_gate.id, status="dead_letter",
                           created_at=datetime.now(timezone.utc), requester=w["human_id"]))
            await s.commit()

        _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["human_id"], agent=False)
        async with _client_for(app) as client:
            newsletter = await client.get(f"/api/v2/gates/{w['gate'].id}")
            other = await client.get(f"/api/v2/gates/{other_gate.id}")
        assert newsletter.status_code == 200 and newsletter.json()["newsletter_send_command"] is None
        assert other.status_code == 200 and other.json()["newsletter_send_command"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_gate_list_never_reads_publication_commands():
    """PO 13:39Z 조건 1 — 목록은 이 필드를 싣지 않는다. 목록 요청 동안 발행 명령 테이블을 읽는 SQL이 0이고, 항목의 값은 null."""
    from sqlalchemy import event

    from app.main import app

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        async with Session() as s:
            s.add(_command(org_id=w["org_id"], gate_id=w["gate"].id, status="dead_letter",
                           created_at=datetime.now(timezone.utc), requester=w["human_id"]))
            await s.commit()

        statements: list[str] = []

        def _capture(_conn, _cursor, statement, *_args):
            statements.append(statement)

        _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["human_id"], agent=False)
        event.listen(engine.sync_engine, "before_cursor_execute", _capture)
        try:
            async with _client_for(app) as client:
                r = await client.get("/api/v2/gates")
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _capture)
        assert r.status_code == 200, r.text
        assert statements, "목록 요청의 SQL을 하나도 못 잡았다(하네스가 다른 엔진을 쓰는지 확인)"
        assert not [q for q in statements if "publication_commands" in q]
        body = r.json()
        items = body if isinstance(body, list) else body.get("items") or body.get("gates") or []
        mine = [g for g in items if g["id"] == str(w["gate"].id)]
        assert mine and mine[0].get("newsletter_send_command") is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
