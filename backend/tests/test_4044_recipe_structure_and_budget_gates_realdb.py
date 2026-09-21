"""story #4044(E-RECIPE-1 ①) — 레시피 1호(«영상 제작») ⓑ구조(`structure_approval`)·ⓒ실탄
(`generation_budget`) 게이트 구축 실증(0380_recipe_video_production_structure_and_budget_
gates.py).

핵심 회귀 축(마이그 docstring의 "근본 선택" 그대로) — ⓐ`concept_approval`과 ⓑ`structure_
approval`이 gate_type을 공유하면 **같은 Story**를 지나는 두 stage 중 하나(ⓑ)의 사람 판정이
create_gate() 멱등 조회에 먹혀 조용히 스킵된다. 이 파일의 첫 realdb 테스트가 바로 그 "만약
gate_type을 공유했다면 깨졌을" 경로를 실측한다.

ⓒ 축은 `check_generation_budget_or_raise`(app/services/generation_budget.py, 기존
재사용)가 `publish_registry_event`(app/routers/events.py)까지 정확히 422로 올라오는지,
통과분은 `Gate.sealed_estimated_cost_minor`(0333, 기존 컬럼)에 봉인되고 neutral_facts에
잔여예산이 실리는지를 잰다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _load_migration_module(filename: str, alias: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        alias, os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", filename),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG = _load_migration_module("0382_recipe_video_production_structure_and_budget_gates.py", "_m0380")


# ─── 단위 축 — 등록 시점 검증기 통과(seed 자체의 계약 유효성) ────────────────────


def test_new_stage_metadata_passes_validate_stage_metadata():
    from app.services.event_definition_registry import validate_stage_metadata
    validate_stage_metadata(_MIG._NEW_PAYLOAD_SCHEMA, _MIG._NEW_STAGE_METADATA)


def test_structure_and_budget_gate_types_are_distinct_from_concept_and_each_other():
    """마이그 docstring의 "근본 선택" — gate_type 4종이 전부 서로 다른 문자열인지 고정."""
    gate_types = {
        slug: meta["gate"]["type"] for slug, meta in _MIG._NEW_STAGE_METADATA.items() if "gate" in meta
    }
    assert gate_types == {
        "concept_confirmed": "concept_approval",
        "animatic": "structure_approval",
        "structure_passed": "generation_budget",
        "pending_approval": "external_publish",
    }
    assert len(set(gate_types.values())) == 4


def test_estimated_cost_minor_is_optional_not_required():
    assert "estimated_cost_minor" not in _MIG._NEW_PAYLOAD_SCHEMA["required"]
    assert "estimated_cost_minor" in _MIG._NEW_PAYLOAD_SCHEMA["properties"]


# ─── 실행 축(realdb) ────────────────────────────────────────────────────────────


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


async def _seed_definition(session):
    """0379+0380 누적 결과(=현행)와 동일 내용을 ORM으로 재현(마이그=정본 관례)."""
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_MIG._KEY, org_id=None, name="영상 제작(릴스·쇼츠)",
        payload_schema=_MIG._NEW_PAYLOAD_SCHEMA,
        routing={
            "escalation": {"kind": "server_derived", "target": "none"},
            "broadcast": {"kind": "recipe_role_binding"},
        },
        stage_metadata=_MIG._NEW_STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d


# story #4070 — 이 로컬 정의가 OrgMember만 심고 매칭 TeamMember 미러가 없어
# dispatch_approval_request_cards가 org_owner를 참가자로 넣으려다 FK 위반을 내던 하네스
# 갭(try/except로 삼켜져 assertion은 안 걸리지만 매번 트레이스백 노이즈) — 공용
# conftest.seed_org_with_human_owner(스키마 형상 무관 SSOT, #4083의 반대편 증상과 함께
# 통합)로 교체.
from tests.conftest import seed_org_with_human_owner as _seed_org_with_owner


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember
    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="레시피 1호 산출물"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


async def test_concept_and_structure_gates_stay_independent_on_same_story():
    """⭐핵심 회귀 — ⓐ컨셉 게이트를 approve한 뒤에도 ⓑ구조 게이트는 그 승인을 재사용하지
    않고 **별개의 pending 게이트**로 새로 선다(gate_type을 공유했다면 이 assert가 깨진다:
    ⓑ가 이미 approved인 ⓐ의 슬롯을 멱등 재조회해 pending 게이트가 하나도 안 생겼을 것)."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.gate import Gate, set_gate_status
    from sqlalchemy import select
    from datetime import datetime, timezone

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner(s, slug="r4044a")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)

            await publish_registry_event(
                EventPublishRequest(
                    definition_key=_MIG._KEY,
                    payload={"stage": "concept_confirmed", "work_item_type": "story", "work_item_id": str(story_id)},
                ),
                BackgroundTasks(), _fake_request(), db=s, auth=_auth(agent_id, org_id), org_id=org_id,
            )
            concept_gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "concept_approval")
            )).scalar_one()
            # story #4058(②③ 정합) — gates/[id] evidence 필터 접점: 게이트가 자기
            # stage를 neutral_facts에 denorm으로 싣는다(recipe_gate_hooks.py).
            assert concept_gate.neutral_facts["stage"] == "concept_confirmed"
            set_gate_status(concept_gate, "approved", now=datetime.now(timezone.utc))
            concept_gate.resolver_id = owner_member_id
            await s.commit()

            await publish_registry_event(
                EventPublishRequest(
                    definition_key=_MIG._KEY,
                    payload={"stage": "animatic", "work_item_type": "story", "work_item_id": str(story_id)},
                ),
                BackgroundTasks(), _fake_request(), db=s, auth=_auth(agent_id, org_id), org_id=org_id,
            )
            structure_gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "structure_approval")
            )).scalars().all()
            assert len(structure_gates) == 1
            assert structure_gates[0].status == "pending"
            assert structure_gates[0].designated_approver_id == owner_member_id
            assert structure_gates[0].neutral_facts["stage"] == "animatic"

            # concept 게이트는 그대로 approved로 남아있다(구조 게이트가 그걸 건드리지 않음).
            reloaded_concept = (await s.execute(
                select(Gate).where(Gate.id == concept_gate.id)
            )).scalar_one()
            assert reloaded_concept.status == "approved"
    finally:
        await engine.dispose()


