"""story #4336 AC4(PO 라이브 03:55Z) — 외부 발행 게이트 단건 응답(`GET /gates/{id}`)의 발행 상태와 «마지막 수정 주체».

- `publish_command`: 이 게이트 id로 만든 이 조직의 채널 · 사이트 발행 명령(operation publish) 중 가장 최근 1. 다른 조직 · 다른 게이트 ·
  다른 종류(뉴스레터 발송) · 내리기 명령은 섞이지 않는다. `processing_kind`는 채널 초안 목록 · 상세와 같은 `derive_processing_kind`.
- 외부 발행 게이트가 아니거나 명령이 없으면 null. 목록은 싣지 않는다(발행 명령 테이블을 읽지 않음 · N+1 0).
- `latest_author_kind`: 예전엔 목록에서만 · 사이트 초안 버전만 봐서 채널 초안 게이트 · 단건 상세가 늘 null(«마지막 수정 주체 · —»).
  이제 단건 · 목록 둘 다, 채널 초안도 그 초안의 최신 버전 author_kind.
"""
from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3475_publishing_metrics import _client_for, _seed_human, _setup_org_scoped_app
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


def _command(*, org_id, gate_id, status, created_at, requester, content_kind="channel_post", operation="publish",
             failure_kind=None, reason_code=None, scheduled_at=None):
    from app.models.publication_command import PublicationCommand

    return PublicationCommand(
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=uuid.uuid4(), approved_version=uuid.uuid4(),
        content_kind=content_kind, operation=operation, status=status, requested_by_member_id=requester, created_at=created_at,
        failure_kind=failure_kind, reason_code=reason_code, scheduled_at=scheduled_at,
    )


async def _world(Session):
    """조직 · 사람(owner) · 채널 연결 · 스토리 · 채널 초안(버전 1 agent → 버전 2 human) · 그 초안을 가리키는 외부 발행 게이트(approved)."""
    from app.models.channel_post_draft import ChannelPostDraft
    from app.models.channel_post_version import ChannelPostVersion
    from app.models.gate import Gate

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        human_id = await _seed_human(s, org_id, role="owner")
        connection_id = await _seed_oauth_connection(s, org_id, channel="threads")
        story_id = await _seed_story(s, org_id, project_id)
        draft = ChannelPostDraft(id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, channel="threads", connection_id=connection_id)
        s.add(draft)
        await s.commit()
        for version, kind in ((1, "agent"), (2, "human")):
            body = f"본문 {version}"
            s.add(ChannelPostVersion(
                id=uuid.uuid4(), draft_id=draft.id, version=version, text=body,
                body_sha256=hashlib.sha256(body.encode()).hexdigest(), author_member_id=human_id, author_kind=kind,
            ))
        gate = Gate(
            id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story", gate_type="external_publish",
            status="approved", scope_key=str(connection_id), neutral_facts={"draft_id": str(draft.id)},
        )
        s.add(gate)
        await s.commit()
    return {"org_id": org_id, "human_id": human_id, "gate": gate, "story_id": story_id, "draft_id": draft.id}


