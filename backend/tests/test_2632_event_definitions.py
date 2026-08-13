"""story #2632(이벤트 레지스트리 P1a) — event_definitions 스키마 + 프리셋 시드 4종.

doc event-registry-core-p1-plan §2-1·§2-5. 검증 축:
- AC1: 마이그레이션+모델+시드 4종이 실PG에서 정확(스키마 검증 왕복).
- AC2: 네임스페이스 규칙 서버 강제 — preset.*는 org_id 없을 때만, org.{slug}.*는 호출자
  자신의 org slug와 정확히 일치할 때만(타 org 도용 차단). model.py의 CHECK는 "모양"만
  보는 방어선이라 별도(부분 unique index·app 레이어 검증기 둘 다 실측).
- AC3: payload_schema 검증이 모르는 필드를 거부한다(양성·음성).
"""
from __future__ import annotations

import uuid

import pytest

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


async def _seed_org(session, *, slug="acme"):
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name="Org2632", slug=slug)
    session.add(org)
    await session.commit()
    return org.id


# ─── AC1: 마이그레이션+모델+시드 4종 ────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_seed_four_presets_exist_with_valid_schema_roundtrip():
    from sqlalchemy import select
    from app.models.event_definition import EventDefinition
    from app.services.event_definition_registry import validate_event_payload, validate_event_routing

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            # create_all은 CHECK/부분-unique-index까지 모델 metadata에서 재구축(Index·
            # CheckConstraint가 __table_args__에 선언돼 있으므로) — 마이그레이션과 별개로
            # ORM 경로에서도 시드를 직접 심어 model.py 자체의 정합을 확인한다(마이그레이션
            # 실행 자체의 검증은 별도로 `alembic upgrade head` 실측, PR 본문 기재).
            #
            # 이 테스트는 create_all 스키마라 마이그레이션 시드가 없다 — 마이그레이션 파일의
            # _SEED 리터럴을 직접 import해 "그 시드가 실제로 유효한 payload_schema인지"만
            # 이 프로세스에서 검증한다(마이그레이션 실행 자체는 alembic upgrade head가 검증).
            import importlib.util
            import os
            spec = importlib.util.spec_from_file_location(
                "_m0245", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0245_event_definitions.py"),
            )
            m0245 = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m0245)

            assert len(m0245._SEED) == 4
            keys = {row[0] for row in m0245._SEED}
            assert keys == {
                "preset.gate.verdict", "preset.work.status_changed",
                "preset.work.assigned", "preset.goal.measured",
            }

            for key, payload_schema, routing in m0245._SEED:
                assert payload_schema.get("additionalProperties") is False, key
                assert isinstance(routing, dict) and "escalation" in routing and "broadcast" in routing, key
                validate_event_routing(routing)  # 두 부류 계약(payload_field/server_derived) 준수

                ed = EventDefinition(
                    id=uuid.uuid4(), key=key, org_id=None,
                    payload_schema=payload_schema, routing=routing,
                )
                s.add(ed)
            await s.commit()

            rows = (await s.execute(select(EventDefinition))).scalars().all()
            assert len(rows) == 4
    finally:
        await engine.dispose()


# ─── AC2: 네임스페이스 강제 — DB 제약(모양) ────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_check_constraint_rejects_preset_key_with_org_id():
    from sqlalchemy.exc import IntegrityError
    from app.models.event_definition import EventDefinition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            s.add(EventDefinition(
                id=uuid.uuid4(), key="preset.gate.verdict", org_id=org_id,
                payload_schema={"type": "object"}, routing={},
            ))
            with pytest.raises(IntegrityError):
                await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_check_constraint_rejects_org_prefixed_key_with_null_org_id():
    from sqlalchemy.exc import IntegrityError
    from app.models.event_definition import EventDefinition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            s.add(EventDefinition(
                id=uuid.uuid4(), key="org.acme.custom_event", org_id=None,
                payload_schema={"type": "object"}, routing={},
            ))
            with pytest.raises(IntegrityError):
                await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_partial_unique_index_scopes_key_uniqueness_by_org():
    """preset key는 전역 유일(org 무관 재사용 불가) · org 커스텀 key는 org별 독립(다른
    org가 같은 key를 써도 충돌 없음)."""
    from sqlalchemy.exc import IntegrityError
    from app.models.event_definition import EventDefinition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_a = await _seed_org(s, slug="acme")
            org_b = await _seed_org(s, slug="globex")

            s.add(EventDefinition(
                id=uuid.uuid4(), key="org.acme.deploy_finished", org_id=org_a,
                payload_schema={"type": "object"}, routing={},
            ))
            s.add(EventDefinition(
                id=uuid.uuid4(), key="org.globex.deploy_finished", org_id=org_b,
                payload_schema={"type": "object"}, routing={},
            ))
            await s.commit()  # 다른 org의 같은-모양 key는 충돌 없음

            s.add(EventDefinition(
                id=uuid.uuid4(), key="org.acme.deploy_finished", org_id=org_a,
                payload_schema={"type": "object"}, routing={},
            ))
            with pytest.raises(IntegrityError):
                await s.commit()  # 같은 org 안 중복 key는 거부
    finally:
        await engine.dispose()


