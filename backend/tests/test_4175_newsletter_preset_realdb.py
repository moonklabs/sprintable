"""story #4175(E-RECIPE-2) — «뉴스레터» 프리셋(preset.marketing.newsletter, 0398 시드).

- 등록 검증: 시드 값이 정의 등록 때 거치는 검증(key·payload_schema·routing·block_template·stage_metadata·
  role_actor_kinds)을 그대로 통과한다.
- AC2 멘션 자기설명: 단계마다 다음 발행 도구(publish_event)와 payload 예시. 발송 단계(send_requested)로 넘기는
  예시엔 newsletter_send 게이트 봉인 필드 3개와 그 설명이 실린다(봉인 필드 주입을 빼면 RED).
- 발송 단계 이벤트 → newsletter_send 게이트(봉인 세그먼트·시각, story #4191 경로).
- AC3: 발송 승인 없이는 Stibee 발송 호출 0 — 실 stibee 채널(샌드박스는 어댑터를 아예 안 타 무의미)에서
  승인 전 발송 명령을 워커에 태워도 reserve_email 0회·차단, 사람이 승인하면 1회(양성 대조).

세팅은 test_4191_recipe_newsletter_send_realdb.py·test_3813_newsletter_send_gate.py 하네스를 그대로 쓴다.
create_all DB엔 시드가 없어 0398 모듈의 값으로 같은 행을 넣는다(test_4085 관례)."""
from __future__ import annotations

import importlib.util
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import select, text

from tests.recipe_stage_walk import prepare_stage_publish
from tests.test_3312_approve_stage_gate_auto_creation import _auth, _fake_request, _seed_story
from tests.test_3475_publishing_metrics import _seed_human
from tests.test_3497_insight_snapshots import _seed_channel_connection
from tests.test_3806_ads_boost_gate import _approve_gate, _seed_publication
from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _seed_default_role, _seed_org, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


