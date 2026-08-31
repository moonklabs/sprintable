"""story #3159(retention·최소층) — activation 체크리스트 + 미완주 리마인드 메일.

단계 정의는 #3157(디디 activation 깔때기 측정)과 1:1 대조 확定(2026-08-27, 페드루 중계):
①가입=users.created_at ②이메일인증=users.email_verified ③org생성=org_members role='owner'
최초 행 ④에이전트연결=그 org에 실연결(stdio verify 왕복 완주 또는 첫 왕복 완주로 함의)된
에이전트 존재(owner 필터 없음 — org 단위 사실, 초대 멤버가 연결해도 그 org는 완주. story
#3193 근본수정 — 원래는 team_members(type='agent') **존재**만 봐서 "생성"을 "연결"로
오판정했다, is_org_agent_connected 참고) ⑤첫왕복=그 org conversation에서 휴먼 발신 메시지
"이후"에 온 최초 agent 발신 메시지(존재만으론 불충분 — 순서조건, #3157과 동형 판정).

③만 owner 축 유지 — "이 유저에게 org를 귀속"하는 목적(리마인드 대상 선별)이라 초대 멤버는
자기 org를 "만든" 게 아니므로 대상에서 빠진다. ④⑤는 org_id 직스코프(누가 연결/왕복했든
그 org는 완주).
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.project import OrgMember
from app.models.team import TeamMember
from app.models.user import User

logger = logging.getLogger(__name__)


async def get_owner_org_id(db: AsyncSession, user_id: uuid.UUID) -> uuid.UUID | None:
    """가입 유저가 owner인 org(=본인이 만든 org) 최초 행. 초대 멤버는 None."""
    return (await db.execute(
        select(OrgMember.org_id)
        .where(OrgMember.user_id == user_id, OrgMember.role == "owner")
        .order_by(OrgMember.created_at.asc())
        .limit(1)
    )).scalar_one_or_none()


async def is_org_agent_connected(db: AsyncSession, org_id: uuid.UUID) -> bool:
    """org 단위 사실 — 실연결(stdio verify 왕복 완주) 에이전트가 하나라도 있거나, 이미
    첫 왕복(휴먼→에이전트 응답)까지 완주했으면 True.

    story #3193 근본수정 — 예전엔 `TeamMember(type='agent')` **존재**만 봤다("레코드 생성"을
    "연결"로 오판정: 연결 스텝을 건너뛰어도 에이전트 레코드는 남아 체크리스트가 거짓
    완료를 표시했다). `get_verified_map()`(워크포스 목록 "연결 안 됨" CTA와 완전히 동일한
    판별자 — story #2751②, `acked_seq >= verify_seq`)을 그대로 재사용한다 — 두 벌 판별자
    금지(PO 지시).

    ⛔PO 스티어(2026-08-28, PR#3595 리뷰) — get_verified_map만으로 끝내면 반쪽이었다.
    http-transport(온보딩 권장 탭·주 경로)는 이 durable 신호가 애초에 없어(agent_verify.py
    상단 docstring), get_verified_map만 쓰면 **실제로 첫 왕복까지 완주한 org조차 "연결"
    항목이 영구 미체크**로 뒤집힌다(CTA에선 무해한 위음성이 체크리스트에선 결함 방향이
    반전). `is_org_first_roundtrip_done()`을 OR로 더한다 — 왕복 완주는 "에이전트가
    연결됐다"의 논리적 함의(에이전트가 응답하려면 연결돼 있어야 한다)를 이미 갖고 있는
    **기존 사실의 재사용**이지, 새 판별자 발명이 아니다. 왕복 前·http 위음성 잔여는
    story #3197(durable http verified 신호 신설)로 분리 — 이 함수 범위 밖."""
    agent_ids = [
        row[0] for row in (await db.execute(
            select(TeamMember.id).where(TeamMember.org_id == org_id, TeamMember.type == "agent")
        )).all()
    ]
    if agent_ids:
        from app.services.agent_verify import get_verified_map
        verified_map = await get_verified_map(db, agent_ids)
        if any(verified_map.values()):
            return True
    return await is_org_first_roundtrip_done(db, org_id)


async def is_org_first_roundtrip_done(db: AsyncSession, org_id: uuid.UUID) -> bool:
    """휴먼 발신 메시지 "이후"에 온 최초 agent 발신 메시지 존재(같은 conversation 안 순서조건).
    존재만 보면 #3157과 어긋난다(디디 지적) — 반드시 human_msg.created_at < agent_msg.created_at."""
    HumanMsg = aliased(ConversationMessage)
    HumanSender = aliased(TeamMember)
    AgentSender = aliased(TeamMember)

    human_before = (
        select(HumanMsg.id)
        .join(HumanSender, HumanSender.id == HumanMsg.sender_id)
        .where(
            HumanMsg.conversation_id == ConversationMessage.conversation_id,
            HumanSender.type == "human",
            HumanMsg.created_at < ConversationMessage.created_at,
        )
        .exists()
    )
    stmt = (
        select(ConversationMessage.id)
        .join(AgentSender, AgentSender.id == ConversationMessage.sender_id)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(
            Conversation.org_id == org_id,
            AgentSender.type == "agent",
            human_before,
        )
        .limit(1)
    )
    row = (await db.execute(stmt)).first()
    return row is not None


async def get_first_instruction_conversation_id(db: AsyncSession, org_id: uuid.UUID) -> uuid.UUID | None:
    """story #3201 — 체크리스트 "첫 지시 보내고 회신 받기" 클릭의 딥링크 타겟.

    DM 생성(`POST /api/conversations`)이 의도적으로 always-new라서(EF-S2/db75ecd0,
    uq_conversations_dm_pair도 과거에 일부러 drop됨) "그 에이전트와의 대화"가 BE에 원래
    자명하지 않다. PO 확定(2026-08-29) 우선순위 3단:
      ①왕복(휴먼→에이전트 응답) 성사된 그 대화(가장 이른 것) — is_org_first_roundtrip_done과
        동일 조인, SELECT 대상만 conversation id로 바꾼 것(두 벌 판정 로직 아님).
      ②없으면 org 최초(created_at 가장 이른) agent 참여 DM.
      ③그것도 없으면 None — FE는 None이면 신규 DM 생성 CTA(story #3201 A안)를 그대로
        재사용한다(제3의 경로 발명 금지, PO 지시).
    """
    HumanMsg = aliased(ConversationMessage)
    HumanSender = aliased(TeamMember)
    AgentSender = aliased(TeamMember)

    human_before = (
        select(HumanMsg.id)
        .join(HumanSender, HumanSender.id == HumanMsg.sender_id)
        .where(
            HumanMsg.conversation_id == ConversationMessage.conversation_id,
            HumanSender.type == "human",
            HumanMsg.created_at < ConversationMessage.created_at,
        )
        .exists()
    )
    roundtrip_conv_id = (await db.execute(
        select(Conversation.id)
        .join(ConversationMessage, ConversationMessage.conversation_id == Conversation.id)
        .join(AgentSender, AgentSender.id == ConversationMessage.sender_id)
        .where(
            Conversation.org_id == org_id,
            AgentSender.type == "agent",
            human_before,
        )
        .order_by(ConversationMessage.created_at.asc())
        .limit(1)
    )).scalar_one_or_none()
    if roundtrip_conv_id is not None:
        return roundtrip_conv_id

    return (await db.execute(
        select(Conversation.id)
        .join(ConversationParticipant, ConversationParticipant.conversation_id == Conversation.id)
        .join(TeamMember, TeamMember.id == ConversationParticipant.member_id)
        .where(
            Conversation.org_id == org_id,
            Conversation.type == "dm",
            TeamMember.type == "agent",
        )
        .order_by(Conversation.created_at.asc())
        .limit(1)
    )).scalar_one_or_none()


async def get_activation_state(db: AsyncSession, user: User) -> dict:
    """체크리스트/리마인드 공용 — 5단계 완료 여부 + 요약."""
    org_id = await get_owner_org_id(db, user.id)
    agent_connected = await is_org_agent_connected(db, org_id) if org_id else False
    roundtrip_done = await is_org_first_roundtrip_done(db, org_id) if org_id else False
    # story #3201 — 체크리스트 "첫 지시…" 항목 클릭 딥링크. org_id 없으면(온보딩 미완주)
    # 애초에 org 스코프 쿼리 자체가 무의미 — None(FE 신규 DM CTA 폴백).
    first_instruction_conv_id = (
        await get_first_instruction_conversation_id(db, org_id) if org_id else None
    )
    steps = {
        "signed_up": True,
        "email_verified": user.email_verified,
        "org_created": org_id is not None,
        "agent_connected": agent_connected,
        "first_roundtrip": roundtrip_done,
    }
    completed = sum(1 for v in steps.values() if v)
    return {
        "steps": steps,
        "completed": completed,
        "total": len(steps),
        "all_complete": completed == len(steps),
        "first_instruction_conversation_id": (
            str(first_instruction_conv_id) if first_instruction_conv_id else None
        ),
    }


# ─── 리마인드 스윕(BE SoT·cron) ────────────────────────────────────────────────

REMINDER_WINDOW_START_HOURS = 24  # 이 시점 이후에야 대상
REMINDER_WINDOW_END_HOURS = 48    # cron 주기 갭으로 인한 누락 방지용 상한(이 시점 넘으면 skip)


async def find_reminder_candidates(db: AsyncSession, *, now: datetime | None = None) -> list[User]:
    """[now-48h, now-24h) 구간 가입자 중 미발송·미수신거부·미완주(all_complete=False)."""
    now = now or datetime.now(timezone.utc)
    window_start = now - timedelta(hours=REMINDER_WINDOW_END_HOURS)
    window_end = now - timedelta(hours=REMINDER_WINDOW_START_HOURS)
    rows = (await db.execute(
        select(User).where(
            User.created_at >= window_start,
            User.created_at < window_end,
            User.onboarding_reminder_sent_at.is_(None),
            User.marketing_email_opt_out.is_(False),
        )
    )).scalars().all()

    candidates: list[User] = []
    for u in rows:
        state = await get_activation_state(db, u)
        if not state["all_complete"]:
            candidates.append(u)
    return candidates


def _reminder_email_body(*, app_url: str, unsub_link: str, locale: str) -> str:
    from app.services.email import render_email_shell
    from app.services.email_copy import REMINDER_COPY
    copy = REMINDER_COPY[locale]
    # story #3206 — 트랜잭셔널 3종과 동형 버튼(bg+테두리, Gmail 다크 bg 소실에도 상자로 식별).
    content = (
        f"<p style='margin:0 0 10px'>{copy['intro']}</p>"
        f"<p style='margin:20px 0'>"
        f"<a href='{app_url}' style='display:inline-block;padding:12px 24px;background:#3157FF;"
        f"border:2px solid #3157FF;color:#ffffff;text-decoration:none;border-radius:6px;"
        f"font-weight:700;font-size:14px'>{copy['cta_label']}</a></p>"
        # 유나 design:pass 권장(2026-08-27) — #888은 흰 배경 대비 3.5:1로 AA(4.5) 미달.
        # #595959로 7:1(AAA) 확保.
        "<p style='font-size:12px;color:#595959;margin:0'>"
        f"<a href='{unsub_link}' style='color:#595959'>{copy['unsub_label']}</a></p>"
    )
    return render_email_shell(content, locale=locale)


async def send_activation_reminder(db: AsyncSession, user: User) -> bool:
    """이력 스탬프는 발송 시도 여부와 무관하게 항상 기록(재시도 폭주 방지 — email.py의
    False 반환도 "재시도 가능한 일시 실패"가 아니라 "provider 미설정"이라 재시도해도 무의미)."""
    from app.core.security import create_email_unsubscribe_token
    from app.services.agent_onboarding_config import resolve_locale
    from app.services.email import send_email
    from app.services.email_copy import REMINDER_COPY

    app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
    unsub_token = create_email_unsubscribe_token(str(user.id))
    unsub_link = f"{app_url}/unsubscribe?token={unsub_token}"
    # story #3205 — locale=ko 유저 → ko 메일·locale=en 유저 → en 메일(AC1).
    locale = resolve_locale(user.locale)
    delivered = send_email(
        to=user.email,
        # 유나 design:pass 권장(2026-08-27) — 해요체("완료예요") → 합니다체 정합.
        subject=REMINDER_COPY[locale]["subject"],
        html_body=_reminder_email_body(app_url=app_url, unsub_link=unsub_link, locale=locale),
    )
    user.onboarding_reminder_sent_at = datetime.now(timezone.utc)
    db.add(user)
    return delivered


async def run_reminder_sweep(db: AsyncSession) -> dict:
    """cron 진입점. 호출자가 verify_cron 등 인가를 이미 마쳤다고 가정."""
    candidates = await find_reminder_candidates(db)
    sent = 0
    for user in candidates:
        try:
            if await send_activation_reminder(db, user):
                sent += 1
        except Exception:
            logger.exception("onboarding reminder send failed user_id=%s", user.id)
    await db.commit()
    return {"candidates": len(candidates), "sent": sent}


async def unsubscribe_user(db: AsyncSession, user_id: uuid.UUID) -> bool:
    result = await db.execute(
        update(User).where(User.id == user_id).values(marketing_email_opt_out=True)
    )
    await db.commit()
    return result.rowcount > 0