# ─── AC2: 네임스페이스 강제 — app 레이어(진짜 게이트, cross-org 도용 차단) ────────────

def test_validate_key_accepts_preset_with_null_org():
    from app.services.event_definition_registry import validate_event_definition_key

    validate_event_definition_key("preset.gate.verdict", org_id=None, org_slug=None)


def test_validate_key_rejects_preset_prefix_with_org_id():
    from app.services.event_definition_registry import (
        InvalidEventDefinitionKeyError, validate_event_definition_key,
    )

    with pytest.raises(InvalidEventDefinitionKeyError):
        validate_event_definition_key(
            "preset.gate.verdict", org_id=uuid.uuid4(), org_slug="acme",
        )


def test_validate_key_accepts_org_key_matching_own_slug():
    from app.services.event_definition_registry import validate_event_definition_key

    validate_event_definition_key(
        "org.acme.deploy_finished", org_id=uuid.uuid4(), org_slug="acme",
    )


def test_validate_key_rejects_org_key_with_mismatched_slug():
    """cross-org 네임스페이스 도용 차단 — CHECK 제약이 못 잡는 축(진짜 강제 지점)."""
    from app.services.event_definition_registry import (
        InvalidEventDefinitionKeyError, validate_event_definition_key,
    )

    with pytest.raises(InvalidEventDefinitionKeyError):
        validate_event_definition_key(
            "org.globex.deploy_finished", org_id=uuid.uuid4(), org_slug="acme",
        )


def test_validate_key_fails_closed_when_org_id_present_but_slug_missing():
    from app.services.event_definition_registry import (
        InvalidEventDefinitionKeyError, validate_event_definition_key,
    )

    with pytest.raises(InvalidEventDefinitionKeyError):
        validate_event_definition_key(
            "org.acme.deploy_finished", org_id=uuid.uuid4(), org_slug=None,
        )


# ─── AC3: payload_schema 검증 — 모르는 필드 거부(양성·음성) ────────────────────────

def test_validate_payload_accepts_conforming_payload():
    from app.services.event_definition_registry import validate_event_payload

    schema = {
        "type": "object", "additionalProperties": False,
        "required": ["a"], "properties": {"a": {"type": "string"}},
    }
    validate_event_payload(schema, {"a": "ok"})  # raise 없으면 통과


def test_validate_payload_rejects_unknown_field():
    from app.services.event_definition_registry import InvalidEventPayloadError, validate_event_payload

    schema = {
        "type": "object", "additionalProperties": False,
        "required": ["a"], "properties": {"a": {"type": "string"}},
    }
    with pytest.raises(InvalidEventPayloadError) as ei:
        validate_event_payload(schema, {"a": "ok", "unexpected_field": "sneaky"})
    assert ei.value.errors


def test_validate_payload_rejects_missing_required_field():
    from app.services.event_definition_registry import InvalidEventPayloadError, validate_event_payload

    schema = {
        "type": "object", "additionalProperties": False,
        "required": ["a"], "properties": {"a": {"type": "string"}},
    }
    with pytest.raises(InvalidEventPayloadError):
        validate_event_payload(schema, {})


def test_validate_payload_rejects_wrong_type():
    from app.services.event_definition_registry import InvalidEventPayloadError, validate_event_payload

    schema = {
        "type": "object", "additionalProperties": False,
        "required": ["a"], "properties": {"a": {"type": "string"}},
    }
    with pytest.raises(InvalidEventPayloadError):
        validate_event_payload(schema, {"a": 123})


