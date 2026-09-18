"""story #4047(E-RECIPE-1 ②, 페드루 PO 킥오프 2026-09-18) — #4045 배선의 연장, ⓒ 예산
게이트(미르코 #4044, 미착수) 앞에 서는 "에이전트 쪽" emit. 크리에이터 에이전트가 유료 생성
(`live_generation`) stage 진입 前 표적·편당 예상 비용을 `generation_cost` evidence로
제출한다.

⭐#4045(test_4045_creator_slot_stage_wiring.py)와 동형 하네스(realdb·disposable PG·자기
완결적 seed) — 발명 0.

인터페이스 실측(미르코군에게 공유·확認 요청, 2026-09-18) — `generation_cost` kind는 다른
계약 kind(concept_brief 등, type="report")와 달리 **`type="metric"`**이어야 한다
(`app/services/generation_budget.py:95` `compute_generation_budget_status`가
`Evidence.type == "metric"`으로만 집계한다 — `type="report"`로 잘못 emit하면
`evidence.py:241` 검증(cost_minor 정수·currency 일치)은 통과하는데 예산 합산엔 조용히
안 잡히는 함정). 이 파일 test 2/3이 그 경계를 pin한다(양성=metric 집계됨·음성=report는
집계 안 됨, positive/negative control 쌍).

미르코군 회신(2026-09-18, #4044 로컬 구현 완료) — ⓒ 예산 게이트는 최초 카드 문구
(live_generation)가 아니라 **`structure_passed`**에 선다(유나 디자인 확定으로 위치
변경) — `stage_metadata["structure_passed"].gate={"type":"generation_budget",
"approver":"org_owner"}`, `check_generation_budget_or_raise`/
`compute_generation_budget_status` 재사용·신규 잔량 로직 0. 이 파일의 stage_metadata
사본도 그 위치로 갱신했다 — 크리에이터가 바인딩된 마지막 stage(`animatic`)는 여전히
`structure_passed` 바로 앞이라 포지셔닝(「게이트 앞」)은 그대로 유효하다."""
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

# #4045와 동일 shape(미르코 시드 story #4039, migration 0379 그대로 복사) — org 커스텀 key.
_KEY = "org.moonklabs.video_production_wiring_stub"

_STAGE_SLUGS = [
    "draft", "concept_confirmed", "animatic", "structure_passed", "live_generation",
    "verification", "editing", "pending_approval", "published",
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
    "draft": {"role": "크리에이터", "action": "로그라인·매핑표·컨셉 초안 작성"},
    "concept_confirmed": {
        "role": "디렉터", "action": "우화 비트↔제품 가치 매핑 + 미션 정합 확定 승인",
        "gate": {"type": "concept_approval", "approver": "org_owner"},
    },
    "animatic": {"role": "크리에이터", "action": "무과금 스틸+텍스트+VO 애니매틱 제작"},
    "structure_passed": {
        "role": "디렉터", "action": "무과금 애니매틱으로 구조 판정 승인",
        # #4044(미르코, 2026-09-18) — ⓒ예산 게이트 실 위치. generation_budget.py 그대로 재사용.
        "gate": {"type": "generation_budget", "approver": "org_owner"},
    },
    "live_generation": {
        "role": "디렉터", "action": "표적·예산을 명시해 실탄(유료 생성) 발사 승인",
        "capability": {"kind": "generate"},
    },
    "verification": {"role": "크리에이터", "action": "프레임8+받아쓰기 등 눈·귀 검증 시트 작성"},
    "editing": {"role": "크리에이터", "action": "편집 통일 패스(그레이드·룸톤·자막 레벨 통일)"},
    "pending_approval": {
        "role": "발행자", "action": "최종 발행 승인 대기(외부 발행 직전)",
        "gate": {"type": "external_publish", "approver": "org_owner"},
    },
    "published": {"role": "발행자", "action": "승인된 채널에 실 게시", "capability": {"kind": "publish"}},
}


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


