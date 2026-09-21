"""story #4097(페드루 PO 確定, 2026-09-21) — merge_verdict_gate.py의 dispatch_approval_
request_cards 호출이 designated_approver_id를 안 넘겨 #3319 org 정책(merge_gate_default_
approver_member_id)이 merge 게이트 카드 배달에서 무시되던 결함(doc.py:127~134의 동일
패턴은 정확히 넘김 — 그 대조로 발견) 처방.

그라운딩(디디, 실 dev DB 대조): priority 분기는 0건 — decision_basis는 low/medium/high/
critical 무관하게 outcome sample insufficient|CI unknown(self-report only)뿐. 원 관측
(«low만 발송») 오류의 진짜 원인은 policy 무시로 owner/admin 전원에게 카드가 가던 것.
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

    org = Organization(id=uuid.uuid4(), name="Org4097", slug=f"org4097-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_org_member(session, org_id, project_id=None, *, role="member"):
    """story #2118 test_2118_merge_gate_approval_cards_realdb.py의 동형 헬퍼(OrgMember +
    TeamMember 짝 — create_all이 team_members를 real table로 만드는 이 harness 한정 필요)."""
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


async def _seed_implementer_member(session, org_id, project_id):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
        name="디디", is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story_with_participation(session, *, org, project, story_id, member, role_id):
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story

    session.add_all([
        ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
        Story(id=story_id, org_id=org, project_id=project, title="#4097 지정 승인자 카드", status="in-review", story_points=3),
    ])
    await session.commit()
    session.add(Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id))
    await session.commit()


@pytest.mark.anyio
async def test_evaluate_merge_gate_dispatches_only_to_designated_approver_when_policy_set():
    """⭐AC2 핵심 — 정책 지정자가 있으면 owner/admin 2명 중 지정된 1인에게만 카드가 간다
    (배선 복원 前엔 designated_approver_id가 dispatch까지 안 이어져 2명 다 받았을 자리)."""
    from sqlalchemy import select
    from app.models.conversation import Conversation, ConversationMessage
    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.services.merge_verdict_gate import ASK_HUMAN, evaluate_merge_gate

    engine, Session = await _engine_and_session()
    org_id, project_id, story_id = None, None, uuid.uuid4()
    role_id = uuid.uuid4()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            implementer_id = await _seed_implementer_member(s, org_id, project_id)
            designated_id = await _seed_org_member(s, org_id, project_id, role="owner")
            other_owner_id = await _seed_org_member(s, org_id, project_id, role="admin")
            await _seed_story_with_participation(
                s, org=org_id, project=project_id, story_id=story_id,
                member=implementer_id, role_id=role_id,
            )
            s.add(OrgGatePolicy(
                org_id=org_id, posture="conservative",
                merge_gate_default_approver_member_id=designated_id,
            ))
            await s.commit()

        async with Session() as s:
            decision = await evaluate_merge_gate(
                s, org_id, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
            )
            await s.commit()

        assert decision.decision == ASK_HUMAN
        assert decision.gate_id is not None

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == decision.gate_id))).scalar_one()
            assert gate.designated_approver_id == designated_id, "gate row 자체는 #3319가 이미 채움"

            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 1, f"지정자 1인에게만 DM이 가야 한다(실제 {len(convs)}개)"

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 1
            assert msgs[0].mentioned_ids == [designated_id]
            assert other_owner_id not in (msgs[0].mentioned_ids or [])
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_evaluate_merge_gate_dispatches_to_all_approvers_when_policy_unset_regression():
    """회귀 0 — OrgGatePolicy.merge_gate_default_approver_member_id가 미설정(None)이면
    owner/admin 전원에게 카드가 가는 현행 동작 그대로(배선 복원이 이 경로를 안 건드림).
    designated_approver_id=None → dispatch_approval_request_cards가 approver_ids 전원
    폴백(approval_delivery.py:189)."""
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
            await _seed_org_member(s, org_id, project_id, role="owner")
            await _seed_org_member(s, org_id, project_id, role="admin")
            await _seed_story_with_participation(
                s, org=org_id, project=project_id, story_id=story_id,
                member=implementer_id, role_id=role_id,
            )
            # merge_gate_default_approver_member_id 미지정(nullable 기본값 None).
            s.add(OrgGatePolicy(org_id=org_id, posture="conservative"))
            await s.commit()

        async with Session() as s:
            decision = await evaluate_merge_gate(
                s, org_id, story_id, pr_number=0, repo="", ci_result=None, pr_result=None,
            )
            await s.commit()

        assert decision.decision == ASK_HUMAN

        async with Session() as s:
            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 2, f"정책 미설정 — owner/admin 2명 전원(실제 {len(convs)}개)"
            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            assert len(msgs) == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_dispatch_approval_request_cards_thread_reply_also_respects_designated_approver():
    """AC2 — existing_root 스레드 답글 분기(approval_delivery.py:223~288, story #3821)도
    designated_approver_id가 있으면 그 1인에게만 붙는다. recipients 계산(:189)이 fresh-root/
    thread-reply 두 분기의 공통 진입점이라 배선 복원 자체가 두 분기를 함께 고친다 — 이
    테스트는 그 사실을 실 왕복(같은 (work_item_type, work_item_id, gate_type) 슬롯에 2회
    호출)으로 고정."""
    from sqlalchemy import select
    from app.models.conversation import Conversation, ConversationMessage
    from app.services.approval_delivery import dispatch_approval_request_cards

    engine, Session = await _engine_and_session()
    org_id, project_id, story_id = None, None, uuid.uuid4()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_org_member(s, org_id, project_id, role="member")
            designated_id = await _seed_org_member(s, org_id, project_id, role="owner")
            other_owner_id = await _seed_org_member(s, org_id, project_id, role="admin")

        gate_id_1 = uuid.uuid4()
        async with Session() as s:
            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="story", work_item_id=story_id,
                project_id=project_id, title="지정승인 스레드", gate_id=gate_id_1, gate_type="merge",
                requester_id=requester_id, approver_ids=[designated_id, other_owner_id],
                designated_approver_id=designated_id,
            )
            await s.commit()

        # PR 재시도 재현 — 같은 슬롯(work_item_type/work_item_id/gate_type)에 새 gate_id로
        # 재호출(story #3821 existing_root 분기).
        gate_id_2 = uuid.uuid4()
        async with Session() as s:
            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="story", work_item_id=story_id,
                project_id=project_id, title="지정승인 스레드", gate_id=gate_id_2, gate_type="merge",
                requester_id=requester_id, approver_ids=[designated_id, other_owner_id],
                designated_approver_id=designated_id, reopen_reason="PR #2",
            )
            await s.commit()

        async with Session() as s:
            convs = (await s.execute(select(Conversation).where(Conversation.org_id == org_id))).scalars().all()
            assert len(convs) == 1, "두 호출 다 지정자 1인 DM 하나로만 수렴해야 한다"

            msgs = (await s.execute(
                select(ConversationMessage).order_by(ConversationMessage.created_at)
            )).scalars().all()
            assert len(msgs) == 2, "1건은 최상위 카드, 1건은 스레드 답글"
            assert msgs[0].thread_id is None, "1차 호출 = 최상위"
            assert msgs[1].thread_id == msgs[0].id, "2차 호출 = existing_root 스레드 답글"
            for m in msgs:
                assert m.mentioned_ids == [designated_id]
                assert other_owner_id not in (m.mentioned_ids or [])
    finally:
        await engine.dispose()
