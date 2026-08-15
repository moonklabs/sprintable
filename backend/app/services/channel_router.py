"""S-A4: ChannelRouter — 메시지 수신자별 전달 채널 결정 서비스.

라우팅만 담당. 전달(dispatch)은 caller의 책임.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.notification_preference import NotificationPreference
from app.models.team import TeamMember
from app.models.user_block import UserBlock
from app.services.chain_depth import compute_agent_chain_depth

logger = logging.getLogger(__name__)

# story #2608 P1: 인간 앵커 없는 에이전트 연쇄가 유효한 최대 hop 수. 실측 근거(정상 A2A
# 협업 사슬 길이 분포)가 아직 없어 4로 시작한다(PM→BE→FE→QA류 짧은 핸드오프 사슬은
# 통과·A↔B 무한 핑퐁류는 몇 초 안에 걸림) — 값 자체는 PO 판단 대상(PR 참조).
_AGENT_CHAIN_DEPTH_CAP: int = 4


async def _conversation_has_human(db: AsyncSession, conversation_id: uuid.UUID) -> bool:
    """story #2617: 대화 참가자 중 human이 1명이라도 있는가 — 실물 참가자 조회(캐시/파생
    금지, PO 지시 2026-08-13). chain-expired 게이트가 사람-부재 대화를 무기한 침묵시키는지
    판정하는 유일한 근거라 정확성이 중요하다 — recipient_type_map처럼 필터된 부분집합에서
    유도하지 않고, 이 conversation_id의 ConversationParticipant 전체를 매번 새로 스캔한다."""
    row = (await db.execute(
        select(ConversationParticipant.member_id)
        .join(TeamMember, TeamMember.id == ConversationParticipant.member_id)
        .where(
            ConversationParticipant.conversation_id == conversation_id,
            TeamMember.type == "human",
        )
        .limit(1)
    )).scalar_one_or_none()
    return row is not None


class ChannelRouterError(Exception):
    """ChannelRouter 장애 시 typed exception — caller가 SSE fallback 가능."""


@dataclass
class DeliveryDecision:
    member_id: uuid.UUID
    channel: str
    level: str
    reason: str


async def route_message(
    message_id: uuid.UUID,
    db: AsyncSession,
) -> list[DeliveryDecision]:
    """메시지 수신자별 DeliveryDecision 목록 반환 — 「전달 계약」의 단일 판정 지점
    (delivery-contract-blueprint-v0-1, story #2603 P0).

    mute인 경우 해당 수신자 제외 (decision 미생성).
    mentions level인 경우 message content에 @{member_id} 없으면 제외.

    story #2603 이전엔 여기 "agent↔agent → sse 강제(AC5)" 바이패스가 있어 sender·recipient가
    둘 다 agent면 preference 조회 자체를 건너뛰고 무조건 level="all"을 반환했다 — Hermes↔
    OpenClaw 같은 외부 런타임 에이전트가 서로에게 응답하는 무한 루프가 정확히 이 바이패스
    때문에 구조적으로 안 끊겼다(원 커밋 39b96444a "S-A4" 확인 — AC 라벨 하나뿐, 서술적
    근거가 커밋 메시지에 없음. "agent-to-agent forced sse"가 A2A 협업이 notification
    preference 마찰로 막히는 걸 피하려던 의도였다고 추정은 되나 기록으로 확定되지 않음 —
    낡은 전제로 판단해 걷어낸다). 지금은 recipient가 agent든 human이든 **같은 판정 경로**를
    탄다 — sender_type은 더 이상 이 함수의 분기 조건이 아니다(단, DM 판정에는 conv_type을
    쓴다 — 아래).

    **에이전트 그룹챗 기본계약 = mentions**(1:1/DM = all, 비회귀·AC2): recipient_type이
    agent이고 대화가 group(dm 아님)이며 그 recipient의 명시 preference 행이 없으면
    default level="mentions"(과거는 이 경우도 "all"이었다 — PO 소급 확定: 원 고통이 기존
    그룹챗에 있어 소급 없이는 반쪽 해법). human이거나 DM이면 기존과 동일 default="all".

    ⛔핫픽스(2026-08-13, 선생님 직접 지시): 위 mentions 기본계약은 `settings.
    agent_group_default_mentions`(기본 False)로 게이트된다 — free_response 오버라이드가
    실 사용에서 안 먹는 게 규명 전에 팀 전체 A2A 통신을 막아, 규명·수리 전까지 소급 off로
    되돌렸다(#2603 원 의도는 유효·재상륙은 opt-in). 플래그 False면 이 분기는 완전히
    스킵되고 agent group도 기존처럼 default="all"이 된다.

    **free_response 대화 오버라이드**(AC2 옵트아웃): `conversation.free_response=true`면
    이 대화 한정으로 level="mentions"인 recipient는 "all"로 완화된다 — 단 명시 "mute"는
    안 뒤집는다(회원 자신의 «아예 알림 원치 않음» 선택이 방 설정보다 우선).

    story #2608 P1: agent가 보낸 메시지이고, 이 대화의 최근 연쇄 깊이(compute_agent_chain_
    depth, human 메시지 나올 때까지 역순 카운트)가 `_AGENT_CHAIN_DEPTH_CAP`을 넘으면, agent
    recipient는 **mentions/all/free_response 판정과 무관하게** 제외된다(reason="chain-
    expired") — A↔B가 서로를 계속 유효하게 멘션하는 최악 케이스(mentions 조건 자체는 항상
    통과)를 막는 유일한 축이라 다른 판정보다 뒤에, 최종 게이트로 건다. human recipient는
    이 게이트의 대상이 아니다(인간이 바로 그 "앵커"라 차단하면 안 됨 — 오히려 human-
    intervention 이벤트로 알려야 할 대상).

    ⛔story #2617(2026-08-13, DM전용 핫픽스 #3009를 일반화): 이 게이트는 **human 참가자가
    1명이라도 있는 대화에만** 적용된다(conv_type 무관 — DM/group 둘 다). human 메시지가
    애초에 없는 대화(순수 agent DM·순수 agent group)는 연쇄 깊이가 구조적으로 늘 cap을
    넘어, loop 방지 의도와 무관하게 정상적인 장기 협업 자체가 침묵당한다(reason=
    chain-expired 반복 확인 — DM 사례는 판별3·4, group 사례는 카디르 3-agent 5번째 무응답
    실측). human이 있으면(누구에게 개입을 청할 수 있으면) 원 #2608 AC(A↔B 핑퐁 방지)
    그대로 유지. human-less 대화의 관측(무한침묵 방지, AC4)은 이 함수 밖 —
    conversations.py의 별도 escalation 경로가 담당(순수 판정 함수에 side-effect를 안
    싣는다).
    """
    try:
        # 1. 메시지 + 발신자 조회
        msg = (await db.execute(
            select(ConversationMessage).where(ConversationMessage.id == message_id)
        )).scalar_one_or_none()
        if msg is None:
            raise ChannelRouterError(f"Message {message_id} not found")

        # 2. 발신자 type 확인
        # ⚠️ team_members 는 0088 이후 projection VIEW — org-agent 멀티프로젝트 grant(project_access)면
        # 같은 member.id 가 프로젝트 수만큼 행을 낸다. 무필터 scalar_one_or_none 은 MultipleResultsFound
        # 로 route_message 전체를 깨 chat→agent dispatch 가 멈춘다. type 은 전 행 동형이라 .limit(1) 로
        # 한 행만 취해 안전(_resolve_api_key 동일 패턴). 단일프로젝트 agent·휴먼은 1행이라 거동 무변경.
        sender_type: str | None = None
        if msg.sender_id:
            sender_type = (await db.execute(
                select(TeamMember.type).where(TeamMember.id == msg.sender_id).limit(1)
            )).scalar_one_or_none()

        # 3. conversation participants (발신자 제외)
        participant_rows = (await db.execute(
            select(ConversationParticipant.member_id).where(
                ConversationParticipant.conversation_id == msg.conversation_id,
            )
        )).scalars().all()
        recipient_ids = [pid for pid in participant_rows if pid != msg.sender_id]

        # story #2349 AC3 — 라이브 검증(2026-08-03, PO+디디, 스레드 7256d5cc)에서 실측으로 발견:
        # send_message의 user_blocker_ids exclusion은 _dispatch_conversation_event(Event row)·
        # mention_targets·candidate_targets 3곳만 잡았고, 이 함수(route_message)는 별개 쿼리로
        # recipient_ids를 처음부터 다시 뽑아 그 exclusion이 전혀 안 닿았다 — webhook-covered
        # 수신자(에이전트 대다수의 실제 수신 경로)에게는 차단이 «전혀 안 먹는» 상태로 머지됐었다.
        # route_message는 코드베이스 전체에서 정의 1곳·호출 2곳(pre-check용 별칭 _route L2033·
        # 실 webhook 발송용 L702)뿐이고, decisions 소비 분기도 channel=="discord"(webhook)·
        # 그 외(sse) 정확히 둘뿐이다(grep 전수 확認) — recipient_ids 원재료가 만들어지는 이
        # 지점 한 곳이 sse·discord·향후 추가될 모든 채널의 공통 상류라, 여기서 한 번만 걸러도
        # 채널 수와 무관하게 구조적으로 전부 막힌다.
        #
        # ⚠️recipient_ids는 이 함수 안에서만 쓰이는 local(decisions 계산 전용) — 이 목록을
        # 밖으로 반환하거나 ConversationParticipant를 건드리지 않는다(PO 확認 요청, 2026-08-03).
        # 즉 여기서 거르는 것은 «이 메시지의 알림/발송 대상»뿐이고 「대화 참가자」 관계 자체는
        # 그대로다 — 참가자 목록·읽기 권한(list_messages/_authorize_message_read)은 이 함수를
        # 전혀 거치지 않는 별도 경로라 안 끊긴다.
        #
        # #2814와 같은 결의 fail-open — 조회 실패해도 라우팅 자체는 안 막는다(대화 전송을
        # 부수 조회 하나 때문에 죽이지 않는다는 동일 트레이드오프. 로그 문구도 동일 패턴으로
        # 맞춰 "차단이 새는 빈도"를 하나의 문구로 셀 수 있게 한다).
        if msg.sender_id and recipient_ids:
            try:
                blocker_ids = set((await db.execute(
                    select(UserBlock.blocker_member_id).where(UserBlock.blocked_member_id == msg.sender_id)
                )).scalars().all())
                if blocker_ids:
                    recipient_ids = [pid for pid in recipient_ids if pid not in blocker_ids]
            except Exception:
                logger.warning(
                    "user_blocker_ids lookup failed message_id=%s — fail-open(no exclusion)", msg.id,
                    exc_info=True,
                )

        if not recipient_ids:
            return []

        # story #2608 P1: sender가 agent일 때만 연쇄 깊이를 잰다(human 발신은 애초에 이
        # 게이트 대상 밖 — 정의상 그 메시지 자체가 앵커라 depth=0으로 리셋되는 것과 동치).
        chain_expired = False
        conv_has_human = True  # chain_expired=False면 안 쓰임(아래 게이트가 and로 단락) — 기본은 안전측.
        if sender_type == "agent":
            depth = await compute_agent_chain_depth(
                db, msg.conversation_id, max_scan=_AGENT_CHAIN_DEPTH_CAP,
            )
            chain_expired = depth > _AGENT_CHAIN_DEPTH_CAP
            if chain_expired:
                # story #2617: human 유무는 실물 참가자 조회로만 판정(캐시/파생 금지, PO 지시) —
                # 게이트가 실제로 걸릴 때만 계산(흔한 경로에 쿼리 추가 안 함).
                conv_has_human = await _conversation_has_human(db, msg.conversation_id)

        # 4. 수신자 type 배치 조회
        member_rows = (await db.execute(
            select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(recipient_ids))
        )).all()
        member_type_map: dict[uuid.UUID, str] = {r[0]: r[1] for r in member_rows}

        # 5. preference 배치 조회 — thread/conversation/project/global 4 scope
        # conversation의 project_id·type·free_response 조회(각각 project scope fallback·
        # DM 비회귀·free_response 오버라이드 판정용 — story #2603 P0로 type/free_response 추가).
        conv_row = (await db.execute(
            select(Conversation.project_id, Conversation.type, Conversation.free_response)
            .where(Conversation.id == msg.conversation_id)
        )).one_or_none()
        conv_project_id: uuid.UUID | None = conv_row.project_id if conv_row else None
        conv_type: str = conv_row.type if conv_row else "group"
        conv_free_response: bool = bool(conv_row.free_response) if conv_row else False

        # story #2637 §0-c: msg_metadata['event']['event_key']가 있으면(이벤트 발행 메시지,
        # #2637 AC 0-a가 태깅) "이 이벤트타입 전체 mute" 축을 conversation/project와 global
        # 사이에 끼워 넣는다 — 사용자가 특정 대화를 명시로 커스텀했으면 그게 여전히 이기고
        # (thread/conversation이 더 앞), 대화-구조 축이 전혀 없으면 event_key 축이 순수
        # global보다 먼저 이긴다. __dict__ 전용 read는 _approval_payload와 동일 이유
        # (getattr(msg, 'msg_metadata')의 미로드 컬럼 async lazy-load가 sync 컨텍스트에서
        # greenlet_spawn 크래시를 낼 수 있어 회피).
        event_key: str | None = None
        _meta = (getattr(msg, "__dict__", None) or {}).get("msg_metadata")
        if isinstance(_meta, dict):
            _ev = _meta.get("event")
            if isinstance(_ev, dict):
                _ek = _ev.get("event_key")
                event_key = _ek if isinstance(_ek, str) and _ek else None

        scope_type_order: list[tuple[str, uuid.UUID | str | None]] = []
        if msg.thread_id:
            scope_type_order.append(("thread", msg.thread_id))
        scope_type_order.append(("conversation", msg.conversation_id))
        if conv_project_id:
            scope_type_order.append(("project", conv_project_id))
        if event_key:
            scope_type_order.append(("event_key", event_key))
        scope_type_order.append(("global", None))

        pref_rows = (await db.execute(
            select(NotificationPreference).where(
                NotificationPreference.member_id.in_(recipient_ids),
            )
        )).scalars().all()

        # member_id → {(scope_type, scope_id_or_event_key): NotificationPreference}. event_key-
        # scope 행은 scope_id가 항상 NULL이라 그 자리에 event_key(str)를 대신 키로 쓴다 —
        # scope_type_order도 동일 규약(("event_key", <str>))이라 조회가 그대로 맞아떨어진다.
        pref_map: dict[uuid.UUID, dict[tuple[str, uuid.UUID | str | None], NotificationPreference]] = {}
        for p in pref_rows:
            key_id = p.event_key if p.scope_type == "event_key" else p.scope_id
            pref_map.setdefault(p.member_id, {})[(p.scope_type, key_id)] = p

        # 6. 수신자별 라우팅 결정 — sender_type 분기 없음(위 docstring, story #2603 P0).
        decisions: list[DeliveryDecision] = []
        for rid in recipient_ids:
            recipient_type = member_type_map.get(rid, "human")

            # preference fallback: thread → conversation → global
            pref: NotificationPreference | None = None
            matched_scope = "global"
            for stype, sid in scope_type_order:
                candidate = pref_map.get(rid, {}).get((stype, sid))
                if candidate is not None:
                    pref = candidate
                    matched_scope = stype
                    break

            channel = pref.channel if pref else "sse"
            if pref is not None:
                level = pref.level
                reason = f"preference scope={matched_scope}"
            elif recipient_type == "agent" and conv_type != "dm" and settings.agent_group_default_mentions:
                # story #2603 P0: 에이전트 그룹챗 기본계약(소급 적용, PO 확定) — 위 docstring.
                # 핫픽스(2026-08-13): free_response 오버라이드 규명 전까지 기본 off로 되돌림
                # (settings.agent_group_default_mentions) — 팀 전체 통신 차단이 근본원인 규명보다
                # 급했다(선생님 직접 지시). 규명·수리 후 opt-in 재활성 대상.
                level = "mentions"
                reason = "agent group default: mentions"
            else:
                level = "all"
                reason = "default: all"

            # AC2: free_response 대화는 mentions만 all로 완화 — 명시 mute는 안 뒤집는다.
            if conv_free_response and level == "mentions":
                level = "all"
                reason = f"{reason} + free_response override"

            # mute → skip (AC3)
            if level == "mute":
                logger.info(
                    "delivery_contract: excluded recipient=%s conversation_id=%s reason=%s",
                    rid, msg.conversation_id, "mute",
                )
                continue

            # CB-S1 AC3: mentioned_ids 배열 기반 mentions 판단(content regex 폐기) — FE 피커·
            # MCP 구조화 mentioned_ids(story #2618/#3043)가 conversations.py send_message에서
            # 이미 채워 저장하므로(story #2646로 은퇴한 @handle 텍스트 파싱 union은 제외됨),
            # 이 체크는 그대로 재사용된다.
            if level == "mentions":
                if not (msg.mentioned_ids and rid in msg.mentioned_ids):
                    logger.info(
                        "delivery_contract: excluded recipient=%s conversation_id=%s reason=%s",
                        rid, msg.conversation_id, "mentions level, not mentioned",
                    )
                    continue

            # story #2608 P1: 최종 게이트 — 그 외 모든 판정을 통과했어도(멘션 성립·all·
            # free_response 완화 전부 포함) agent recipient는 연쇄가 cap을 넘으면 여기서
            # 막힌다. human recipient는 대상 밖(위 docstring).
            #
            # ⛔story #2617(2026-08-13, 라이브 실측·Cloud Logging 대조 확定 + 카디르 QA 재현):
            # DM만 뺐던 핫픽스(#3009)를 **human 참가자 유무**로 일반화한다 — 순수 1:1 agent DM
            # (판별3·4 재현 사례)뿐 아니라 human 없는 group 대화도 동형으로 침묵당했다(카디르
            # 3-agent group 5번째 메시지부터 무응답 실측). 앵커 개념 자체가 human 부재 대화엔
            # 성립 안 하므로(누구에게도 개입을 청할 수 없다) 게이트를 건너뛴다. human이 1명이라도
            # 있으면(DM이든 group이든) 원 #2608 AC(A↔B 핑퐁 방지) 그대로 유지 — 비회귀.
            # ⚠️이 예외는 «전달을 막지 않을 뿐»이지 무한루프 자체를 차단하지 않는다 — 진짜 폭주
            # (A↔B 동형 반복)는 토큰을 계속 태울 수 있다(#2617 스토리 «잔여 위험», 후속 축).
            # human-less 대화의 chain-expired 관측(AC4)은 conversations.py의 별도 escalation
            # 경로(chain_escalation.py)가 담당 — route_message는 순수 판정만, side-effect 없음.
            if chain_expired and recipient_type == "agent" and conv_has_human:
                logger.info(
                    "delivery_contract: excluded recipient=%s conversation_id=%s reason=%s",
                    rid, msg.conversation_id, "chain-expired",
                )
                continue

            decisions.append(DeliveryDecision(
                member_id=rid,
                channel=channel,
                level=level,
                reason=reason,
            ))

        return decisions

    except ChannelRouterError:
        raise
    except Exception as exc:
        raise ChannelRouterError(f"ChannelRouter failed for message {message_id}: {exc}") from exc
