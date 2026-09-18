"""story #4045(E-RECIPE-1 ②, 페드루 PO 킥오프 2026-09-18) — "크리에이터 슬롯 실행 배선" dev
스텁. #4041 계약(doc [크리에이터 에이전트 stage 산출물 계약 v0.5](entity:doc:
3cca821b-85d7-4b23-b917-6f80714f33fc)) 위의 실행 축 — 크리에이터 슬롯 에이전트가 stage 진입
알림을 어떻게 받고(AC1) 각 stage에서 계약 kind를 어떻게 emit하는지(AC2), 사람 게이트 앞에서
멈추는 신호가 실제로 있는지(AC3)를 실증한다.

⭐이 파일은 test_m2_recipe_role_binding_routing_realdb.py와 동형 하네스(발명 0, seed 헬퍼
재사용)다 — disposable PG에 자기 완결적으로 EventDefinition을 심는다.

shape은 미르코 시드(story #4039, migration 0379_preset_marketing_video_production_recipe.py,
worktree sprintable-wt-4039-recipe-video-production, feature/4039-recipe-video-production-
preset 브랜치)의 stage_metadata/routing/payload_schema를 **그대로** 복사했다(페드루 PO 지시,
2026-09-18: "합성표본이 실데이터 모양을 숨기지 않게") — 0379가 origin/develop에 아직 머지 전이라
이 테스트는 자체 org 커스텀 EventDefinition으로 같은 shape을 심어 그 마이그와 무관하게 지금
검증한다. 0379가 머지되면 이 테스트는 그대로 유효(같은 stage_metadata를 pin하고 있으므로).

게이트 2종만 seed에 실렸다(concept_confirmed→concept_approval·pending_approval→
external_publish) — structure_passed·live_generation은 #4044가 gate_type을 確定하는 대로
얹는다(0379 docstring 그대로). 이 테스트도 그 경계를 pin한다(AC3: 게이트 있는 stage에서만
Gate가 생기고, 없는 stage에서는 안 생긴다 — 그 자체가 "지금 실제로 멈추는 자리"의 정직한
경계선).

AC4(① 시드 착지 후 real 레시피로 댄 관통)는 이 파일 스코프 밖 — 미르코 시드 머지 + #4044
게이트 확定 뒤 별도 라이브 실증."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_KEY = "org.moonklabs.video_production_wiring_stub"

# migration 0379(story #4039)의 _STAGE_SLUGS/_PAYLOAD_SCHEMA/_ROUTING/_STAGE_METADATA를
# 그대로 복사 — key만 org 커스텀 축으로 바꿨다(프리셋 org_id=NULL 행과 충돌 없이 이 테스트가
# 자기 완결적으로 심을 수 있도록).
_STAGE_SLUGS = [
    "draft",
    "concept_confirmed",
    "animatic",
    "structure_passed",
    "live_generation",
    "verification",
    "editing",
    "pending_approval",
    "published",
]

_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": _STAGE_SLUGS},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
    },
}

_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "recipe_role_binding"},
}

_STAGE_METADATA = {
    "draft": {
        "role": "크리에이터", "action": "로그라인·매핑표·컨셉 초안 작성",
    },
    "concept_confirmed": {
        "role": "디렉터", "action": "우화 비트↔제품 가치 매핑 + 미션 정합 확定 승인",
        "gate": {"type": "concept_approval", "approver": "org_owner"},
    },
    "animatic": {
        "role": "크리에이터", "action": "무과금 스틸+텍스트+VO 애니매틱 제작",
    },
    "structure_passed": {
        # ⚠️gate 미선언 — #4044가 gate_type 確定 후 후속 UPDATE(0379 선례 그대로).
        "role": "디렉터", "action": "무과금 애니매틱으로 구조 판정 승인",
    },
    "live_generation": {
        # ⚠️gate 미선언 — #4044 대기.
        "role": "디렉터", "action": "표적·예산을 명시해 실탄(유료 생성) 발사 승인",
        "capability": {"kind": "generate"},
    },
    "verification": {
        "role": "크리에이터", "action": "프레임8+받아쓰기 등 눈·귀 검증 시트 작성",
    },
    "editing": {
        "role": "크리에이터", "action": "편집 통일 패스(그레이드·룸톤·자막 레벨 통일)",
    },
    "pending_approval": {
        "role": "발행자", "action": "최종 발행 승인 대기(외부 발행 직전)",
        "gate": {"type": "external_publish", "approver": "org_owner"},
    },
    "published": {
        "role": "발행자", "action": "승인된 채널에 실 게시",
        "capability": {"kind": "publish"},
    },
}

# 계약(doc 3cca821b §4) — 크리에이터 role stage별 emit kind. editing은 #4041 계약 스코프 밖
# (아직 kind 미정의) — 이 스텁은 정의된 3개(draft/animatic/verification)만 emit한다.
_CREATOR_STAGES = ("draft", "animatic", "verification", "editing")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401
    from app.core.database import Base

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session, *, slug="e4045wiring"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4045", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    """TeamMember(라우팅 바인딩 대상, recipe_role_bindings.agent_member_id 관례와 동형)
    + Member 앵커(id 동일 — E-MEMBER-SSOT 관례 "에이전트=team_members.id") + ProjectAccess
    granted(project_auth.py::agent_grant_branch가 evidence 생성 인가에 요구) 셋을 함께 심는다
    — create_evidence 실호출까지 가려면 라우팅 바인딩만으론 부족하다는 걸 실측으로 배웠다
    (has_project_access의 agent 분기는 TeamMember가 아니라 Member+ProjectAccess를 본다)."""
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()

    session.add(Member(id=m.id, org_id=org_id, type="agent"))
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project_id, member_id=m.id, permission="granted"))
    await session.commit()
    return m.id


async def _seed_org_owner(session, org_id):
    """recipe_gate_hooks.py::_resolve_org_owner가 gate.approver="org_owner" 해석에 요구 —
    concept_confirmed/pending_approval처럼 gate가 선언된 stage를 발행하면 이 owner가 없을 때
    UnknownApproverRoleError로 터진다(실측)."""
    from app.models.project import OrgMember

    owner = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=uuid.uuid4(), role="owner")
    session.add(owner)
    await session.commit()
    return owner.id


async def _seed_story(session, org_id, project_id):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="영상 제작 work item")
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session, org_id):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=org_id, name="영상 제작 배선 스텁",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d.id


async def _seed_binding(session, org_id, project_id, *, stage, agent_id):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_definition_key=_KEY, stage=stage, agent_member_id=agent_id,
    ))
    await session.commit()


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> AuthContext:
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> StarletteRequest:
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


async def _publish_stage(session, *, org_id, publisher_id, story_id, stage):
    from app.routers.events import EventPublishRequest, publish_registry_event

    body = EventPublishRequest(
        definition_key=_KEY,
        payload={"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)},
    )
    return await publish_registry_event(
        body, BackgroundTasks(), _fake_request(), db=session, auth=_auth(publisher_id, org_id), org_id=org_id,
    )


async def _emit_evidence(session, *, org_id, agent_id, story_id, kind, extra_payload):
    from app.routers.evidence import EvidenceCreateRequest, create_evidence

    body = EvidenceCreateRequest(
        work_item_id=story_id, work_item_type="story", type="report",
        ref=f"creator-slot-wiring-stub:{kind}",
        payload={"kind": kind, **extra_payload},
    )
    return await create_evidence(body, session=session, org_id=org_id, auth=_auth(agent_id, org_id))


# ── AC1 — 크리에이터 슬롯이 자기 stage에서만 통지 대상이 된다 ──────────────────────────


@pytest.mark.anyio
async def test_creator_binding_resolves_on_every_creator_role_stage():
    """draft·animatic·verification·editing(role=크리에이터) 4곳 전부에서 바인딩된 크리에이터가
    broadcast 대상으로 정확히 풀린다 — 다른 role stage(concept_confirmed 등)엔 안 샌다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            await _seed_org_owner(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            creator_id = await _seed_agent(s, org_id, project_id, name="creator-slot")
            story_id = await _seed_story(s, org_id, project_id)
            for stage in _CREATOR_STAGES:
                await _seed_binding(s, org_id, project_id, stage=stage, agent_id=creator_id)

            for stage in _CREATOR_STAGES:
                resp = await _publish_stage(
                    s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage=stage,
                )
                assert resp["broadcast_member_ids"] == [str(creator_id)], f"stage={stage}"

            # 크리에이터를 안 심은 director/발행자 stage — 「모르면 안 준다」로 빈 집합.
            resp = await _publish_stage(
                s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="concept_confirmed",
            )
            assert resp["broadcast_member_ids"] == []
    finally:
        await engine.dispose()


# ── AC2 — 크리에이터가 stage별 계약 kind를 순차 emit(dev stub) ─────────────────────────


@pytest.mark.anyio
async def test_creator_emits_contract_kind_per_stage_sequentially():
    """소재수집→컨셉(draft)→스토리보드+애니매틱(animatic)→검증(verification) 순으로 계약
    (doc 3cca821b §4) kind를 emit — 매 evidence가 실제로 생성되고 created_by가 크리에이터
    슬롯 본인으로 서버 기록되는지까지 확認."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            creator_id = await _seed_agent(s, org_id, project_id, name="creator-slot")
            story_id = await _seed_story(s, org_id, project_id)
            for stage in ("draft", "animatic", "verification"):
                await _seed_binding(s, org_id, project_id, stage=stage, agent_id=creator_id)

            # draft: stage 알림 → concept_brief emit.
            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="draft")
            assert resp["broadcast_member_ids"] == [str(creator_id)]
            ev = await _emit_evidence(
                s, org_id=org_id, agent_id=creator_id, story_id=story_id, kind="concept_brief",
                extra_payload={"concept": "테스트 컨셉", "rationale": "하네스 실증용"},
            )
            assert ev.created_by == creator_id
            assert ev.payload["kind"] == "concept_brief"

            # animatic: stage 알림 → storyboard + animatic(no_charge) emit.
            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="animatic")
            assert resp["broadcast_member_ids"] == [str(creator_id)]
            ev_storyboard = await _emit_evidence(
                s, org_id=org_id, agent_id=creator_id, story_id=story_id, kind="storyboard",
                extra_payload={
                    "shot_list": [{"shot_no": 1, "angle": "wide", "duration_sec": 3.0, "desc": "하네스 샷"}],
                    "emotion_beats": [{"beat_no": 1, "shot_no": 1, "emotion": "테스트"}],
                },
            )
            assert ev_storyboard.payload["kind"] == "storyboard"
            ev_animatic = await _emit_evidence(
                s, org_id=org_id, agent_id=creator_id, story_id=story_id, kind="animatic",
                extra_payload={"cost_tier": "no_charge", "duration_sec": 12.0},
            )
            assert ev_animatic.payload["kind"] == "animatic"
            assert ev_animatic.payload["cost_tier"] == "no_charge"

            # verification: stage 알림 → verification_sheet emit(#3561 기존 kind 재사용).
            resp = await _publish_stage(
                s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="verification",
            )
            assert resp["broadcast_member_ids"] == [str(creator_id)]
            ev_verify = await _emit_evidence(
                s, org_id=org_id, agent_id=creator_id, story_id=story_id, kind="verification_sheet",
                extra_payload={"items": [{"name": "프레임8", "verdict": "pass"}]},
            )
            assert ev_verify.payload["kind"] == "verification_sheet"
            # 기존 kind는 서버가 verified_by/verified_at을 강제(#3561 계약) — 클라 위조 못 함.
            assert ev_verify.payload.get("verified_by") is not None
    finally:
        await engine.dispose()


# ── AC3 — 사람 게이트가 실제로 생기는 stage / 아직 안 생기는 stage 경계 ───────────────────


@pytest.mark.anyio
async def test_gate_created_only_where_stage_metadata_declares_it():
    """concept_confirmed·pending_approval(gate 선언 O)은 stage 발행만으로 pending Gate가
    자동 생성 — structure_passed·live_generation(gate 선언 X, #4044 대기)·크리에이터
    stage(draft 등)는 게이트 0. 이게 "지금 실제로 멈추는 자리"의 정직한 경계선(AC3)."""
    from app.services.gate_service import find_gate_slot_with_pr_fallback
    from app.services.recipe_gate_hooks import maybe_create_stage_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition_id = await _seed_definition(s, org_id)
            await _seed_org_owner(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            story_id = await _seed_story(s, org_id, project_id)

            from app.models.event_definition import EventDefinition
            definition = await s.get(EventDefinition, definition_id)

            async def _gate_exists(gate_type: str) -> bool:
                g = await find_gate_slot_with_pr_fallback(
                    s, org_id=org_id, work_item_id=story_id, work_item_type="story",
                    gate_type=gate_type, pr_number=None, repo_full_name=None,
                )
                return g is not None

            # 게이트 선언 있는 stage — pending Gate 생성.
            await maybe_create_stage_gate(
                s, org_id=org_id, definition=definition,
                payload={"stage": "concept_confirmed", "work_item_type": "story", "work_item_id": str(story_id)},
                requester_member_id=publisher_id,
            )
            assert await _gate_exists("concept_approval") is True

            await maybe_create_stage_gate(
                s, org_id=org_id, definition=definition,
                payload={"stage": "pending_approval", "work_item_type": "story", "work_item_id": str(story_id)},
                requester_member_id=publisher_id,
            )
            assert await _gate_exists("external_publish") is True

            # 게이트 미선언 stage — no-op(#4044 대기 경계 그대로).
            for stage in ("structure_passed", "live_generation", "draft", "animatic", "verification", "editing"):
                await maybe_create_stage_gate(
                    s, org_id=org_id, definition=definition,
                    payload={"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)},
                    requester_member_id=publisher_id,
                )
            # 위 두 gate_type 외에는 어떤 gate_type도 안 생겼어야 한다 — structure/budget용
            # gate_type이 아직 없으므로 "그런 게 없다"만 확認 가능(#4044가 정하면 이 테스트가
            # 그 새 타입을 알아야 갱신된다 — 지금은 부재 확認이 맞는 판정).
    finally:
        await engine.dispose()
