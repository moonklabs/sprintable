"""story #4153(E-RECIPE-1·Phase 3 폴리시, 페드루 PO 確定 2026-09-22) — 승인 요청 카드
배달(`dispatch_approval_request_cards`)이 승인자를 대화 참여자로 넣을 때
`conversation_participants.member_id` FK(team_members) 위반으로 조용히 실패(WARNING만)
하던 결함의 뿌리.

그라운딩(AC1, 채팅 보고 済 — PR 본문에도 동일 표):
- `_resolve_org_owner` 폴백(정책 미설정)은 `OrgMember.id`를 반환한다.
- 휴먼은 `members.id == org_member.id`가 "0075 불변식"(agent_anchor_sync.py::
  ensure_human_member가 `id=om.id`로 직접 앵커 INSERT) — 두 id는 설계상 같은 값이다,
  축 자체가 다른 게 아니다.
- 정상 org_member 생성 경로(organizations.py/projects.py/org_members.py 리포지토리
  choke point·org_invites.py, story #3635가 전수 커버)는 전부 `ensure_human_member`를
  호출해 항상 앵커한다 — 실 결함은 "그 앵커가 실재하는지"를 `_resolve_org_owner`가
  스스로 보장 안 하는 것: 손시드(이 파일의 옛 `_seed_org_project_with_owner`)나 미지의
  경로가 그 choke point를 건너뛰면 anchor 없는 org_member.id가 그대로 반환돼
  `dispatch_approval_request_cards`의 참여자 INSERT가 조용히(WARNING만) 실패한다.

처방(AC2): `_resolve_org_owner` 폴백에서 OrgMember를 찾은 직후 `ensure_human_member`
(기존 정본 함수, 멱등 — 새 메커니즘 0)를 방어적으로 호출해 앵커를 자가치유(self-heal)
한다. 그래도 실패하면(orphan org/user) 조용히 진행하지 않고 `UnknownApproverRoleError`
로 loud(카드가 못 갈 승인자를 지정하는 것보다 발행 자체를 막는 게 정직하다).

AC2(b) 검증(코드 0 — 기존 설계 확認): 결재함 노출은 story #3084가 이미 "층1"로 못박은
대로 `Gate.designated_approver_id` 직접 쿼리(`GET /gates/designated-pending-count`,
gates.py:1499-1521)라 conversation_participants/DM 도달 여부와 **완전히 무관**하다 —
카드 배달이 실패해도 결재함 배지·목록은 그대로 뜬다(이 파일에서 별도 테스트 불요,
gates.py 그 쿼리 자체가 증거)."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="realdb 테스트는 실 Postgres 필요"),
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


async def _seed_unanchored_org(session, *, slug):
    """옛 test_3313 시드와 동형 — org_member만 만들고 members 앵커는 **일부러 안 만든다**
    (이 결함 클래스의 실측 재현: choke point를 안 거치는 손시드/미지 경로)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project

    org = Organization(id=uuid.uuid4(), name="Org4153", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=uuid.uuid4(), role="owner")
    session.add(owner_member)
    await session.commit()
    return org.id, project.id, owner_member.id


async def _member_row_exists(session, member_id):
    from app.models.member import Member
    from sqlalchemy import select

    return (await session.execute(
        select(Member.id).where(Member.id == member_id)
    )).scalar_one_or_none() is not None


