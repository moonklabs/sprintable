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
            # 카디르 CRITICAL(PR #3435 QA) — 실 JWT 휴먼 인증 재현(_seed_human_caller,
            # 아래 정의). auth.user_id에는 User.id를, resolve_member가 그걸로 OrgMember를
            # 역해소한다(member_resolver.py 휴먼 분기) — org_member.id를 auth.user_id에
            # 직접 넣던 구관례(_seed_agent_requester)는 이 버그 클래스를 못 잡았다.
            requester_user_id, _requester_member_id = await _seed_human_caller(s, org_id)

            # story #3004(선생님 정책 확定 2026-08-24) — approver_member_id가 이제 필수(미지정
            # 400). 지정한다고 카드 수가 바뀌지 않는(이 worktree는 #3001 배타화 이전 상태라
            # 여전히 지정자=액션 카드 1장 — admin이 org에 1명뿐이라 어느 쪽이든 1장).
            body = DecisionRequestCreate(question="A로 갈지 B로 갈지?", assumption="A가 기본값", approver_member_id=admin_id)
            auth = AuthContext(user_id=str(requester_user_id), email=None, claims={}, org_id=str(org_id))
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
async def test_create_decision_request_missing_approver_rejected():
    """story #3004(선생님 정책 확定 2026-08-24) — 「받는 사람이 없는 결재는 존재할 수 없다」.
    이 테스트는 원래(#2891) "org owner/admin 0명 → 카드 0장·상신은 성공"을 검증했으나, 그
    시나리오 자체가 이제 도달 불가(approver_member_id 미지정은 org 상태와 무관하게 즉시
    400 — best-effort 폴백이 아니라 생성 자체를 막는 hard reject)."""
    from fastapi import HTTPException

    from app.routers.gates import DecisionRequestCreate, create_decision_request
    from app.dependencies.auth import AuthContext

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_user_id, _requester_member_id = await _seed_human_caller(s, org_id)

            body = DecisionRequestCreate(question="블로킹 질문", assumption="가정")
            auth = AuthContext(user_id=str(requester_user_id), email=None, claims={}, org_id=str(org_id))
            with pytest.raises(HTTPException) as exc_info:
                await create_decision_request(
                    body=body, session=s,
                    scope={"org_id": org_id, "project_id": project_id}, auth=auth,
                )
            assert exc_info.value.status_code == 400
            assert exc_info.value.detail["code"] == "APPROVER_REQUIRED"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_decision_request_ineligible_approver_rejected():
    """story #3004 — approver_member_id를 지정해도 owner/admin이 아니면(자격 밖) 400."""
    from fastapi import HTTPException

    from app.routers.gates import DecisionRequestCreate, create_decision_request
    from app.dependencies.auth import AuthContext

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_user_id, _requester_member_id = await _seed_human_caller(s, org_id)
            not_approver_id = await _seed_agent_requester(s, org_id, project_id)  # role=member(순수 대상, 호출자 아님)

            body = DecisionRequestCreate(question="블로킹 질문", assumption="가정", approver_member_id=not_approver_id)
            auth = AuthContext(user_id=str(requester_user_id), email=None, claims={}, org_id=str(org_id))
            with pytest.raises(HTTPException) as exc_info:
                await create_decision_request(
                    body=body, session=s,
                    scope={"org_id": org_id, "project_id": project_id}, auth=auth,
                )
            assert exc_info.value.status_code == 400
            assert exc_info.value.detail["code"] == "APPROVER_INELIGIBLE"
    finally:
        await engine.dispose()


async def _seed_human_caller(session, org_id):
    """카디르 CRITICAL(PR #3435 QA, 2026-08-24) — 실 JWT 휴먼 인증 재현. User.id(=auth.user_id)
    와 OrgMember.id(=member_id, 응답/비교에 쓰이는 값)를 **서로 다른 UUID**로 seed한다 —
    _seed_agent_requester()는 API-key(에이전트) 관례를 흉내 내 auth.user_id에 org_member.id를
    그대로 넣으므로 두 공간이 우연히 일치해 이 버그 클래스를 못 잡는다(회귀 놓친 원인)."""
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"human-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=user_id, role="member"))
    await session.commit()
    return user_id, member_id


@pytest.mark.anyio
async def test_create_decision_request_human_caller_self_designation_rejected():
    """카디르 CRITICAL(PR #3435 QA) 회귀가드 — 인간 호출자가 자신의 approver_member_id
    (org_members.id)를 그대로 지정해도 422로 거부돼야 한다. 수정 前: create_decision_request가
    caller_id=uuid.UUID(auth.user_id)(=users.id 공간)를 approver_member_id(org_members.id
    공간)와 직접 비교해 인간 호출자에겐 그 둘이 애초에 절대 같을 수 없으므로 이 가드가 원천
    무력화(본인지정이 201로 성공) — 이 테스트가 그 재현+수정 확認."""
    from fastapi import HTTPException

    from app.routers.gates import DecisionRequestCreate, create_decision_request
    from app.dependencies.auth import AuthContext

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            caller_user_id, caller_member_id = await _seed_human_caller(s, org_id)

            body = DecisionRequestCreate(question="블로킹 질문", assumption="가정", approver_member_id=caller_member_id)
            # claims에 api_key_id가 없으므로 resolve_member가 JWT-휴먼 분기(OrgMember.user_id
            # 매칭)를 탄다 — is_api_key=False, member_resolver.py:64 참조.
            auth = AuthContext(user_id=str(caller_user_id), email=None, claims={}, org_id=str(org_id))
            with pytest.raises(HTTPException) as exc_info:
                await create_decision_request(
                    body=body, session=s,
                    scope={"org_id": org_id, "project_id": project_id}, auth=auth,
                )
            assert exc_info.value.status_code == 422
            assert exc_info.value.detail["code"] == "APPROVER_SELF_NOT_ALLOWED"
    finally:
        await engine.dispose()