def _load_migration():
    path = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0398_preset_marketing_newsletter_recipe.py")
    spec = importlib.util.spec_from_file_location("_m0398_4175", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG = _load_migration()
_KEY = _MIG._KEY


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
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


async def _ensure_preset(Session):
    """0398 upgrade()와 같은 INSERT(ON CONFLICT DO NOTHING) — alembic head DB면 이미 있어 no-op."""
    import json

    async with Session() as s:
        await s.execute(
            text(
                "INSERT INTO event_definitions "
                "(id, key, org_id, name, description, payload_schema, routing, block_template, "
                " stage_metadata, role_actor_kinds, enabled, version) "
                "VALUES (:id, :key, NULL, :name, :description, CAST(:ps AS jsonb), CAST(:r AS jsonb), "
                " CAST(:bt AS jsonb), CAST(:sm AS jsonb), CAST(:rak AS jsonb), true, 1) ON CONFLICT DO NOTHING"
            ),
            {
                "id": str(uuid.uuid4()), "key": _KEY, "name": _MIG._NAME, "description": _MIG._DESCRIPTION,
                "ps": json.dumps(_MIG._PAYLOAD_SCHEMA), "r": json.dumps(_MIG._ROUTING),
                "bt": json.dumps(_MIG._BLOCK_TEMPLATE), "sm": json.dumps(_MIG._STAGE_METADATA),
                "rak": json.dumps(_MIG._ROLE_ACTOR_KINDS),
            },
        )
        await s.commit()
        from app.models.event_definition import EventDefinition

        return (await s.execute(
            select(EventDefinition).where(EventDefinition.key == _KEY, EventDefinition.org_id.is_(None))
        )).scalar_one()


# ── 등록 검증(DB 불요) ────────────────────────────────────────────────────────────


def test_seed_passes_registration_validation():
    from app.services import event_definition_registry as reg

    reg.validate_event_definition_key(_KEY, org_id=None, org_slug=None)
    reg.validate_event_payload_schema_shape(_MIG._PAYLOAD_SCHEMA)
    reg.validate_event_routing(_MIG._ROUTING)
    reg.validate_block_template(_MIG._BLOCK_TEMPLATE)
    reg.validate_block_template_refs(_MIG._PAYLOAD_SCHEMA, _MIG._BLOCK_TEMPLATE)
    reg.validate_stage_metadata(_MIG._PAYLOAD_SCHEMA, _MIG._STAGE_METADATA)
    reg.validate_role_actor_kinds(_MIG._STAGE_METADATA, _MIG._ROLE_ACTOR_KINDS)


def test_send_stage_gate_fields_are_open_in_payload_schema():
    """payload_schema가 additionalProperties=false라 봉인 필드가 스키마에 없으면 발송 단계 발행 자체가
    invalid_payload로 막힌다 — 봉인 필드 SSOT와 스키마가 어긋나지 않게."""
    from app.services.recipe_gate_hooks import _GATE_TYPE_SEALED_FIELDS

    gate_type = _MIG._STAGE_METADATA["send_requested"]["gate"]["type"]
    for spec in _GATE_TYPE_SEALED_FIELDS[gate_type]:
        assert spec.name in _MIG._PAYLOAD_SCHEMA["properties"], spec.name


def test_review_approval_auto_publishes_into_campaign_created_stage():
    """유나 design(PR #4554) — 캠페인 생성 단계 슬러그를 영상의 `published`에서 `campaign_created`로 갈랐다(라벨
    «발행»이 발송 승인 앞에서 «이미 나갔다»로 읽혔다). 레시피 자동 발행(channel_posts.publish_recipe_approved_draft)은
    슬러그가 아니라 «게이트 단계 바로 다음 단계의 capability.target»을 본다 — 그 판정 재료가 그대로인지 고정."""
    from types import SimpleNamespace

    from app.routers.events import _next_recipe_stage

    definition = SimpleNamespace(key=_KEY, payload_schema=_MIG._PAYLOAD_SCHEMA, stage_metadata=_MIG._STAGE_METADATA)
    nxt = _next_recipe_stage(definition, "review")
    assert nxt == "campaign_created"
    assert _MIG._STAGE_METADATA[nxt]["capability"]["target"] == "channel_connection"
    assert "published" not in _MIG._STAGE_SLUGS  # 라벨 «발행»(=나감)과 섞이지 않게


# ── AC2 멘션 자기설명 ────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_self_description_names_next_publish_tool_and_payload_at_every_stage():
    from app.routers.events import _render_event_message_content

    engine, Session = await _session_factory()
    try:
        definition = await _ensure_preset(Session)
        rendered: dict[str, str] = {}
        async with Session() as s:
            for stage in _MIG._STAGE_SLUGS:
                rendered[stage] = await _render_event_message_content(
                    s, org_id=uuid.uuid4(), definition=definition,
                    payload={"stage": stage, "work_item_type": "story", "work_item_id": str(uuid.uuid4())},
                    resolved_locale="ko",
                )

        example = f'publish_event({{"definition_key": "{_KEY}"'
        # 게이트 없는 단계 — 다음 단계와 발행 예시.
        assert "다음 단계: draft (Creator)" in rendered["collect"] and example in rendered["collect"]
        assert '"stage": "review"' in rendered["draft"] and "사람 승인 게이트가 열려요" in rendered["draft"]
        # 자기 게이트를 여는 단계 — 예시 대신 «승인 알림 뒤 다음 단계» 안내.
        for gated in ("review", "send_requested"):
            assert "지금 사람 승인 게이트가 열려 있어요" in rendered[gated]
            assert example not in rendered[gated]
        # ⭐발송 단계로 넘기는 예시 — 봉인 필드 3개와 각 설명(이게 빠지면 에이전트가 봉인 필드를 몰라 422).
        to_send = rendered["campaign_created"]
        assert '"stage": "send_requested"' in to_send
        for field in ("publication_id", "segment_name", "scheduled_at"):
            assert f'"{field}"' in to_send, field
            assert f"{field}는" in to_send or f"{field}은" in to_send, field
        assert "다음 단계: 없음(마지막 stage)" in rendered["send_checked"]
    finally:
        await engine.dispose()


# ── 발송 단계 → newsletter_send 게이트 · AC3 승인 없이는 Stibee 발송 0 ──────────────────


async def _setup_real_stibee(Session):
    from app.models.project import OrgMember

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_user_id = await _seed_human(s, org_id, role="owner")
        owner_member_id = (await s.execute(
            select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == owner_user_id)
        )).scalar_one()
        await _seed_default_role(s, org_id)
        agent_id = await _seed_agent(s, org_id, project_id)
        story_id = await _seed_story(s, org_id, project_id)
        conn = await _seed_channel_connection(s, org_id, channel="stibee")
        pub, _ = await _seed_publication(s, org_id=org_id, connection_id=conn.id, work_item_id=story_id, channel="stibee")
        pub.external_id = "9999"  # 실 reserve는 스티비 email id를 int로 캐스팅한다(3813 관례).
        s.add(pub)
        await s.commit()
    return {"org_id": org_id, "project_id": project_id, "owner_member_id": owner_member_id, "agent_id": agent_id,
            "story_id": story_id, "pub": pub, "conn_id": conn.id}