async def test_generation_budget_gate_seals_cost_and_surfaces_remaining_budget():
    """AC1 — 편당 예상 비용이 gate.sealed_estimated_cost_minor에 봉인되고, org에 예산
    정책이 있으면 neutral_facts에 limit/spent/remaining이 실물로 뜬다."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.content_rules import put_org_content_rules
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner(s, slug="r4044b")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            await put_org_content_rules(
                s, org_id=org_id,
                rules={"generation_budget": {"limit_minor": 100_000, "currency": "KRW", "period": "month"}},
                expected_version=0, updated_by_member_id=None,
            )

            await publish_registry_event(
                EventPublishRequest(
                    definition_key=_MIG._KEY,
                    payload={
                        "stage": "structure_passed", "work_item_type": "story", "work_item_id": str(story_id),
                        "estimated_cost_minor": 5_000,
                    },
                ),
                BackgroundTasks(), _fake_request(), db=s, auth=_auth(agent_id, org_id), org_id=org_id,
            )

            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "generation_budget")
            )).scalar_one()
            assert gate.status == "pending"
            assert gate.designated_approver_id == owner_member_id
            assert gate.sealed_estimated_cost_minor == 5_000
            facts = gate.neutral_facts
            assert facts["estimated_cost_minor"] == 5_000
            assert facts["budget_limit_minor"] == 100_000
            assert facts["budget_spent_minor"] == 0
            assert facts["budget_remaining_minor"] == 100_000
            # story #4072(카디르 QA③) — FE가 formatMinorCurrency로 라벨을 붙이려면
            # 통화가 neutral_facts에 있어야 한다(org 정책 KRW|USD, currency 지어내지
            # 않는다 원칙). 이 테스트는 currency를 안 넘겼으니 GenerationBudgetRule
            # 기본값(KRW)이 그대로 echo돼야 한다.
            assert facts["currency"] == "KRW"
    finally:
        await engine.dispose()


async def test_generation_budget_gate_rejects_over_budget_estimate_with_422_before_creating_gate():
    """AC1 핵심 — 잔량을 넘는 추정치는 게이트를 만들지 않고 422 GENERATION_BUDGET_EXCEEDED로
    거부한다(channel_posts.py 제출경로와 동일 계약 재사용)."""
    from fastapi import HTTPException
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.content_rules import put_org_content_rules
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_with_owner(s, slug="r4044c")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)
            await put_org_content_rules(
                s, org_id=org_id,
                rules={"generation_budget": {"limit_minor": 1_000, "currency": "KRW", "period": "month"}},
                expected_version=0, updated_by_member_id=None,
            )

            with pytest.raises(HTTPException) as exc_info:
                await publish_registry_event(
                    EventPublishRequest(
                        definition_key=_MIG._KEY,
                        payload={
                            "stage": "structure_passed", "work_item_type": "story", "work_item_id": str(story_id),
                            "estimated_cost_minor": 5_000,
                        },
                    ),
                    BackgroundTasks(), _fake_request(), db=s, auth=_auth(agent_id, org_id), org_id=org_id,
                )
            assert exc_info.value.status_code == 422
            assert exc_info.value.detail["code"] == "GENERATION_BUDGET_EXCEEDED"
            assert exc_info.value.detail["remaining_minor"] == 1_000

            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "generation_budget")
            )).scalars().all()
            assert gates == []
    finally:
        await engine.dispose()


async def test_generation_budget_gate_without_estimate_rejected_422_no_gate_created():
    """⛔story #4085(리허설 1호 실측, PO 확定 2026-09-21)로 계약이 뒤집힌 자리 — 옛 테스트
    (`test_generation_budget_gate_without_estimate_still_creates_gate_unsealed`)는 "숫자
    없는 예산 게이트도 정상"을 회귀 0으로 고정하고 있었는데, 그게 정확히 리허설이 실측한
    버그였다(결재 카드에 예상 비용이 안 뜸). "숫자 없는 예산 게이트는 게이트가 아니다"(PO
    확定) — estimated_cost_minor 없이 structure_passed를 발행하면 게이트를 만들지 않고
    422 GATE_SEALED_FIELD_MISSING으로 거부한다."""
    from fastapi import HTTPException
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_with_owner(s, slug="r4044d")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)

            with pytest.raises(HTTPException) as exc_info:
                await publish_registry_event(
                    EventPublishRequest(
                        definition_key=_MIG._KEY,
                        payload={
                            "stage": "structure_passed", "work_item_type": "story", "work_item_id": str(story_id),
                        },
                    ),
                    BackgroundTasks(), _fake_request(), db=s, auth=_auth(agent_id, org_id), org_id=org_id,
                )
            assert exc_info.value.status_code == 422
            assert exc_info.value.detail["code"] == "GATE_SEALED_FIELD_MISSING"
            assert exc_info.value.detail["gate_type"] == "generation_budget"
            assert exc_info.value.detail["missing_fields"] == ["estimated_cost_minor"]
            assert "estimated_cost_minor" in exc_info.value.detail["message"]

            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "generation_budget")
            )).scalars().all()
            assert gates == []
    finally:
        await engine.dispose()


async def test_generation_budget_gate_wrong_type_estimate_rejected_422():
    """형식 방어 — bool은 int의 서브클래스라 payload_schema(`type: integer|null`)의
    상위 계층 검증(400)을 그냥 통과해 버릴 수 있다(JSON Schema draft 자체는 boolean을
    거부하지만 이 레포 검증기 실측이 우선) — `maybe_create_stage_gate`를 직접 호출해
    그 내부 방어(isinstance(v, int) and not isinstance(v, bool))가 단독으로도 막는지
    확認한다(#4044의 기존 방어와 동형 판단, 새 갈래 0). 문자열류는 payload_schema가
    이미 400으로 더 앞에서 막아(실측 확認) 이 내부 방어까지 안 옴 — 그 갈래는 스코프 밖."""
    from app.services.recipe_gate_hooks import MissingGateSealedFieldError, maybe_create_stage_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_with_owner(s, slug="r4044e")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            definition = await _seed_definition(s)

            with pytest.raises(MissingGateSealedFieldError) as exc_info:
                await maybe_create_stage_gate(
                    s, org_id=org_id, definition=definition,
                    payload={
                        "stage": "structure_passed", "work_item_type": "story", "work_item_id": str(story_id),
                        "estimated_cost_minor": True,
                    },
                    requester_member_id=agent_id,
                )
            assert exc_info.value.gate_type == "generation_budget"
            assert exc_info.value.missing_fields == ["estimated_cost_minor"]
    finally:
        await engine.dispose()


async def test_generation_budget_gate_negative_estimate_rejected_422():
    """⭐PO 리뷰 정정(#4085, PR 코멘트 5755879285) — 음수(-1)는 isinstance(int)만으로는
    안 걸러진다(bool도 아니고 진짜 int라서). SealedFieldSpec.min_value(기본 0) 검사가
    없으면 음수 예상 비용이 그대로 sealed_estimated_cost_minor에 봉인될 수 있었다."""
    from fastapi import HTTPException
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_with_owner(s, slug="r4044f")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)

            with pytest.raises(HTTPException) as exc_info:
                await publish_registry_event(
                    EventPublishRequest(
                        definition_key=_MIG._KEY,
                        payload={
                            "stage": "structure_passed", "work_item_type": "story", "work_item_id": str(story_id),
                            "estimated_cost_minor": -1,
                        },
                    ),
                    BackgroundTasks(), _fake_request(), db=s, auth=_auth(agent_id, org_id), org_id=org_id,
                )
            assert exc_info.value.status_code == 422
            assert exc_info.value.detail["code"] == "GATE_SEALED_FIELD_MISSING"
            assert exc_info.value.detail["missing_fields"] == ["estimated_cost_minor"]

            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "generation_budget")
            )).scalars().all()
            assert gates == []
    finally:
        await engine.dispose()
