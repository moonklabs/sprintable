"""story #2118(E-DG-REAL) ②BE 훅 — 실 PG.

doc.py 전용이던 dispatch_approval_request_cards(#2604)를 merge gate까지 확장한 것을 검증한다.
축 두 개:
1. project_auth.list_gate_approver_ids — gates.py `_non_doc_gate_approvable`(단건 판정)과
   같은 규칙(project owner/admin ∪ org owner/admin floor, project_id 없으면 org owner/admin만)의
   listing 방향 뒤집기.
2. merge_verdict_gate.evaluate_merge_gate — gate가 이 호출에서 «방금» pending이 된 경우만
   승인자 DM에 카드를 배달(반복 호출 시 중복 배달 없음, _prior_status 가드).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    return _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )


async def _engine_and_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2118", slug=f"org2118-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_org_member(session, org_id, project_id=None, *, role="member"):
    """OrgMember(역할판정용) + 같은 id의 TeamMember(대화 FK용 — 실 마이그된 스키마의
    team_members VIEW를 create_all이 real table로 만드는 이 테스트 한정 필요, doc.py/
    approval_delivery.py 소비 코드가 conversations.created_by/conversation_participants.
    member_id를 이 id 공간으로 기대하는 것과 동형 — test_2604의 _seed_human과 같은 이유)."""
    from app.models.project import OrgMember
    from app.models.team import TeamMember

    member_id = uuid.uuid4()
    om = OrgMember(id=member_id, org_id=org_id, user_id=uuid.uuid4(), role=role)
    session.add(om)
    if project_id is not None:
        session.add(TeamMember(
            id=member_id, org_id=org_id, project_id=project_id, type="human",
            name="approver", is_active=True,
        ))
    await session.commit()
    return om.id


async def _seed_project_access(session, project_id, org_member_id, *, role="owner"):
    from app.models.project_access import ProjectAccess

    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=org_member_id,
        role=role, permission="granted",
    ))
    await session.commit()


@pytest.mark.anyio
async def test_list_gate_approver_ids_project_scoped_owner_admin_union():
    from app.services.project_auth import list_gate_approver_ids

    engine, Session = await _engine_and_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            project_owner = await _seed_org_member(s, org_id, role="member")  # org role=member
            await _seed_project_access(s, project_id, project_owner, role="owner")  # project owner
            org_admin = await _seed_org_member(s, org_id, role="admin")  # org-wide admin floor, no explicit grant
            plain_member = await _seed_org_member(s, org_id, role="member")  # neither → excluded

        async with Session() as s:
            approver_ids = set(await list_gate_approver_ids(s, org_id, project_id))
            assert approver_ids == {project_owner, org_admin}
            assert plain_member not in approver_ids
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_gate_approver_ids_excludes_given_id():
    from app.services.project_auth import list_gate_approver_ids

    engine, Session = await _engine_and_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester = await _seed_org_member(s, org_id, role="owner")

        async with Session() as s:
            approver_ids = await list_gate_approver_ids(s, org_id, project_id, exclude_id=requester)
            assert requester not in approver_ids
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_gate_approver_ids_project_none_falls_back_to_org_owner_admin():
    from app.services.project_auth import list_gate_approver_ids

    engine, Session = await _engine_and_session()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            org_owner = await _seed_org_member(s, org_id, role="owner")
            plain_member = await _seed_org_member(s, org_id, role="member")

        async with Session() as s:
            approver_ids = set(await list_gate_approver_ids(s, org_id, None))
            assert org_owner in approver_ids
            assert plain_member not in approver_ids
    finally:
        await engine.dispose()


async def _seed_org_member_with_uid(session, org_id, *, role="member"):
    """parity 테스트 전용 — user_id를 함께 반환한다(_non_doc_gate_approvable은 org_members.id가
    아니라 .user_id를 받는 단건 판정 함수라 listing 결과(.id)와 다른 id 공간)."""
    from app.models.project import OrgMember

    user_id = uuid.uuid4()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role=role)
    session.add(om)
    await session.commit()
    return om.id, user_id


@pytest.mark.anyio
async def test_list_gate_approver_ids_parity_with_single_item_judge():
    """페드루 PO AC 리뷰(2026-08-16) — list_gate_approver_ids(listing)가 gates.py
    _non_doc_gate_approvable(단건 판정)과 «같은 규칙»이라는 주장은 docstring뿐이었다(규칙이
    한쪽만 바뀌면 조용히 어긋나는 자리 — 「막는 쪽과 하는 쪽이 다른 걸 본다」 클래스, #2198과
    동형). 시드된 멤버 전원에 대해 두 방향(listing 포함 여부 == 단건 판정 결과)을 단언해
    어느 쪽이 바뀌어도 이 테스트가 빨개지게 고정한다."""
    from app.routers.gates import _non_doc_gate_approvable
    from app.services.project_auth import list_gate_approver_ids

    engine, Session = await _engine_and_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            _other_org_id, other_project_id = None, None
            from app.models.project import Project
            other_project = Project(id=uuid.uuid4(), org_id=org_id, name="P2")
            s.add(other_project)
            await s.commit()
            other_project_id = other_project.id

            members = {}
            members["project_owner"], uid_project_owner = await _seed_org_member_with_uid(s, org_id, role="member")
            await _seed_project_access(s, project_id, members["project_owner"], role="owner")

            members["project_admin"], uid_project_admin = await _seed_org_member_with_uid(s, org_id, role="member")
            await _seed_project_access(s, project_id, members["project_admin"], role="admin")

            members["project_plain_member"], uid_project_plain = await _seed_org_member_with_uid(s, org_id, role="member")
            await _seed_project_access(s, project_id, members["project_plain_member"], role="member")

            members["org_owner_floor"], uid_org_owner = await _seed_org_member_with_uid(s, org_id, role="owner")
            members["org_admin_floor"], uid_org_admin = await _seed_org_member_with_uid(s, org_id, role="admin")
            members["no_access"], uid_no_access = await _seed_org_member_with_uid(s, org_id, role="member")

            members["other_project_owner"], uid_other_project_owner = await _seed_org_member_with_uid(s, org_id, role="member")
            await _seed_project_access(s, other_project_id, members["other_project_owner"], role="owner")

            uids = {
                "project_owner": uid_project_owner, "project_admin": uid_project_admin,
                "project_plain_member": uid_project_plain, "org_owner_floor": uid_org_owner,
                "org_admin_floor": uid_org_admin, "no_access": uid_no_access,
                "other_project_owner": uid_other_project_owner,
            }

        async with Session() as s:
            listing = set(await list_gate_approver_ids(s, org_id, project_id))
            for label, member_id in members.items():
                judged = await _non_doc_gate_approvable(s, uids[label], org_id, project_id)
                in_listing = member_id in listing
                assert judged == in_listing, (
                    f"{label}: 단건 판정={judged} vs listing 포함={in_listing} — 두 함수가 갈렸다"
                )
    finally:
        await engine.dispose()


async def _seed_story_with_participation(session, *, org, project, story_id, member, role_id):
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story

    session.add_all([
        ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
        Story(id=story_id, org_id=org, project_id=project, title="#2118 머지 게이트 카드", status="in-review", story_points=3),
    ])
    await session.commit()
    session.add(Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id))
    await session.commit()


async def _seed_implementer_member(session, org_id, project_id):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
        name="디디", is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


@pytest.mark.anyio
async def test_evaluate_merge_gate_dispatches_approval_card_on_first_pending():
    from sqlalchemy import select
    from app.models.conversation import Conversation, ConversationMessage
    from app.models.hitl_config import OrgGatePolicy
    from app.services.merge_verdict_gate import ASK_HUMAN, evaluate_merge_gate

    engine, Session = await _engine_and_session()
    org_id, project_id, story_id = None, None, uuid.uuid4()
    role_id = uuid.uuid4()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            implementer_id = await _seed_implementer_member(s, org_id, project_id)
            approver_id = await _seed_org_member(s, org_id, project_id, role="owner")
            await _seed_story_with_participation(
                s, org=org_id, project=project_id, story_id=story_id,
                member=implementer_id, role_id=role_id,
            )
            s.add(OrgGatePolicy(org_id=org_id, posture="conservative"))
            await s.commit()

        async with Session() as s:
            decision = await evaluate_merge_gate(
                s, org_id, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
            )
            await s.commit()

        assert decision.decision == ASK_HUMAN
        assert decision.gate_id is not None

        async with Session() as s:
            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 1, "승인자 1명 → DM 1개"
            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 1
            target = msgs[0].msg_metadata["approval_target"]
            assert target["work_item_type"] == "story"
            assert target["work_item_id"] == str(story_id)
            assert target["gate_id"] == str(decision.gate_id)
            assert target["actions"] == ["approve", "reject"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evaluate_merge_gate_no_duplicate_card_on_repeat_pending_call():
    """mutation-kill 대상 — _prior_status 가드가 없으면 이 테스트가 RED(메시지 2건)로 잡는다."""
    from sqlalchemy import select
    from app.models.conversation import ConversationMessage
    from app.models.hitl_config import OrgGatePolicy
    from app.services.merge_verdict_gate import evaluate_merge_gate

    engine, Session = await _engine_and_session()
    story_id = uuid.uuid4()
    role_id = uuid.uuid4()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            implementer_id = await _seed_implementer_member(s, org_id, project_id)
            await _seed_org_member(s, org_id, project_id, role="owner")
            await _seed_story_with_participation(
                s, org=org_id, project=project_id, story_id=story_id,
                member=implementer_id, role_id=role_id,
            )
            s.add(OrgGatePolicy(org_id=org_id, posture="conservative"))
            await s.commit()

        async with Session() as s:
            await evaluate_merge_gate(
                s, org_id, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
            )
            await s.commit()

        # 두 번째 호출 — 게이트는 이미 pending(아직 해소 안 됨). 새 카드가 또 나가면 안 된다.
        async with Session() as s:
            await evaluate_merge_gate(
                s, org_id, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
            )
            await s.commit()

        async with Session() as s:
            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 1, f"반복 호출로 카드가 중복 배달됨: {len(msgs)}건"
    finally:
        await engine.dispose()
