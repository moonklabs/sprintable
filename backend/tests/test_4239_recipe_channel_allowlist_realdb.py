"""story #4239 — 레시피 발행 stage의 허용 채널 종류(`capability.channels`).

결함: 적용 창의 발행자 «채널 선택»이 org의 active 연결 전부(Instagram·WordPress·webhook…)를 보여 줘, 뉴스레터 «캠페인 생성»에
Instagram을 묶을 수 있었다. 예약 발행은 «바인딩 연결 = 초안 연결»이라 그 잘못이 발행 실패로야 드러났다. 이제:
- 정의가 허용 채널 종류를 선언(`capability.channels` · target="channel_connection"일 때만 · 알려진 채널 키의 비어 있지 않은
  중복 없는 목록 — `validate_stage_metadata`).
- 적용 API(`apply_recipe_role_bindings`)는 허용 밖 종류의 연결 바인딩을 422로 거절(선언 없는 stage는 예전대로).
- 채널 키 목록(`channel_adapters.ALL_CHANNEL_KEYS`)은 환경과 무관한 정적 목록 — 샌드박스를 켠 등록 키와 같아야 한다.
"""
from __future__ import annotations

import os
import subprocess
import sys
import uuid

import pytest
from fastapi import HTTPException

from app.services.event_definition_registry import InvalidStageMetadataError, validate_stage_metadata
from tests.test_3288_recipe_role_bindings import (  # noqa: F401 — autouse 픽스처도 이 파일에 등록
    _auth,
    _dispose_global_engine_after_test,
    _realdb_session,
    _seed_agent,
    _seed_human_caller,
    _seed_org_project,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_realdb = [pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"), pytest.mark.anyio]

pytestmark = pytest.mark.destructive_schema

_SCHEMA = {"properties": {"stage": {"enum": ["draft", "campaign_created"]}}}


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _publish_meta(**capability) -> dict:
    return {"campaign_created": {"role": "Publisher", "action": "publish", "capability": {"kind": "publish", **capability}}}


# ─── 정의 모양(validate_stage_metadata) ─────────────────────────────────────────

def test_channels_on_a_channel_connection_stage_are_accepted():
    validate_stage_metadata(_SCHEMA, _publish_meta(target="channel_connection", channels=["stibee", "stibee_sandbox"]))


@pytest.mark.parametrize("capability", [
    {"target": "agent", "channels": ["stibee"]},                         # 채널 연결 stage가 아님
    {"channels": ["stibee"]},                                            # target 없음(기본 agent)
    {"target": "channel_connection", "channels": []},                    # 비어 있음
    {"target": "channel_connection", "channels": ["stibee", "stibee"]},  # 중복
    {"target": "channel_connection", "channels": ["mailchimp"]},         # 모르는 채널 키
    {"target": "channel_connection", "channels": "stibee"},              # 목록 아님
])
def test_malformed_channels_are_rejected(capability):
    with pytest.raises(InvalidStageMetadataError):
        validate_stage_metadata(_SCHEMA, _publish_meta(**capability))


def _with(path: str, value):
    """정의 입력 한 자리에 `value`를 넣은 (payload_schema, stage_metadata, role_actor_kinds)."""
    schema = {"properties": {"stage": {"enum": ["draft", "campaign_created"]}}}
    meta = {
        "draft": {"role": "Creator", "action": "draft", "gate": {"type": "concept_approval", "approver": "org_owner"}},
        "campaign_created": {
            "role": "Publisher", "action": "publish",
            "capability": {"kind": "publish", "target": "channel_connection", "channels": ["stibee"]},
        },
    }
    kinds = {"Creator": "agent"}
    if path == "stage_metadata":
        meta = value
    elif path == "payload_schema.properties":
        schema = {"properties": value}
    elif path == "payload_schema.properties.stage":
        schema = {"properties": {"stage": value}}
    elif path == "stage.enum":
        schema = {"properties": {"stage": {"enum": value}}}
    elif path == "stage.enum[]":
        schema = {"properties": {"stage": {"enum": ["draft", "campaign_created", value]}}}
    elif path == "gate.approver":
        meta["draft"]["gate"]["approver"] = value
    elif path == "capability.target":
        # channels 없이 — channels 검사가 target != channel_connection을 먼저 걸러 target 검사를 가리지 않게.
        meta["campaign_created"]["capability"] = {"kind": "publish", "target": value}
    elif path == "capability.channels":
        meta["campaign_created"]["capability"]["channels"] = value
    elif path == "capability.channels[]":
        meta["campaign_created"]["capability"]["channels"] = ["stibee", value]
    elif path == "role_actor_kinds.value":
        kinds = {"Creator": value}
    else:
        raise AssertionError(path)
    return schema, meta, kinds


_TYPE_FIRST_PATHS = [
    "stage_metadata", "payload_schema.properties", "payload_schema.properties.stage", "stage.enum", "stage.enum[]",
    "gate.approver", "capability.target", "capability.channels", "capability.channels[]", "role_actor_kinds.value",
]


@pytest.mark.parametrize("value", [[], {}, [{}], 1], ids=["list", "object", "list_of_object", "int"])
@pytest.mark.parametrize("path", _TYPE_FIRST_PATHS)
def test_wrong_type_anywhere_in_the_definition_is_a_validation_error_not_a_crash(path, value):
    """까디르 4598 QA P2(부류 전체) — 등록·수정 API 입력의 어느 자리에 목록·객체·숫자가 와도 검증 오류(API 400)여야 한다.
    예전엔 frozenset 멤버십·set()·`.get`이 타입 확인보다 먼저라 TypeError/AttributeError(API 500)였다."""
    from app.services.event_definition_registry import InvalidRoleActorKindsError, validate_role_actor_kinds

    schema, meta, kinds = _with(path, value)
    with pytest.raises((InvalidStageMetadataError, InvalidRoleActorKindsError)):
        validate_stage_metadata(schema, meta)
        validate_role_actor_kinds(meta, kinds)


@pytest.mark.parametrize("stage_metadata", [[], [{}], 1, "x"])
def test_role_actor_kinds_with_non_object_stage_metadata_is_a_validation_error(stage_metadata):
    """까디르 4598 QA P3 — `validate_role_actor_kinds`가 dict 아닌 stage_metadata에서 `.values()` AttributeError였다(API는
    stage_metadata 검증이 먼저라 도달 0이지만 같은 부류)."""
    from app.services.event_definition_registry import InvalidRoleActorKindsError, validate_role_actor_kinds

    with pytest.raises(InvalidRoleActorKindsError):
        validate_role_actor_kinds(stage_metadata, {"Creator": "agent"})


def test_the_type_first_fixture_itself_is_valid():
    """위 매개변수 테스트의 기준 입력은 그 자체로 통과한다 — 거부가 «넣은 값» 때문임을 보장."""
    from app.services.event_definition_registry import validate_role_actor_kinds

    schema, meta, kinds = _with("stage.enum", ["draft", "campaign_created"])
    validate_stage_metadata(schema, meta)
    validate_role_actor_kinds(meta, kinds)


def test_all_channel_keys_match_registered_adapters_with_sandbox_enabled():
    """드리프트 가드 — 샌드박스를 켜고 새 프로세스에서 import한 등록 키 == 정적 목록(어댑터를 더하면 여기 RED)."""
    code = (
        "from app.services.channel_adapters import CHANNEL_ADAPTERS, ALL_CHANNEL_KEYS;"
        "import json;print(json.dumps(sorted(set(CHANNEL_ADAPTERS) ^ set(ALL_CHANNEL_KEYS))))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], env={**os.environ, "SANDBOX_CHANNEL_ENABLED": "true"},
        capture_output=True, text=True, check=True,
    ).stdout.strip().splitlines()[-1]
    assert out == "[]"


# ─── 적용 API(apply_recipe_role_bindings) ──────────────────────────────────────

async def _seed_world(Session, channels: list[str] | None):
    from app.models.channel_connection import ChannelConnection
    from app.models.event_definition import EventDefinition

    async with Session() as s:
        org_id, project_id = await _seed_org_project(s, slug=f"org4239-{uuid.uuid4().hex[:6]}")
        caller = await _seed_human_caller(s, org_id, project_id)
        agent = await _seed_agent(s, org_id, project_id)
        capability = {"kind": "publish", "target": "channel_connection", **({"channels": channels} if channels else {})}
        definition = EventDefinition(
            id=uuid.uuid4(), key=f"org.test4239.{uuid.uuid4().hex[:6]}", org_id=org_id,
            payload_schema={"type": "object", "properties": {"stage": {"type": "string", "enum": ["draft", "campaign_created"]}}},
            routing={"escalation": {"kind": "server_derived", "target": "none"}, "broadcast": {"kind": "recipe_role_binding"}},
            stage_metadata={
                "draft": {"role": "Creator", "action": "draft"},
                "campaign_created": {"role": "Publisher", "action": "publish", "capability": capability},
            },
        )
        s.add(definition)
        connections = {}
        for channel in ("instagram", "wordpress", "stibee"):
            conn = ChannelConnection(id=uuid.uuid4(), org_id=org_id, channel=channel, account_id=f"acct-{channel}")
            s.add(conn)
            connections[channel] = conn.id
        await s.commit()
    return {"org": org_id, "project": project_id, "caller": caller, "agent": agent,
            "definition": definition.id, "connections": connections}


async def _apply(Session, w, publish_connection_id):
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    async with Session() as s:
        result = await apply_recipe_role_bindings(
            w["definition"],
            ApplyRecipeRoleBindingsRequest(
                project_id=w["project"],
                role_mapping={"draft": str(w["agent"]), "campaign_created": str(publish_connection_id)},
            ),
            db=s, auth=_auth(w["caller"], w["org"]), org_id=w["org"],
        )
        await s.commit()
        return result


@pytest.mark.parametrize("channel", ["instagram", "wordpress"])
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_rejects_a_connection_outside_the_declared_channels(channel):
    """허용 채널이 stibee뿐인 stage에 Instagram·WordPress 연결을 묶으면 422 · 바인딩 0.
    뮤테이션: 적용 API의 허용 검사를 빼면 201로 저장돼 RED(실측)."""
    from sqlalchemy import func, select

    from app.models.recipe_role_binding import RecipeRoleBinding

    engine, Session = await _realdb_session()
    try:
        w = await _seed_world(Session, ["stibee", "stibee_sandbox"])
        with pytest.raises(HTTPException) as info:
            await _apply(Session, w, w["connections"][channel])
        assert info.value.status_code == 422
        assert "not allowed" in str(info.value.detail) and channel in str(info.value.detail)
        async with Session() as fresh:
            count = (await fresh.execute(
                select(func.count()).select_from(RecipeRoleBinding).where(RecipeRoleBinding.org_id == w["org"])
            )).scalar_one()
        assert count == 0
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_accepts_an_allowed_connection():
    engine, Session = await _realdb_session()
    try:
        w = await _seed_world(Session, ["stibee", "stibee_sandbox"])
        result = await _apply(Session, w, w["connections"]["stibee"])
        assert result.bindings_upserted == 2
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_rejects_a_malformed_id_with_422_not_500():
    """까디르 4598 QA P2 — role_mapping 값이 UUID가 아니면 `uuid.UUID` ValueError(500)였다 → 422 · 바인딩 0."""
    from sqlalchemy import func, select

    from app.models.recipe_role_binding import RecipeRoleBinding

    engine, Session = await _realdb_session()
    try:
        w = await _seed_world(Session, ["stibee", "stibee_sandbox"])
        with pytest.raises(HTTPException) as info:
            await _apply(Session, w, "not-a-uuid")
        assert info.value.status_code == 422
        assert "campaign_created" in str(info.value.detail)
        async with Session() as fresh:
            count = (await fresh.execute(
                select(func.count()).select_from(RecipeRoleBinding).where(RecipeRoleBinding.org_id == w["org"])
            )).scalar_one()
        assert count == 0
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_undeclared_stage_keeps_accepting_any_channel():
    """선언 없는 stage(조직 정의 등)는 예전대로 — 어떤 채널 연결이든 받는다(회귀 0)."""
    engine, Session = await _realdb_session()
    try:
        w = await _seed_world(Session, None)
        result = await _apply(Session, w, w["connections"]["instagram"])
        assert result.bindings_upserted == 2
    finally:
        await engine.dispose()