async def _seed_org_project(session, *, slug="e4047budget"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4047", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    """#4045와 동형 — TeamMember(라우팅) + Member 앵커 + ProjectAccess granted(evidence
    생성 인가에 필요, #4045에서 실측으로 배운 3종 세트)."""
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


async def _seed_generation_budget_policy(session, org_id, *, limit_minor, currency="KRW"):
    """generation_budget.py::compute_generation_budget_status가 읽는 org 정책 — 정책이
    없으면 「규칙 없음」이라 합산 자체가 스킵된다(None 반환), 그러면 이 파일의 집계 pin이
    무의미해진다."""
    from app.models.org_content_rule import OrgContentRule

    session.add(OrgContentRule(
        id=uuid.uuid4(), org_id=org_id, version=1,
        rules={"generation_budget": {"limit_minor": limit_minor, "currency": currency, "period": "month"}},
    ))
    await session.commit()


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> AuthContext:
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


async def _publish_stage(session, *, org_id, publisher_id, story_id, stage):
    from starlette.requests import Request as StarletteRequest

    from app.routers.events import EventPublishRequest, publish_registry_event

    body = EventPublishRequest(
        definition_key=_KEY,
        payload={"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)},
    )
    return await publish_registry_event(
        body, BackgroundTasks(), StarletteRequest(scope={"type": "http", "headers": []}),
        db=session, auth=_auth(publisher_id, org_id), org_id=org_id,
    )


async def _emit_generation_cost(session, *, org_id, agent_id, story_id, cost_minor, currency, target, type_="metric"):
    from app.routers.evidence import EvidenceCreateRequest, create_evidence

    body = EvidenceCreateRequest(
        work_item_id=story_id, work_item_type="story", type=type_,
        ref="creator-budget-estimate:generation_cost",
        payload={"kind": "generation_cost", "cost_minor": cost_minor, "currency": currency, "target": target},
    )
    return await create_evidence(body, session=session, org_id=org_id, auth=_auth(agent_id, org_id))


# ── AC1 — 크리에이터가 유료 생성 前 generation_cost 추정을 emit ───────────────────────


@pytest.mark.anyio
async def test_creator_emits_generation_cost_estimate_before_live_generation_stage():
    """animatic stage(크리에이터가 실제로 바인딩된 마지막 stage, ⓒ게이트가 선 structure_
    passed 바로 앞)에서 크리에이터가 예상 비용을 emit — cost_minor·currency·target(표적,
    서버 미검증 자유 필드)이 그대로 실리고 evidence.py:241 검증(정수·조직 currency 일치)을
    통과한다. structure_passed·live_generation 이벤트는 이 파일 어디서도 발행하지 않는다 —
    "게이트 앞"이라는 포지셔닝을 구조적으로 pin(그 stage에 진입도 안 했는데 이미 추정이
    서 있다)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            await _seed_generation_budget_policy(s, org_id, limit_minor=1_000_000, currency="KRW")
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            creator_id = await _seed_agent(s, org_id, project_id, name="creator-slot")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_binding(s, org_id, project_id, stage="animatic", agent_id=creator_id)

            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="animatic")
            assert resp["broadcast_member_ids"] == [str(creator_id)]

            ev = await _emit_generation_cost(
                s, org_id=org_id, agent_id=creator_id, story_id=story_id,
                cost_minor=50_000, currency="KRW", target="릴스 15초 실탄 생성 1편",
            )
            assert ev.type == "metric"
            assert ev.payload["kind"] == "generation_cost"
            assert ev.payload["cost_minor"] == 50_000
            assert ev.payload["target"] == "릴스 15초 실탄 생성 1편"
            assert ev.payload["recorded_by"] == "agent"
            assert ev.created_by == creator_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_negative_cost_and_currency_mismatch_rejected():
    """evidence.py:241 강제 — cost_minor 음수 422, 조직 currency 정책과 다른 currency 422."""
    from fastapi import HTTPException

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            await _seed_generation_budget_policy(s, org_id, limit_minor=1_000_000, currency="KRW")
            creator_id = await _seed_agent(s, org_id, project_id, name="creator-slot")
            story_id = await _seed_story(s, org_id, project_id)

            with pytest.raises(HTTPException) as exc_info:
                await _emit_generation_cost(
                    s, org_id=org_id, agent_id=creator_id, story_id=story_id,
                    cost_minor=-1, currency="KRW", target="음수 프로브",
                )
            assert exc_info.value.status_code == 422

            with pytest.raises(HTTPException) as exc_info:
                await _emit_generation_cost(
                    s, org_id=org_id, agent_id=creator_id, story_id=story_id,
                    cost_minor=1000, currency="USD", target="통화 불일치 프로브",
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


# ── AC2 인터페이스 pin — type="metric" 아니면 예산 합산에 조용히 안 잡힌다(positive/negative) ──


@pytest.mark.anyio
async def test_generation_cost_counted_only_when_type_is_metric():
    """양성: type="metric"으로 emit → compute_generation_budget_status가 spent_minor에
    정확히 반영. 음성(뮤테이션): 같은 payload를 type="report"로 emit(다른 kind들의 관례를
    실수로 따라간 경우 재현) → 검증은 통과하지만 집계엔 0으로 안 잡힌다 — #4044가 이
    함정을 그대로 밟지 않도록 실측으로 남겨둔다."""
    from app.services.generation_budget import compute_generation_budget_status

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            await _seed_generation_budget_policy(s, org_id, limit_minor=1_000_000, currency="KRW")
            creator_id = await _seed_agent(s, org_id, project_id, name="creator-slot")
            story_id = await _seed_story(s, org_id, project_id)

            await _emit_generation_cost(
                s, org_id=org_id, agent_id=creator_id, story_id=story_id,
                cost_minor=50_000, currency="KRW", target="양성 대조", type_="metric",
            )
            status = await compute_generation_budget_status(s, org_id=org_id)
            assert status["spent_minor"] == 50_000
            assert status["remaining_minor"] == 950_000

            # 음성(뮤테이션) — type="report"로 같은 kind emit.
            await _emit_generation_cost(
                s, org_id=org_id, agent_id=creator_id, story_id=story_id,
                cost_minor=999_000, currency="KRW", target="음성 대조(type 오류 재현)", type_="report",
            )
            status_after = await compute_generation_budget_status(s, org_id=org_id)
            assert status_after["spent_minor"] == 50_000, (
                "type=\"report\"로 emit된 generation_cost가 집계에 새면 안 된다"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_check_generation_budget_or_raise_rejects_over_budget_estimate():
    """ⓒ 게이트(#4044)가 재사용 가능해 보이는 기존 프리미티브 — 예산 초과 추정을 그대로
    거부한다(미르코군 확認 요청 사항, doc/interface 소통 참고용 pin)."""
    from app.services.generation_budget import (
        GenerationBudgetExceededError,
        check_generation_budget_or_raise,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            await _seed_generation_budget_policy(s, org_id, limit_minor=100_000, currency="KRW")
            creator_id = await _seed_agent(s, org_id, project_id, name="creator-slot")
            story_id = await _seed_story(s, org_id, project_id)

            await _emit_generation_cost(
                s, org_id=org_id, agent_id=creator_id, story_id=story_id,
                cost_minor=80_000, currency="KRW", target="이미 쓴 것", type_="metric",
            )

            with pytest.raises(GenerationBudgetExceededError):
                await check_generation_budget_or_raise(s, org_id=org_id, estimated_cost_minor=30_000)

            # 남은 한도 안이면 통과(예외 없음).
            await check_generation_budget_or_raise(s, org_id=org_id, estimated_cost_minor=15_000)
    finally:
        await engine.dispose()