@pytest.mark.parametrize("key,payload,valid", [
    ("preset.gate.verdict", {
        "work_item_type": "story", "work_item_id": str(uuid.uuid4()),
        "gate_type": "merge", "verdict": "approved",
    }, True),
    ("preset.gate.verdict", {
        "work_item_type": "story", "work_item_id": str(uuid.uuid4()),
        "gate_type": "merge", "verdict": "approved", "extra": "nope",
    }, False),
    ("preset.work.assigned", {
        "work_item_type": "story", "work_item_id": str(uuid.uuid4()),
        "assignee_member_id": str(uuid.uuid4()),
    }, True),
    ("preset.goal.measured", {"goal_id": str(uuid.uuid4()), "metric_value": 42.5}, True),
    ("preset.goal.measured", {"goal_id": str(uuid.uuid4())}, False),  # metric_value 누락
])
def test_seed_schemas_validate_realistic_payloads(key, payload, valid):
    """마이그레이션 시드 스키마 4종 실물이 realistic payload에 대해 올바르게 판정하는지."""
    import importlib.util
    import os

    from app.services.event_definition_registry import InvalidEventPayloadError, validate_event_payload

    spec = importlib.util.spec_from_file_location(
        "_m0245b", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0245_event_definitions.py"),
    )
    m0245 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m0245)
    schema_by_key = {row[0]: row[1] for row in m0245._SEED}

    if valid:
        validate_event_payload(schema_by_key[key], payload)
    else:
        with pytest.raises(InvalidEventPayloadError):
            validate_event_payload(schema_by_key[key], payload)


# ─── routing 두 부류 계약(payload_field/server_derived, 페드루 판정 2026-08-13) ───────

def test_routing_payload_field_requires_member_id_field():
    from app.services.event_definition_registry import InvalidEventRoutingError, validate_event_routing

    routing = {
        "escalation": {"kind": "payload_field", "target": "assignee"},  # member_id_field 누락
        "broadcast": {"kind": "server_derived", "target": "none"},
    }
    with pytest.raises(InvalidEventRoutingError):
        validate_event_routing(routing)


def test_routing_payload_field_with_member_id_field_valid():
    from app.services.event_definition_registry import validate_event_routing

    routing = {
        "escalation": {
            "kind": "payload_field", "target": "assignee", "member_id_field": "assignee_member_id",
        },
        "broadcast": {"kind": "server_derived", "target": "work_item_stakeholders"},
    }
    validate_event_routing(routing)


def test_routing_server_derived_rejects_member_id_field():
    from app.services.event_definition_registry import InvalidEventRoutingError, validate_event_routing

    routing = {
        "escalation": {"kind": "server_derived", "target": "none", "member_id_field": "oops"},
        "broadcast": {"kind": "server_derived", "target": "none"},
    }
    with pytest.raises(InvalidEventRoutingError):
        validate_event_routing(routing)


def test_routing_server_derived_rejects_target_outside_closed_vocabulary():
    from app.services.event_definition_registry import InvalidEventRoutingError, validate_event_routing

    routing = {
        "escalation": {"kind": "server_derived", "target": "none"},
        "broadcast": {"kind": "server_derived", "target": "made_up_target"},
    }
    with pytest.raises(InvalidEventRoutingError):
        validate_event_routing(routing)


def test_routing_org_custom_rejects_server_derived_kind():
    """story #2636(org 커스텀 등록)은 allow_server_derived=False로 호출해야 — 서버가 모르는
    파생 역할을 등록하게 두면 안 된다."""
    from app.services.event_definition_registry import InvalidEventRoutingError, validate_event_routing

    routing = {
        "escalation": {"kind": "server_derived", "target": "none"},
        "broadcast": {
            "kind": "payload_field", "target": "custom", "member_id_field": "owner_member_id",
        },
    }
    with pytest.raises(InvalidEventRoutingError):
        validate_event_routing(routing, allow_server_derived=False)


def test_routing_missing_leg_rejected():
    from app.services.event_definition_registry import InvalidEventRoutingError, validate_event_routing

    with pytest.raises(InvalidEventRoutingError):
        validate_event_routing({"escalation": {"kind": "server_derived", "target": "none"}})