async def _publish_send_stage(Session, ctx, scheduled_at: datetime):
    from app.routers.events import EventPublishRequest, publish_registry_event

    async with Session() as s:
        await publish_registry_event(
            EventPublishRequest(definition_key=_KEY, payload={
                "stage": "send_requested", "work_item_type": "story", "work_item_id": str(ctx["story_id"]),
                "publication_id": str(ctx["pub"].id), "segment_name": "test-recipients",
                "scheduled_at": scheduled_at.isoformat(),
            }),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(ctx["agent_id"], ctx["org_id"]), org_id=ctx["org_id"],
        )
        await s.commit()


@pytest.mark.anyio
async def test_send_stage_opens_sealed_gate_and_stibee_is_not_called_until_a_person_approves(monkeypatch):
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.services.newsletter_send_execution import (
        process_due_newsletter_sends,
        process_one_newsletter_send_command,
    )
    import app.services.stibee_client as stibee_client_module

    calls: list[int] = []

    async def _fake_reserve_email(client, *, api_key, email_id, scheduled_at_utc):
        calls.append(email_id)

    monkeypatch.setattr(stibee_client_module, "reserve_email", _fake_reserve_email)

    engine, Session = await _session_factory()
    try:
        definition = await _ensure_preset(Session)
        ctx = await _setup_real_stibee(Session)
        scheduled_at = datetime.now(timezone.utc) + timedelta(hours=2)
        # story #4251 — 발송 단계는 캠페인 생성(서버 stage) 뒤 발송 단계 담당(Publisher 에이전트)이 낸다. 그 앞 상태를 깐다.
        await prepare_stage_publish(
            Session, org_id=ctx["org_id"], project_id=ctx["project_id"], definition=definition,
            work_item_id=ctx["story_id"], stage="send_requested", publisher_id=ctx["agent_id"],
        )
        await _publish_send_stage(Session, ctx, scheduled_at)

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(
                Gate.org_id == ctx["org_id"], Gate.gate_type == "newsletter_send",
            ))).scalar_one()
        assert gate.status == "pending"
        assert gate.scope_key == str(ctx["pub"].id)
        assert gate.sealed_newsletter_segment_name == "test-recipients"
        assert gate.sealed_newsletter_scheduled_at == scheduled_at
        assert gate.designated_approver_id == ctx["owner_member_id"]

        # ⭐AC3 — 승인 전(pending) 게이트에 걸린 발송 명령을 워커에 태워도 Stibee 호출 0, 차단.
        async with Session() as s:
            forged = PublicationCommand(
                id=uuid.uuid4(), org_id=ctx["org_id"], gate_id=gate.id, destination=ctx["conn_id"],
                approved_version=gate.sealed_newsletter_version_id, requested_by_member_id=ctx["owner_member_id"],
                operation="send", content_kind="newsletter_send", status="pending",
            )
            s.add(forged)
            await s.commit()
            await process_one_newsletter_send_command(s, forged, now=datetime.now(timezone.utc))
            await s.commit()
            forged_status = (await s.execute(
                select(PublicationCommand.status).where(PublicationCommand.id == forged.id)
            )).scalar_one()
        assert calls == []
        assert forged_status == "blocked_unapproved"

        # 양성 대조 — 사람이 승인하면 예약 시각에 크론이 명령을 만들고, 워커가 Stibee를 정확히 1회 부른다.
        # (크론은 같은 게이트에 send 명령이 이미 있으면 건너뛴다 — 위조 명령은 지우고 시작.)
        async with Session() as s:
            await s.execute(text("DELETE FROM publication_attempts WHERE command_id = :id"), {"id": forged.id})
            await s.execute(text("DELETE FROM publication_commands WHERE id = :id"), {"id": forged.id})
            await s.commit()
            await _approve_gate(s, gate.id, ctx["owner_member_id"])
        async with Session() as s:
            counts = await process_due_newsletter_sends(s, now=scheduled_at + timedelta(minutes=1))
        assert counts.get("queued") == 1, counts
        async with Session() as s:
            command = (await s.execute(select(PublicationCommand).where(
                PublicationCommand.gate_id == gate.id, PublicationCommand.status == "pending",
            ))).scalar_one()
            await process_one_newsletter_send_command(s, command, now=scheduled_at + timedelta(minutes=1))
            await s.commit()
        assert calls == [9999]
    finally:
        await engine.dispose()
