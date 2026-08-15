"""story #2675 — publish_registry_event가 payload의 malformed UUID 문자열(예: work_item_id=
"pr-3084")을 400이 아니라 처리 안 된 500으로 뱉던 결함.

카디르 실측(2026-08-15, 승격 PR #3084 QA 중): org.moonklabs.work.gate_cycle을 스토리 없는
승격 PR에 발행하려니 매핑할 스토리 UUID가 없어 그 자리에 비-UUID 문자열을 넣었더니
INTERNAL_ERROR(5xx)로 죽었다. 근본원인 그라운딩(디디, 2026-08-16 실 dev 왕복으로 재현):
event_definition_registry.validate_event_payload가 jsonschema Validator를 FormatChecker
없이 만들어서, payload_schema가 "format": "uuid"를 선언해도 실제로는 집행되지 않았다 —
비-UUID 문자열이 스키마 검증을 무사통과해 다운스트림 uuid.UUID() 파싱에서 처리 안 된
ValueError로 죽었다.

처방 2단(벨트+서스펜더):
①event_definition_registry.validate_event_payload — FormatChecker() 명시로 켜서 스키마가
  이미 선언한 format:uuid 계약을 실제로 집행(선호 경로 — 구조화된 {code,message,errors}로
  일찍 잡힘).
②event_routing_resolver._parse_uuid — org 커스텀 정의(#2636)가 format:uuid 선언을 빠뜨린
  경우까지 대비한 2차 방어선(uuid.UUID() 파싱 실패를 InvalidWorkItemReferenceError로 승격,
  라우터가 400으로 매핑).

AC 검증 축:
- AC1: work_item_id·goal_id·payload_field(notify_member_id 등) 어느 경로든 malformed UUID가
  400+명시 문구로 거부됨(5xx 아님).
- AC2 무회귀: 정상 UUID 발행은 그대로 성공(기존 test_2633_event_publish.py가 이미 고정).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _load_seed_definitions():
    import importlib.util
    import os

    spec = importlib.util.spec_from_file_location(
        "_m0245c", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0245_event_definitions.py"),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return {key: (payload_schema, routing) for key, payload_schema, routing in m._SEED}


async def _seed_preset_definitions(session):
    from app.models.event_definition import EventDefinition

    for key, (payload_schema, routing) in _load_seed_definitions().items():
        session.add(EventDefinition(
            id=uuid.uuid4(), key=key, org_id=None, payload_schema=payload_schema, routing=routing,
        ))
    await session.commit()


async def _seed_gate_cycle_definition(session, org_id):
    """org.moonklabs.work.gate_cycle 실물 스키마를 그대로 재현(카디르가 실제로 부딪힌 그
    정의) — list_event_definitions 실측 그대로, 손으로 축약하지 않는다."""
    from app.models.event_definition import EventDefinition

    payload_schema = {
        "type": "object",
        "required": ["stage", "work_item_type", "work_item_id", "notify_member_id"],
        "properties": {
            "note": {"type": ["string", "null"]},
            "stage": {"enum": [
                "pushed", "pr_opened", "ci_green", "ci_red", "qa_requested", "merged",
                "review_changes", "review_passed", "deployed",
            ], "type": "string"},
            "head_sha": {"type": ["string", "null"]},
            "pr_number": {"type": ["integer", "null"]},
            "work_item_id": {"type": "string", "format": "uuid"},
            "work_item_type": {"type": "string"},
            "notify_member_id": {"type": "string", "format": "uuid"},
        },
        "additionalProperties": False,
    }
    routing = {
        "broadcast": {"kind": "payload_field", "target": "member", "member_id_field": "notify_member_id"},
        "escalation": {"kind": "server_derived", "target": "none"},
    }
    d = EventDefinition(
        id=uuid.uuid4(), key="org.moonklabs.work.gate_cycle", org_id=org_id,
        payload_schema=payload_schema, routing=routing,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_org_project(session, *, slug="acme2675"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2675", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


# ─── AC1 핵심 — 카디르 실사고의 정확한 재현(org.moonklabs.work.gate_cycle, 승격 PR류에
#     work_item_id로 비-UUID 문자열을 넣은 경우) ────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_gate_cycle_malformed_work_item_id_400_not_500():
    """⭐AC1 핵심 — 이 테스트가 처방 전이면 HTTPException이 아니라 처리 안 된 ValueError가
    그대로 터져나온다(수정 전 상태에서 직접 확인함, #2675 grounding). 처방 후엔 400으로
    명시 거부되고, detail에 malformed 값 자체(pr-3084)가 원인 문구로 실려야 한다."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_gate_cycle_definition(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="org.moonklabs.work.gate_cycle",
                payload={
                    "stage": "pr_opened",
                    "work_item_type": "story",
                    "work_item_id": "pr-3084",  # 승격 PR — 매핑할 스토리 UUID가 없어 이렇게 넣음
                    "notify_member_id": str(uuid.uuid4()),
                    "pr_number": 3084,
                },
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(),
                    db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
            assert ei.value.status_code != 500
            detail = ei.value.detail
            detail_text = detail if isinstance(detail, str) else str(detail)
            assert "pr-3084" in detail_text or "uuid" in detail_text.lower()
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_malformed_goal_id_400_not_500():
    """work_item_id와 별개 경로(goal_id)도 같은 결함 클래스였다 — _resolve_event_project_id의
    두 번째 uuid.UUID() 호출부. 같은 처방(FormatChecker + _parse_uuid)이 이 축도 덮는지."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="preset.goal.measured",
                payload={"goal_id": "not-a-uuid", "metric_value": 1},
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(),
                    db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_malformed_payload_field_member_id_400_not_500():
    """payload_field routing(notify_member_id 등)의 malformed 값도 같은 클래스 — resolve_routing_leg
    안의 uuid.UUID() 호출부."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_gate_cycle_definition(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="org.moonklabs.work.gate_cycle",
                payload={
                    "stage": "pr_opened",
                    "work_item_type": "story",
                    "work_item_id": str(uuid.uuid4()),
                    "notify_member_id": "not-a-uuid-either",
                },
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(),
                    db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


# ─── 단위 축 — 순수 함수, DB 불요 ────────────────────────────────────────────────

def test_validate_event_payload_rejects_malformed_uuid_via_format_checker():
    """FormatChecker() 없이 만들면 이 테스트가 RED다(수정 전 상태로 직접 확인) — format:uuid가
    실제로 집행되는지 이 함수 하나로 고정."""
    from app.services.event_definition_registry import InvalidEventPayloadError, validate_event_payload

    schema = {
        "type": "object",
        "required": ["work_item_id"],
        "properties": {"work_item_id": {"type": "string", "format": "uuid"}},
        "additionalProperties": False,
    }
    with pytest.raises(InvalidEventPayloadError) as ei:
        validate_event_payload(schema, {"work_item_id": "pr-3084"})
    assert any("uuid" in e.lower() for e in ei.value.errors)


def test_validate_event_payload_accepts_valid_uuid_no_regression():
    from app.services.event_definition_registry import validate_event_payload

    schema = {
        "type": "object",
        "required": ["work_item_id"],
        "properties": {"work_item_id": {"type": "string", "format": "uuid"}},
        "additionalProperties": False,
    }
    validate_event_payload(schema, {"work_item_id": str(uuid.uuid4())})  # raise 없으면 통과


def test_parse_uuid_raises_domain_error_for_malformed_value():
    from app.services.event_routing_resolver import InvalidWorkItemReferenceError, _parse_uuid

    with pytest.raises(InvalidWorkItemReferenceError):
        _parse_uuid("pr-3084", field_name="work_item_id")


def test_parse_uuid_passthrough_for_valid_value():
    from app.services.event_routing_resolver import _parse_uuid

    val = str(uuid.uuid4())
    assert str(_parse_uuid(val, field_name="work_item_id")) == val


@pytest.mark.anyio
async def test_resolve_routing_leg_payload_field_malformed_uuid_raises_domain_error():
    """resolve_routing_leg 자체를 직접 호출(엔드포인트 레벨에선 대개 스키마 검증에 먼저
    걸리므로) — 해석기 함수 단독 계약을 독립 검증."""
    from unittest.mock import AsyncMock

    from app.services.event_routing_resolver import InvalidWorkItemReferenceError, resolve_routing_leg

    with pytest.raises(InvalidWorkItemReferenceError):
        await resolve_routing_leg(
            {"kind": "payload_field", "target": "member", "member_id_field": "notify_member_id"},
            payload={"notify_member_id": "pr-3084"},
            org_id=uuid.uuid4(), db=AsyncMock(),
        )
