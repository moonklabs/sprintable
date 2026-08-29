"""story #3159(retention·최소층) — activation 체크리스트/리마인드 SQL 실측.

서비스 유닛 테스트는 mock이라 조인/순서조건 SQL 자체를 실측 못 한다(sprint-loop realdb
테스트와 동일 근거) — 특히 is_org_first_roundtrip_done의 "휴먼 발신 이후" 순서조건(#3157
디디 대조 확定 조건)은 실 Postgres 없이는 회귀를 못 잡는다.

team_members는 물리테이블이 아니라 members ⋈ project_access(휴먼)/agent_project_profiles
(에이전트) UNION ALL 뷰(migration 0088) — 그래서 여기선 team_members가 아니라 그 원천
테이블(members/project_access/agent_project_profiles)에 직접 seed한다(뷰는 read-only 투영).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.services import onboarding_activation as svc

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = "ee000000-0000-0000-0000-0000000000e1"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _wipe(s, org_id: str) -> None:
    for sql in [
        f"DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id='{org_id}')",
        f"DELETE FROM conversations WHERE org_id='{org_id}'",
        f"DELETE FROM agent_project_profiles WHERE member_id IN (SELECT id FROM members WHERE org_id='{org_id}')",
        f"DELETE FROM project_access WHERE project_id IN (SELECT id FROM projects WHERE org_id='{org_id}')",
        f"DELETE FROM members WHERE org_id='{org_id}'",
        f"DELETE FROM org_members WHERE org_id='{org_id}'",
        f"DELETE FROM projects WHERE org_id='{org_id}'",
        f"DELETE FROM users WHERE email LIKE 'story3159-%'",
        f"DELETE FROM organizations WHERE id='{org_id}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


def _uuid() -> str:
    return str(uuid.uuid4())


@pytest.mark.anyio
async def test_get_owner_org_id_only_owner_role():
    eng, Session = await _engine()
    async with Session() as s:
        await _wipe(s, ORG)
        try:
            org2 = _uuid()
            owner_user, member_user = _uuid(), _uuid()
            om_owner, om_member = _uuid(), _uuid()
            await s.execute(text(
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','story3159-o','free'),"
                f"('{org2}','O2','story3159-o2','free')"
            ))
            await s.execute(text(
                "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
                "login_fail_count,totp_enabled,totp_fail_count) VALUES "
                f"('{owner_user}','story3159-owner@t.test','x','U',true,false,0,false,0),"
                f"('{member_user}','story3159-member@t.test','x','U2',true,false,0,false,0)"
            ))
            await s.execute(text(
                f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
                f"('{om_owner}','{ORG}','{owner_user}','owner'),"
                f"('{om_member}','{org2}','{member_user}','member')"
            ))
            await s.commit()

            owner_org = await svc.get_owner_org_id(s, uuid.UUID(owner_user))
            member_org = await svc.get_owner_org_id(s, uuid.UUID(member_user))
            assert str(owner_org) == ORG
            assert member_org is None
        finally:
            await _wipe(s, ORG)
            await s.execute(text(f"DELETE FROM organizations WHERE id='{org2}'"))
            await s.commit()
    await eng.dispose()


@pytest.mark.anyio
async def test_is_org_agent_connected_requires_real_verify_not_just_member_record():
    """story #3193 근본수정 — 예전엔 agent 멤버 레코드 **존재**만으로 True였다("생성"을
    "연결"로 오판정: 연결 스텝을 건너뛰어도 레코드는 남아 체크리스트가 거짓 완료를 표시
    했다, 실사고 재현). 지금은 get_verified_map()(#2751②, 워크포스 "연결 안 됨" CTA와
    동일 판별자)의 stdio verify 왕복(acked_seq>=verify_seq)을 요구한다."""
    from app.services.agent_verify import start_verification
    from app.models.agent_gateway import AgentEventCursor

    eng, Session = await _engine()
    async with Session() as s:
        await _wipe(s, ORG)
        try:
            proj = _uuid()
            human_member, agent_member = _uuid(), _uuid()
            app_id = _uuid()
            await s.execute(text(
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','story3159-o','free')"
            ))
            await s.execute(text(
                f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{proj}','{ORG}','P','none')"
            ))
            await s.execute(text(
                f"INSERT INTO members (id,org_id,type,name) VALUES ('{human_member}','{ORG}','human','H')"
            ))
            assert (await svc.is_org_agent_connected(s, uuid.UUID(ORG))) is False

            await s.execute(text(
                f"INSERT INTO members (id,org_id,type,name) VALUES ('{agent_member}','{ORG}','agent','A')"
            ))
            await s.execute(text(
                f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES ('{app_id}','{agent_member}','{proj}')"
            ))
            await s.commit()
            # 레코드만 생성 — 연결 스텝을 건너뛴(verify 왕복 0) 정확한 실사고 재현. 예전
            # 판별자였다면 여기서 True로 거짓 완료를 표시했다.
            assert (await svc.is_org_agent_connected(s, uuid.UUID(ORG))) is False

            # 실연결 완주(verify Event 발급 + ack) — 이제야 True.
            seq = await start_verification(
                s, agent_id=uuid.UUID(agent_member), org_id=uuid.UUID(ORG), project_id=uuid.UUID(proj),
            )
            await s.commit()
            s.add(AgentEventCursor(agent_id=uuid.UUID(agent_member), acked_seq=seq))
            await s.commit()
            assert (await svc.is_org_agent_connected(s, uuid.UUID(ORG))) is True
        finally:
            await _wipe(s, ORG)
    await eng.dispose()


@pytest.mark.anyio
async def test_is_org_agent_connected_falls_back_to_roundtrip_for_http_agents():
    """PO 스티어(2026-08-28, PR#3595 리뷰) — http-transport(온보딩 권장 탭·주 경로)는
    get_verified_map의 durable 신호가 애초에 없다. verify 신호 0(get_verified_map 전부
    False)이어도 첫 왕복(휴먼→에이전트 응답)까지 이미 완주했으면 "연결"은 참이어야 한다
    (왕복이 연결의 논리적 함의) — 안 그러면 실연결 회원의 체크리스트가 영구 미체크로
    뒤집힌다(결함 방향 반전, PO 적발)."""
    eng, Session = await _engine()
    async with Session() as s:
        await _wipe(s, ORG)
        try:
            proj = _uuid()
            human_member, agent_member = _uuid(), _uuid()
            app_id = _uuid()
            await s.execute(text(
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','story3159-o','free')"
            ))
            await s.execute(text(
                f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{proj}','{ORG}','P','none')"
            ))
            await s.execute(text(
                f"INSERT INTO members (id,org_id,type,name) VALUES "
                f"('{human_member}','{ORG}','human','H'),('{agent_member}','{ORG}','agent','A')"
            ))
            await s.execute(text(
                f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES ('{app_id}','{agent_member}','{proj}')"
            ))
            await s.execute(text(
                f"INSERT INTO project_access (id,project_id,member_id,role) VALUES ('{_uuid()}','{proj}','{human_member}','member')"
            ))
            await s.commit()
            # verify Event/AgentEventCursor 0건(http 시나리오 모사) — get_verified_map 단독이면 False.
            assert (await svc.is_org_agent_connected(s, uuid.UUID(ORG))) is False

            now = datetime.now(timezone.utc)
            t0, t1 = now - timedelta(hours=1), now
            conv = _uuid()
            await s.execute(text(
                f"INSERT INTO conversations (id,org_id,project_id,type) VALUES ('{conv}','{ORG}','{proj}','group')"
            ))
            await s.execute(text(
                f"INSERT INTO conversation_messages (id,conversation_id,sender_id,content,created_at) VALUES "
                f"('{_uuid()}','{conv}','{human_member}','human-first','{t0.isoformat()}'),"
                f"('{_uuid()}','{conv}','{agent_member}','agent-reply','{t1.isoformat()}')"
            ))
            await s.commit()
            assert (await svc.is_org_agent_connected(s, uuid.UUID(ORG))) is True
        finally:
            await _wipe(s, ORG)
    await eng.dispose()


@pytest.mark.anyio
async def test_get_first_instruction_conversation_id_priority_order():
    """story #3201 — 체크리스트 "첫 지시…" 클릭 딥링크 타겟. PO 확定 우선순위 3단:
    ①org 대화 0건→None ②DM만 있고 왕복 前→org 최초 agent DM ③왕복 성사된 대화가
    있으면 그게 최우선(DM 여러 개 중에서도)."""
    eng, Session = await _engine()
    async with Session() as s:
        await _wipe(s, ORG)
        try:
            proj = _uuid()
            human_member, agent_member = _uuid(), _uuid()
            app_id = _uuid()
            await s.execute(text(
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','story3159-o','free')"
            ))
            await s.execute(text(
                f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{proj}','{ORG}','P','none')"
            ))
            await s.execute(text(
                f"INSERT INTO members (id,org_id,type,name) VALUES "
                f"('{human_member}','{ORG}','human','H'),('{agent_member}','{ORG}','agent','A')"
            ))
            await s.execute(text(
                f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES ('{app_id}','{agent_member}','{proj}')"
            ))
            await s.execute(text(
                f"INSERT INTO project_access (id,project_id,member_id,role) VALUES ('{_uuid()}','{proj}','{human_member}','member')"
            ))
            await s.commit()

            # ① org에 대화 0건 — None.
            assert (await svc.get_first_instruction_conversation_id(s, uuid.UUID(ORG))) is None

            # ② DM 1개 생성(왕복 前) — 그 DM이 반환돼야.
            dm1 = _uuid()
            await s.execute(text(
                f"INSERT INTO conversations (id,org_id,project_id,type,created_at) VALUES "
                f"('{dm1}','{ORG}','{proj}','dm', now() - interval '2 hours')"
            ))
            await s.execute(text(
                f"INSERT INTO conversation_participants (id,conversation_id,member_id) VALUES "
                f"('{_uuid()}','{dm1}','{human_member}'),('{_uuid()}','{dm1}','{agent_member}')"
            ))
            await s.commit()
            result = await svc.get_first_instruction_conversation_id(s, uuid.UUID(ORG))
            assert str(result) == dm1

            # ②b DM을 하나 더(더 이른 created_at) 만들면 org 최초(가장 이른) 쪽이 반환돼야.
            dm0 = _uuid()
            await s.execute(text(
                f"INSERT INTO conversations (id,org_id,project_id,type,created_at) VALUES "
                f"('{dm0}','{ORG}','{proj}','dm', now() - interval '3 hours')"
            ))
            await s.execute(text(
                f"INSERT INTO conversation_participants (id,conversation_id,member_id) VALUES "
                f"('{_uuid()}','{dm0}','{human_member}'),('{_uuid()}','{dm0}','{agent_member}')"
            ))
            await s.commit()
            result = await svc.get_first_instruction_conversation_id(s, uuid.UUID(ORG))
            assert str(result) == dm0

            # ③ 왕복(휴먼→에이전트 응답) 성사된 대화가 생기면, DM들보다 우선해 그게 반환돼야.
            roundtrip_conv = _uuid()
            now = datetime.now(timezone.utc)
            t0, t1 = now - timedelta(hours=1), now
            await s.execute(text(
                f"INSERT INTO conversations (id,org_id,project_id,type) VALUES ('{roundtrip_conv}','{ORG}','{proj}','group')"
            ))
            await s.execute(text(
                f"INSERT INTO conversation_messages (id,conversation_id,sender_id,content,created_at) VALUES "
                f"('{_uuid()}','{roundtrip_conv}','{human_member}','hi','{t0.isoformat()}'),"
                f"('{_uuid()}','{roundtrip_conv}','{agent_member}','hello','{t1.isoformat()}')"
            ))
            await s.commit()
            result = await svc.get_first_instruction_conversation_id(s, uuid.UUID(ORG))
            assert str(result) == roundtrip_conv
        finally:
            await _wipe(s, ORG)
    await eng.dispose()


@pytest.mark.anyio
async def test_is_org_first_roundtrip_order_sensitive():
    """디디 대조 확定 조건(#3157) — 존재만으론 불충분, 휴먼 발신 "이후"에 온 agent 발신이어야."""
    eng, Session = await _engine()
    async with Session() as s:
        await _wipe(s, ORG)
        try:
            proj = _uuid()
            human_member, agent_member = _uuid(), _uuid()
            app_id = _uuid()
            await s.execute(text(
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','story3159-o','free')"
            ))
            await s.execute(text(
                f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{proj}','{ORG}','P','none')"
            ))
            await s.execute(text(
                f"INSERT INTO members (id,org_id,type,name) VALUES "
                f"('{human_member}','{ORG}','human','H'),('{agent_member}','{ORG}','agent','A')"
            ))
            await s.execute(text(
                f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES ('{app_id}','{agent_member}','{proj}')"
            ))
            # team_members 뷰(migration 0088)의 휴먼 분기 = members ⋈ project_access(member_id) —
            # 이 grant 없이는 human_member가 뷰에 전혀 안 잡혀 sender join이 항상 빈다(1라운드
            # 실측에서 이 누락으로 assertion②가 False로 실패 — 회귀가드 겸 실제 발견).
            await s.execute(text(
                f"INSERT INTO project_access (id,project_id,member_id,role) VALUES ('{_uuid()}','{proj}','{human_member}','member')"
            ))
            await s.commit()

            now = datetime.now(timezone.utc)
            t0, t1, t2 = now - timedelta(hours=2), now - timedelta(hours=1), now

            # ① 순서 위반: agent 먼저(t0) 발신, human 나중(t1) — 그 agent 메시지엔 "이전" human이 없다.
            conv1 = _uuid()
            await s.execute(text(
                f"INSERT INTO conversations (id,org_id,project_id,type) VALUES ('{conv1}','{ORG}','{proj}','group')"
            ))
            await s.execute(text(
                f"INSERT INTO conversation_messages (id,conversation_id,sender_id,content,created_at) VALUES "
                f"('{_uuid()}','{conv1}','{agent_member}','agent-first','{t0.isoformat()}'),"
                f"('{_uuid()}','{conv1}','{human_member}','human-second','{t1.isoformat()}')"
            ))
            await s.commit()
            assert (await svc.is_org_first_roundtrip_done(s, uuid.UUID(ORG))) is False

            # ② 순서 충족: 다른 conversation에서 human(t1) 먼저, agent(t2) 나중.
            conv2 = _uuid()
            await s.execute(text(
                f"INSERT INTO conversations (id,org_id,project_id,type) VALUES ('{conv2}','{ORG}','{proj}','group')"
            ))
            await s.execute(text(
                f"INSERT INTO conversation_messages (id,conversation_id,sender_id,content,created_at) VALUES "
                f"('{_uuid()}','{conv2}','{human_member}','human-first','{t1.isoformat()}'),"
                f"('{_uuid()}','{conv2}','{agent_member}','agent-reply','{t2.isoformat()}')"
            ))
            await s.commit()
            assert (await svc.is_org_first_roundtrip_done(s, uuid.UUID(ORG))) is True
        finally:
            await _wipe(s, ORG)
    await eng.dispose()


@pytest.mark.anyio
async def test_find_reminder_candidates_window_dedup_optout_complete():
    eng, Session = await _engine()
    async with Session() as s:
        await _wipe(s, ORG)
        try:
            now = datetime.now(timezone.utc)
            too_recent = now - timedelta(hours=10)   # < 24h — 아직 대상 아님
            in_window = now - timedelta(hours=30)     # [24h,48h) — 대상
            too_old = now - timedelta(hours=60)       # ≥48h — 이미 지난 창(누락 방지 상한)
            already_sent = now - timedelta(hours=30)

            u_recent, u_candidate, u_old, u_sent, u_optout = [_uuid() for _ in range(5)]
            rows = [
                (u_recent, 'story3159-recent@t.test', too_recent, None, False),
                (u_candidate, 'story3159-candidate@t.test', in_window, None, False),
                (u_old, 'story3159-old@t.test', too_old, None, False),
                (u_sent, 'story3159-sent@t.test', in_window, already_sent, False),
                (u_optout, 'story3159-optout@t.test', in_window, None, True),
            ]
            for uid, email, created, sent_at, opt in rows:
                sent_sql = f"'{sent_at.isoformat()}'" if sent_at else "NULL"
                await s.execute(text(
                    "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
                    "login_fail_count,totp_enabled,totp_fail_count,created_at,onboarding_reminder_sent_at,"
                    "marketing_email_opt_out) VALUES "
                    f"('{uid}','{email}','x','U',true,false,0,false,0,'{created.isoformat()}',{sent_sql},{opt})"
                ))
            await s.commit()

            candidates = await svc.find_reminder_candidates(s, now=now)
            candidate_ids = {str(u.id) for u in candidates}
            assert u_candidate in candidate_ids
            assert u_recent not in candidate_ids
            assert u_old not in candidate_ids
            assert u_sent not in candidate_ids
            assert u_optout not in candidate_ids
        finally:
            await _wipe(s, ORG)
    await eng.dispose()