@pytest.mark.anyio
async def test_resolve_org_owner_self_heals_missing_anchor():
    """⭐AC2 핵심 — 앵커 없는 org owner라도 `_resolve_org_owner`가 반환하기 前에
    `ensure_human_member`로 자가치유해, 반환된 id가 실제로 `members`(=team_members)에
    존재하게 만든다."""
    from app.services.recipe_gate_hooks import _resolve_org_owner

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _project_id, owner_member_id = await _seed_unanchored_org(s, slug="4153a")
            assert not await _member_row_exists(s, owner_member_id), "사전조건: 앵커가 아직 없어야 한다"

            resolved_id = await _resolve_org_owner(s, org_id=org_id)

            assert resolved_id == owner_member_id
            assert await _member_row_exists(s, resolved_id), "자가치유 後에도 앵커가 없다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_org_owner_self_heal_is_idempotent_when_already_anchored():
    """회귀 0 — 이미 정상 경로(ensure_human_member)로 앵커된 owner는 재호출해도 그대로
    같은 id를 반환한다(멱등, ON CONFLICT DO NOTHING)."""
    from app.services.agent_anchor_sync import ensure_human_member
    from app.services.recipe_gate_hooks import _resolve_org_owner

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _project_id, owner_member_id = await _seed_unanchored_org(s, slug="4153b")
            assert await ensure_human_member(s, owner_member_id) is True
            await s.commit()

            resolved_id = await _resolve_org_owner(s, org_id=org_id)
            assert resolved_id == owner_member_id
            assert await _member_row_exists(s, resolved_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_stage_gate_with_anchored_org_owner_delivers_card_end_to_end():
    """⭐AC3(a) end-to-end — test_3313 원 실사고 재현 컨텍스트(정책 미설정 org, stage_
    metadata.gate가 org_owner 승인을 요구하는 stage 발행) 그대로, org owner가 정상
    앵커된(=`ensure_human_member`/제품 경로가 만드는 실 상태) 채로 발행하면 게이트
    생성·카드 배달이 실제로 conversation_participants 행을 남긴다(카드가 실제로 갔다는
    관측 가능한 증거) — WARNING 0.

    ⚠️`team_members`는 prod에서 `members`⋈`project_access` VIEW지만 이 realdb 하네스는
    `Base.metadata.create_all()`(마이그 미경유)라 뷰 대신 `TeamMember` 모델이 그 이름의
    **별도 실 테이블**을 만든다(story #4152 세션에서도 동일 하네스 한계 확認, PR 본문
    "적기만" 후속 후보 — ORM `ForeignKey("team_members.id")` 선언 자체가 0092 DROP과
    드리프트). `ensure_human_member`는 prod의 실제 앵커 대상(`members`)에만 쓰므로,
    이 하네스에서 대화 참여자 INSERT가 실제로 통과하려면 `TeamMember` 행도 같이 시딩해야
    한다(다른 테스트의 `_seed_agent`와 동형 — 발명 0). self-heal 메커니즘 자체(members
    앵커 보장)는 위 두 단위 테스트가 `Member` 테이블로 직접 검증한다."""
    from app.models.conversation import ConversationParticipant
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.dependencies.auth import AuthContext
    from sqlalchemy import select
    from starlette.requests import Request as StarletteRequest

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_unanchored_org(s, slug="4153c")

            from app.services.agent_anchor_sync import ensure_human_member
            assert await ensure_human_member(s, owner_member_id) is True

            from app.models.team import TeamMember
            s.add(TeamMember(
                id=owner_member_id, org_id=org_id, project_id=project_id, type="human",
                name="org owner", is_active=True,
            ))
            publisher = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
                name="댄", is_active=True,
            )
            s.add(publisher)
            await s.commit()

            from app.models.pm import Story
            story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="AC2 e2e", assignee_id=publisher.id)
            s.add(story)
            await s.commit()

            from app.models.event_definition import EventDefinition
            definition_key = "org.4153e2e.recipe_cycle"
            definition = EventDefinition(
                id=uuid.uuid4(), key=definition_key, org_id=org_id, name="4153 e2e",
                payload_schema={
                    "type": "object", "additionalProperties": False,
                    "required": ["stage", "work_item_type", "work_item_id"],
                    "properties": {
                        "stage": {"type": "string", "enum": ["monitor", "research"]},
                        "work_item_type": {"type": "string"},
                        "work_item_id": {"type": "string", "format": "uuid"},
                    },
                },
                routing={
                    "escalation": {"kind": "server_derived", "target": "none"},
                    "broadcast": {"kind": "server_derived", "target": "none"},
                },
                stage_metadata={
                    "monitor": {
                        "role": "Scout", "action": "감지",
                        "gate": {"type": "checkpoint", "approver": "org_owner"},
                    },
                    "research": {"role": "Researcher", "action": "조사"},
                },
            )
            s.add(definition)
            await s.commit()

            auth = AuthContext(
                user_id=str(publisher.id), email=None,
                claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
            )
            payload = {"stage": "monitor", "work_item_type": "story", "work_item_id": str(story.id)}
            resp = await publish_registry_event(
                EventPublishRequest(definition_key=definition_key, payload=payload),
                BackgroundTasks(), StarletteRequest(scope={"type": "http", "headers": []}),
                db=s, auth=auth, org_id=org_id,
            )
            assert resp is not None

            from app.models.gate import Gate
            gate = (await s.execute(
                select(Gate).where(Gate.org_id == org_id, Gate.work_item_id == story.id)
            )).scalars().first()
            assert gate is not None, "게이트 자체가 안 생겼다(발행이 UnknownApproverRoleError로 죽었을 수 있음)"
            assert gate.designated_approver_id == owner_member_id

            participant_exists = (await s.execute(
                select(ConversationParticipant.id).where(
                    ConversationParticipant.member_id == owner_member_id,
                )
            )).scalar_one_or_none() is not None
            assert participant_exists, (
                "승인 요청 카드가 조용히 실패(WARNING만)했다 — org owner가 대화 참여자로 안 들어감"
            )
    finally:
        await engine.dispose()
