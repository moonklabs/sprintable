"""story #8bc11434(2891, PO 페드루 재조준 2026-08-22) — request_decision(agent_decision_request
게이트) 상신 시 결재자(org owner/admin) 챗에 원탭 결재 카드가 자동 발행되는지(실 PG).

그라운딩(미르코): 원문 진단("submit_for_approval이 카드 미발행")은 낡음 — doc 경로는 story #2604
(ae40ea36)로 이미 배선됨(test_2604_approval_request_cards.py 고정). 실제 살아있는 갭은
create_decision_request()가 dispatch_approval_request_cards를 전혀 호출하지 않던 것 —
gates.py `_non_doc_gate_approvable`(project_id=None 분기, agent_decision은 project-agnostic)이
이 gate_type의 승인 자격을 org owner/admin으로 이미 확定해 둔 것과 동일 인구를 알림 대상으로 쓴다
(doc.py `_notify_doc_approval_requested`와 완전히 동형 재사용 — 새 판단 없음).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2891", slug=f"org2891-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_admin_approver(session, org_id):
    """test_373cfaa1의 _seed_org_project_admin과 동형(User+OrgMember role=admin)."""
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"admin-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    admin_member_id = uuid.uuid4()
    session.add(OrgMember(id=admin_member_id, org_id=org_id, user_id=user_id, role="admin"))
    await session.commit()
    return admin_member_id


async def _seed_agent_requester(session, org_id, project_id):
    """request_decision 호출자. 실 경로는 agent TeamMember(API-key auth 시 AuthContext.user_id가
    그 id로 채워짐 — app/dependencies/auth.py:253)이나, team_members는 0088 이후 members+
    project_access+agent_project_profiles UNION **뷰**라 직접 INSERT 불가(cannot insert into
    view). dispatch_approval_request_cards의 lookup_members_by_ids는 TeamMember 우선·미발견 시
    OrgMember로 폴백(member_resolver.py 확인) — 뷰 배관을 새로 세우지 않고 이 폴백 경로를 그대로
    타도록 OrgMember(role=member)로 seed(승인 자격 없는 일반 멤버 — admin과 충돌 없음)."""
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"req-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=user_id, role="member"))
    await session.commit()
    return member_id


@pytest.mark.anyio
async def test_create_decision_request_dispatches_chat_card_to_org_admin():
    """create_decision_request 호출 한 번 → 승인 게이트 생성 + admin 챗에 approval_target 카드."""
    from app.routers.gates import DecisionRequestCreate, create_decision_request
    from app.dependencies.auth import AuthContext
    from app.models.conversation import Conversation, ConversationMessage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            admin_id = await _seed_admin_approver(s, org_id)
            requester_id = await _seed_agent_requester(s, org_id, project_id)

            body = DecisionRequestCreate(question="A로 갈지 B로 갈지?", assumption="A가 기본값")
            auth = AuthContext(user_id=str(requester_id), email=None, claims={}, org_id=str(org_id))
            resp = await create_decision_request(
                body=body, session=s,
                scope={"org_id": org_id, "project_id": project_id}, auth=auth,
            )
            assert resp.status == "pending"

            msgs = (await s.execute(
                select(ConversationMessage).join(
                    Conversation, Conversation.id == ConversationMessage.conversation_id
                ).where(Conversation.org_id == org_id)
            )).scalars().all()
            cards = [m for m in msgs if (m.msg_metadata or {}).get("approval_target")]
            assert len(cards) == 1, "admin 1명 = 카드 1장(TeamMember 우선 검색으로 admin 본인이 잘못 배제되지 않음)"
            target = cards[0].msg_metadata["approval_target"]
            assert target["work_item_type"] == "agent_decision"
            assert target["work_item_id"] == str(resp.id)
            assert target["gate_id"] == str(resp.id)
            assert target["actions"] == ["approve", "reject"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_decision_request_no_approver_no_crash():
    """org owner/admin이 0명이면 카드 0장 — 상신 자체는 여전히 성공(best-effort 비중단)."""
    from app.routers.gates import DecisionRequestCreate, create_decision_request
    from app.dependencies.auth import AuthContext
    from app.models.conversation import Conversation, ConversationMessage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_agent_requester(s, org_id, project_id)

            body = DecisionRequestCreate(question="블로킹 질문", assumption="가정")
            auth = AuthContext(user_id=str(requester_id), email=None, claims={}, org_id=str(org_id))
            resp = await create_decision_request(
                body=body, session=s,
                scope={"org_id": org_id, "project_id": project_id}, auth=auth,
            )
            assert resp.status == "pending"

            msgs = (await s.execute(
                select(ConversationMessage).join(
                    Conversation, Conversation.id == ConversationMessage.conversation_id
                ).where(Conversation.org_id == org_id)
            )).scalars().all()
            assert len(msgs) == 0
    finally:
        await engine.dispose()
