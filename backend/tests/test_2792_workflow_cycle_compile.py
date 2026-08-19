"""story #2792(2790 P1) — 레시피→사이클형 event_definitions 컴파일(0260) + 슬롯 가드①
(stage_metadata⊆stage.enum) realdb 검증. DB env 없으면 skip(alembic-fresh CI 잡에서 실행)."""
from __future__ import annotations

import os

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

_EXPECTED_KEYS = {
    "preset.workflow.scrum_3step", "preset.workflow.kanban_simple",
    "preset.workflow.agent_solo", "preset.workflow.loop_agency",
    "preset.workflow.solo", "preset.workflow.two_step",
    "preset.workflow.three_step", "preset.workflow.kanban",
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_all_8_recipes_compiled_with_valid_schema_and_stage_metadata():
    """builtin 4 + DB 4 = 8건 전부 컴파일됐고, 각 정의의 payload_schema/stage_metadata가
    실제 레지스트리 검증기(validate_event_payload_schema_shape·validate_stage_metadata)를
    통과한다 — 컴파일 데이터가 우리가 방금 만든 가드①을 스스로 지키는지 자기증명."""
    from app.services.event_definition_registry import (
        validate_event_payload_schema_shape, validate_stage_metadata,
    )

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            rows = (await s.execute(text(
                "SELECT key, name, payload_schema, stage_metadata, org_id, enabled "
                "FROM event_definitions WHERE key LIKE 'preset.workflow.%' ORDER BY key"
            ))).all()

        found_keys = {r[0] for r in rows}
        assert found_keys == _EXPECTED_KEYS, f"missing/extra: {_EXPECTED_KEYS ^ found_keys}"

        for key, name, schema, stage_metadata, org_id, enabled in rows:
            assert org_id is None, f"{key}: preset이면 org_id NULL이어야 함"
            assert enabled is True
            assert name  # NOT NULL + 비어있지 않음
            validate_event_payload_schema_shape(schema)
            validate_stage_metadata(schema, stage_metadata)
            # 가드① 자기증명 핵심 — enum과 stage_metadata가 정확히 1:1(고아 슬러그 0, 커버 안 된
            # stage 0).
            enum = set(schema["properties"]["stage"]["enum"])
            assert set(stage_metadata.keys()) == enum, f"{key}: stage_metadata↔enum 불일치"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_solo_and_solo_are_distinct_no_key_collision():
    """⭐발견(컴파일 중) — builtin "solo"가 DB "solo"에 슬러그 충돌로 그림자 처리돼 지금까지
    한 번도 recipes[0]로도, 목록 어디로도 노출된 적이 없었다. 컴파일 후엔 별개 키
    (agent_solo/solo)로 둘 다 도달 가능해야 한다 — 이 회귀가 다시 하나로 합쳐지면 안 됨."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            rows = (await s.execute(text(
                "SELECT key, stage_metadata FROM event_definitions "
                "WHERE key IN ('preset.workflow.solo', 'preset.workflow.agent_solo')"
            ))).all()
        by_key = dict(rows)
        assert set(by_key) == {"preset.workflow.solo", "preset.workflow.agent_solo"}
        # 내용도 실제로 다르다(DB="Worker"/담당자 배정, builtin="Agent"/이벤트 수신 후 컨텍스트 파악).
        assert by_key["preset.workflow.solo"]["assign_step_1"]["role"] == "Worker"
        assert by_key["preset.workflow.agent_solo"]["received"]["role"] == "Agent"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_stage_metadata_guard_rejects_corrupted_real_compiled_data():
    """⭐가드①의 실물 회귀 테스트 — 실제로 컴파일된 scrum_3step 정의를 가져와 stage_metadata에
    존재하지 않는 slug를 하나 섞으면(오타 재현) validate_stage_metadata가 거부해야 한다."""
    from app.services.event_definition_registry import (
        InvalidStageMetadataError, validate_stage_metadata,
    )

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            row = (await s.execute(text(
                "SELECT payload_schema, stage_metadata FROM event_definitions "
                "WHERE key = 'preset.workflow.scrum_3step'"
            ))).first()
        schema, stage_metadata = row
        corrupted = dict(stage_metadata)
        corrupted["qa_reviw"] = {"role": "QA", "action": "오타 슬러그"}  # 실제 enum엔 "qa_review"
        with pytest.raises(InvalidStageMetadataError):
            validate_stage_metadata(schema, corrupted)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_event_definition_api_rejects_stage_metadata_key_not_in_enum():
    """API 종단 — POST /definitions가 stage_metadata 키 오타를 400으로 거부(가드① 실 엔드포인트
    집행 확인, registry 단위테스트와 별개 축). org_members 시드는 test_2636_custom_event_
    registration.py의 검증된 패턴 재사용(user_id FK 없음 — 별도 users 행 불요)."""
    import uuid as uuid_mod

    from fastapi import HTTPException

    from app.dependencies.auth import AuthContext
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        org_id = uuid_mod.uuid4()
        user_id = uuid_mod.uuid4()
        slug = f"smorg{org_id.hex[:8]}"
        async with Session() as s:
            s.add(Organization(id=org_id, name="StageMetaOrg", slug=slug))
            s.add(OrgMember(id=uuid_mod.uuid4(), org_id=org_id, user_id=user_id, role="owner"))
            await s.commit()

        auth = AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))
        body = CreateEventDefinitionRequest(
            key=f"org.{slug}.custom_cycle",
            name="테스트 사이클",
            payload_schema={
                "type": "object", "additionalProperties": False,
                "required": ["stage"],
                "properties": {"stage": {"type": "string", "enum": ["a", "b"]}},
            },
            routing={
                "escalation": {"kind": "server_derived", "target": "none"},
                "broadcast": {"kind": "server_derived", "target": "none"},
            },
            stage_metadata={"typo_stage": {"role": "X", "action": "Y"}},  # "a"/"b"에 없음
        )
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await create_event_definition(body, db=s, auth=auth, org_id=org_id)
        assert exc.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_update_event_definition_api_rejects_payload_schema_shrink_that_orphans_stage_metadata():
    """⭐카디르군 QA 커버리지 갭 지적(2026-08-19) — PATCH가 payload_schema만 줄이고
    stage_metadata는 안 건드리면, 기존 메타의 일부 키가 새 enum 밖으로 밀려나(고아) 조용히
    저장될 뻔한 케이스. registry 단위테스트(validate_stage_metadata 직접 호출)와 별개로
    실제 `update_event_definition` 엔드포인트 호출로 400을 실증한다."""
    import uuid as uuid_mod

    from fastapi import HTTPException

    from app.dependencies.auth import AuthContext
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.routers.events import (
        CreateEventDefinitionRequest, UpdateEventDefinitionRequest,
        create_event_definition, update_event_definition,
    )

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        org_id = uuid_mod.uuid4()
        user_id = uuid_mod.uuid4()
        slug = f"orphorg{org_id.hex[:8]}"
        async with Session() as s:
            s.add(Organization(id=org_id, name="OrphanOrg", slug=slug))
            s.add(OrgMember(id=uuid_mod.uuid4(), org_id=org_id, user_id=user_id, role="owner"))
            await s.commit()

        auth = AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))
        create_body = CreateEventDefinitionRequest(
            key=f"org.{slug}.custom_cycle",
            name="테스트 사이클",
            payload_schema={
                "type": "object", "additionalProperties": False,
                "required": ["stage"],
                "properties": {"stage": {"type": "string", "enum": ["a", "b"]}},
            },
            routing={
                "escalation": {"kind": "server_derived", "target": "none"},
                "broadcast": {"kind": "server_derived", "target": "none"},
            },
            stage_metadata={"a": {"role": "X", "action": "Y"}, "b": {"role": "Z", "action": "W"}},
        )
        async with Session() as s:
            created = await create_event_definition(create_body, db=s, auth=auth, org_id=org_id)

        # payload_schema만 줄여 "b"를 enum에서 뺀다 — stage_metadata는 건드리지 않음(여전히 a·b 둘 다).
        shrink_body = UpdateEventDefinitionRequest(
            payload_schema={
                "type": "object", "additionalProperties": False,
                "required": ["stage"],
                "properties": {"stage": {"type": "string", "enum": ["a"]}},
            },
        )
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await update_event_definition(
                    uuid_mod.UUID(created.id), shrink_body, db=s, auth=auth, org_id=org_id,
                )
        assert exc.value.status_code == 400
    finally:
        await engine.dispose()
