"""story #2697 — get_conversation() 인가 SSOT 통일(conversation_readable_predicate 경유) +
프로젝트 스코프 음성대조 realdb 실증.

배경: get_conversation()이 conversation_readable_predicate SSOT(§6회차 — backlinks.py·
list_conversations·_can_read_conversation이 이미 쓰던 canonical judge)로 안 옮겨간 마지막
소비자였다(_effective_org_role의 사전 해소 + 별도 participant SELECT를 썼다). #2697에서
_can_read_conversation()으로 통일하고, 403("Not a participant")을 다른 리소스(goals·
stories·sprints·retros·gates) 다수 관례에 맞춰 404(존재-비노출)로 바꿨다.

이 파일은 그 마이그레이션의 endpoint 레벨 회귀 0(admin bypass 유지·human-participant
privacy carve-out 유지)와, 스토리의 원 관심사(same-org cross-project read)를 실PG로
직접 검증한다. predicate 자체의 세부 의미론(admin_bypass_eligible atom·project_access_
valid revoke barrier 등)은 test_1994_backlink_api_realdb.py가 이미 훨씬 깊게 커버 —
여기서는 재검증하지 않는다(중복 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
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


async def _seed_human(session, *, org_id, project_id, role="member"):
    """휴먼 1명: users+org_members+team_members를 같은 id로(E-MEMBER-SSOT AC2-1 불변식 —
    members.id == org_members.id를 로컬 create_all에서 수동으로 재현)."""
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.team import TeamMember
    from app.models.user import User

    user_id = uuid.uuid4()
    member_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"u-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=user_id, role=role))
    session.add(TeamMember(
        id=member_id, org_id=org_id, project_id=project_id, user_id=user_id,
        type="human", name=f"h-{member_id.hex[:6]}", role=("owner" if role == "owner" else "member"),
    ))
    await session.commit()
    return user_id, member_id


async def _seed_agent(session, *, org_id, project_id):
    from app.models.team import TeamMember

    member_id = uuid.uuid4()
    session.add(TeamMember(
        id=member_id, org_id=org_id, project_id=project_id, user_id=None,
        type="agent", name=f"a-{member_id.hex[:6]}", role="member",
    ))
    await session.commit()
    return member_id


async def _seed_conversation(session, *, org_id, project_id, participant_ids):
    from app.models.conversation import Conversation, ConversationParticipant

    conv_id = uuid.uuid4()
    session.add(Conversation(
        id=conv_id, org_id=org_id, project_id=project_id, type="group",
        title="t", created_by=participant_ids[0] if participant_ids else None,
    ))
    await session.commit()
    for mid in participant_ids:
        session.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=conv_id, member_id=mid))
    await session.commit()
    return conv_id


def _auth_for(user_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=None)


@pytest.mark.anyio
async def test_admin_nonparticipant_agent_only_conv_still_200_after_migration():
    """회귀 0: org admin이 참가 안 한 agent-only 대화는 여전히 200(admin-bypass 유지)."""
    from app.routers.conversations import get_conversation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.organization import Organization
            from app.models.project import Project
            org_id, project_id = uuid.uuid4(), uuid.uuid4()
            s.add(Organization(id=org_id, name="Org", slug=f"org-{org_id.hex[:8]}"))
            await s.commit()
            s.add(Project(id=project_id, org_id=org_id, name="P"))
            await s.commit()
            admin_user_id, _admin_member_id = await _seed_human(s, org_id=org_id, project_id=project_id, role="admin")
            a1 = await _seed_agent(s, org_id=org_id, project_id=project_id)
            a2 = await _seed_agent(s, org_id=org_id, project_id=project_id)
            conv_id = await _seed_conversation(s, org_id=org_id, project_id=project_id, participant_ids=[a1, a2])

            resp = await get_conversation(conv_id, db=s, auth=_auth_for(admin_user_id), org_id=org_id)
            assert resp.id == conv_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_admin_nonparticipant_human_conv_now_404_not_403():
    """§ 상태코드 통일: admin 비참가 + 휴먼 참가(private) 대화 — 구 403 "Not a participant"가
    다른 리소스 다수 관례(존재-비노출)에 맞춰 404가 됐다(story #2697 AC②)."""
    from fastapi import HTTPException
    from app.routers.conversations import get_conversation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.organization import Organization
            from app.models.project import Project
            org_id, project_id = uuid.uuid4(), uuid.uuid4()
            s.add(Organization(id=org_id, name="Org", slug=f"org-{org_id.hex[:8]}"))
            await s.commit()
            s.add(Project(id=project_id, org_id=org_id, name="P"))
            await s.commit()
            admin_user_id, _ = await _seed_human(s, org_id=org_id, project_id=project_id, role="admin")
            other_human_user_id, other_human_id = await _seed_human(s, org_id=org_id, project_id=project_id)
            agent = await _seed_agent(s, org_id=org_id, project_id=project_id)
            conv_id = await _seed_conversation(
                s, org_id=org_id, project_id=project_id, participant_ids=[other_human_id, agent],
            )

            with pytest.raises(HTTPException) as ei:
                await get_conversation(conv_id, db=s, auth=_auth_for(admin_user_id), org_id=org_id)
            assert ei.value.status_code == 404, f"privacy carve-out 유지되나 상태코드는 404여야: {ei.value.status_code}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_nonadmin_member_of_different_project_cannot_read_conversation():
    """story #2697 핵심 — same-org cross-project read. 이 대화의 project(A)에 접근권이 아예
    없는(다른 project B에만 소속된) 비-admin 멤버가 conversation_id만 알고 GET → 404여야
    한다(«ID만 알면 타 프로젝트 데이터가 200» 결함 클래스의 conversations 축)."""
    from fastapi import HTTPException
    from app.routers.conversations import get_conversation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.organization import Organization
            from app.models.project import Project
            org_id = uuid.uuid4()
            project_a, project_b = uuid.uuid4(), uuid.uuid4()
            s.add(Organization(id=org_id, name="Org", slug=f"org-{org_id.hex[:8]}"))
            await s.commit()
            s.add(Project(id=project_a, org_id=org_id, name="A"))
            s.add(Project(id=project_b, org_id=org_id, name="B"))
            await s.commit()
            # outsider: project B 소속뿐(project A 접근권 0) — non-admin.
            outsider_user_id, _outsider_id = await _seed_human(s, org_id=org_id, project_id=project_b)
            a1 = await _seed_agent(s, org_id=org_id, project_id=project_a)
            a2 = await _seed_agent(s, org_id=org_id, project_id=project_a)
            conv_id = await _seed_conversation(
                s, org_id=org_id, project_id=project_a, participant_ids=[a1, a2],
            )

            with pytest.raises(HTTPException) as ei:
                await get_conversation(conv_id, db=s, auth=_auth_for(outsider_user_id), org_id=org_id)
            assert ei.value.status_code == 404, (
                f"project B 소속 비-admin이 project A의 대화를 읽을 수 있으면 안 됨 — got {ei.value.status_code}"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_own_participation_still_reads_own_conversation():
    """무회귀: 실제 참가자 본인은 여전히 정상 200(admin 여부 무관)."""
    from app.routers.conversations import get_conversation

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.organization import Organization
            from app.models.project import Project
            org_id, project_id = uuid.uuid4(), uuid.uuid4()
            s.add(Organization(id=org_id, name="Org", slug=f"org-{org_id.hex[:8]}"))
            await s.commit()
            s.add(Project(id=project_id, org_id=org_id, name="P"))
            await s.commit()
            member_user_id, member_id = await _seed_human(s, org_id=org_id, project_id=project_id)
            agent = await _seed_agent(s, org_id=org_id, project_id=project_id)
            conv_id = await _seed_conversation(
                s, org_id=org_id, project_id=project_id, participant_ids=[member_id, agent],
            )

            resp = await get_conversation(conv_id, db=s, auth=_auth_for(member_user_id), org_id=org_id)
            assert resp.id == conv_id
    finally:
        await engine.dispose()