async def _get_gate(app, Session, w, gate_id):
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["human_id"], agent=False)
    async with _client_for(app) as client:
        r = await client.get(f"/api/v2/gates/{gate_id}")
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.anyio
async def test_the_publish_gate_carries_its_latest_publish_command_only():
    """가장 최근 채널 발행 명령(대기 · 예약 없음 · 실패 없음)이 실리고 processing_kind = publishing(목록 · 상세와 같은 판정).
    더 새것이어도 다른 조직 · 다른 게이트 · 뉴스레터 발송 · 내리기 명령은 섞이지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        now = datetime.now(timezone.utc)
        async with Session() as s:
            other_org, _ = await _seed_org(s)
            latest = _command(org_id=w["org_id"], gate_id=w["gate"].id, status="pending", created_at=now, requester=w["human_id"])
            later = now + timedelta(minutes=5)
            s.add_all([
                _command(org_id=w["org_id"], gate_id=w["gate"].id, status="dead_letter", created_at=now - timedelta(hours=1),
                         requester=w["human_id"], failure_kind="needs_check"),
                latest,
                _command(org_id=other_org, gate_id=w["gate"].id, status="completed", created_at=later, requester=w["human_id"]),
                _command(org_id=w["org_id"], gate_id=uuid.uuid4(), status="completed", created_at=later, requester=w["human_id"]),
                _command(org_id=w["org_id"], gate_id=w["gate"].id, status="completed", created_at=later, requester=w["human_id"],
                         content_kind="newsletter_send"),
                _command(org_id=w["org_id"], gate_id=w["gate"].id, status="completed", created_at=later, requester=w["human_id"],
                         operation="unpublish"),
            ])
            await s.commit()
        body = await _get_gate(app, Session, w, w["gate"].id)
        assert body["publish_command"] == {
            "id": str(latest.id), "status": "pending", "failure_kind": None, "reason_code": None,
            "next_attempt_at": None, "reason_reset_at": None, "command_retryable": False, "processing_kind": "publishing",
        }
        assert body["newsletter_send_command"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status", "kwargs", "processing_kind", "retryable"),
    [
        ("completed", {}, None, False),
        ("dead_letter", {"failure_kind": "needs_check"}, None, True),
        # 재시도 대기(실패 있음) → «발행 중» 아님(실패 배지가 맡음).
        ("pending", {"failure_kind": "transient"}, None, False),
        # 예약 발행 대기 → «발행 중» 아님.
        ("pending", {"scheduled_at": datetime.now(timezone.utc) + timedelta(days=1)}, None, False),
        # 워커 예산 밖 → «발행 중»이라 말하지 않음.
        ("pending", {"reason_code": "WORKER_TICK_BUDGET_TOO_SMALL"}, None, False),
        ("in_progress", {}, "publishing", False),
    ],
)
async def test_processing_kind_and_retry_follow_the_shared_rules(status, kwargs, processing_kind, retryable):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        async with Session() as s:
            s.add(_command(org_id=w["org_id"], gate_id=w["gate"].id, status=status, created_at=datetime.now(timezone.utc),
                           requester=w["human_id"], **kwargs))
            await s.commit()
        cmd = (await _get_gate(app, Session, w, w["gate"].id))["publish_command"]
        assert (cmd["status"], cmd["processing_kind"], cmd["command_retryable"]) == (status, processing_kind, retryable)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_command_or_a_non_publish_gate_gives_null():
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        async with Session() as s:
            other_gate = Gate(id=uuid.uuid4(), org_id=w["org_id"], work_item_id=w["story_id"], work_item_type="story",
                              gate_type="ads_boost", status="pending")
            s.add(other_gate)
            s.add(_command(org_id=w["org_id"], gate_id=other_gate.id, status="dead_letter",
                           created_at=datetime.now(timezone.utc), requester=w["human_id"], content_kind="ads_boost"))
            await s.commit()
        assert (await _get_gate(app, Session, w, w["gate"].id))["publish_command"] is None
        assert (await _get_gate(app, Session, w, other_gate.id))["publish_command"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_latest_author_kind_of_a_channel_draft_gate_in_detail_and_list():
    """«마지막 수정 주체» — 채널 초안의 최신 버전(2 · human). 예전: 단건은 늘 null · 목록은 사이트 버전만 봐서 null. 목록은 여전히
    발행 명령을 읽지 않는다."""
    from sqlalchemy import event

    from app.main import app

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        assert (await _get_gate(app, Session, w, w["gate"].id))["latest_author_kind"] == "human"

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
        body = r.json()
        items = body if isinstance(body, list) else body.get("items") or body.get("gates") or []
        mine = [g for g in items if g["id"] == str(w["gate"].id)]
        assert mine and mine[0]["latest_author_kind"] == "human"
        assert mine[0].get("publish_command") is None
        assert statements and not [q for q in statements if "publication_commands" in q]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
