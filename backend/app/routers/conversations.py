"""E-EVENTBUS P7-A S37: conversations 테이블 + Chat API."""
from __future__ import annotations

import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import and_, func, select, text, tuple_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.config import settings
from app.core.pagination import assemble_page, decode_cursor
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db, get_read_db
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.event import Event
from app.models.gate import Gate
from app.models.project import OrgMember, Project
from app.models.team import AgentMessageAllowlist, TeamMember
from app.models.agent_deployment import AgentAuditLog
from app.models.webhook_config import WebhookConfig
from app.models.user_block import UserBlock
from app.routers.events import _push_to_agent
from app.schemas.attachment import validate_attachment_url
from app.services import chat_presence
from app.services.agent_runtime import supports_deterministic_command
from app.services import mcp_attachment_upload
from app.services.asset_registry import DEFAULT_CONTAINER, sync_attachment_assets
from app.services.command_classifier import classify_command
from app.services.event_seq import assign_recipient_seq
from app.services.member_resolver import (
    ResolvedMember,
    filter_org_member_ids,
    lookup_members_by_ids,
    resolve_member,
    resolve_member_identity,
)
from app.services.project_auth import is_org_owner_or_admin, project_access_valid_correlated
from app.services.storage import get_storage_provider

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/conversations", tags=["conversations", "Organization"])


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _enforce_agent_creator_policy(
    sender: "ResolvedMember | TeamMember",
    participant_ids: list[uuid.UUID],
    db: AsyncSession,
) -> None:
    """⭐ 불변식: 휴먼↔에이전트 대화 — 각 에이전트의 creator가 참가자(sender ∪ participant_ids)에 있어야.

    전제: 에이전트 없거나 휴먼 없으면(에이전트↔에이전트) skip.

    story #2613(PR #2824 승계 — 원 스토리 소실, fix 자체는 유효) — 403 detail을 구조화
    ({code, message, details})해 FE가 generic 실패 대신 원인(allowlist_miss·created_by_none·
    creator_not_participant)을 actionable하게 보여줄 수 있게 한다. 보안 정책 자체는 불변
    (우회·완화 없음) — 거부 사유를 «누구에게» 보이는지만 바뀐다.
    """
    if not participant_ids:
        return

    all_ids = set(participant_ids) | {sender.id}

    # 에이전트 participant 조회
    agent_tms = (await db.execute(
        select(TeamMember).where(
            TeamMember.id.in_(all_ids),
            TeamMember.type == "agent",
        )
    )).scalars().all()
    if not agent_tms:
        return  # 에이전트 없음 → skip

    agent_ids = {a.id for a in agent_tms}
    non_agent_ids = all_ids - agent_ids
    if not non_agent_ids:
        return  # ⭐ 에이전트↔에이전트 → 게이팅 skip (팀 comms 불변·핵심 안전조건, E-MSG-POLICY S1 불변)

    # 휴먼 참가자 (member_id, user_id) 수집 — mode별 인가에 둘 다 필요
    humans: list[tuple[uuid.UUID, uuid.UUID | None]] = []
    sender_user_id = getattr(sender, "user_id", None)
    if sender.id in non_agent_ids:
        humans.append((sender.id, sender_user_id))

    remaining_ids = non_agent_ids - {sender.id}
    if remaining_ids:
        # TeamMember 조회
        tm_humans = (await db.execute(
            select(TeamMember).where(TeamMember.id.in_(remaining_ids))
        )).scalars().all()
        humans.extend((tm.id, tm.user_id) for tm in tm_humans)

        # OrgMember 조회 (grant-only 휴먼)
        tm_found_ids = {tm.id for tm in tm_humans}
        om_ids = remaining_ids - tm_found_ids
        if om_ids:
            oms = (await db.execute(
                select(OrgMember).where(OrgMember.id.in_(om_ids))
            )).scalars().all()
            humans.extend((om.id, om.user_id) for om in oms)

    human_user_ids: set[uuid.UUID] = {u for _, u in humans if u}

    # E-MSG-POLICY S1: 각 에이전트의 message_policy_mode 별 인가
    for agent_tm in agent_tms:
        mode = getattr(agent_tm, "message_policy_mode", None) or "creator_only"

        if mode == "org_wide":
            continue  # org 내 휴먼 전부 허용 (참가자는 이미 org-scoped) → 통과

        if mode == "list":
            allowed_ids = set((await db.execute(
                select(AgentMessageAllowlist.allowed_id).where(
                    AgentMessageAllowlist.agent_member_id == agent_tm.id
                )
            )).scalars().all())
            for member_id, user_id in humans:
                # creator는 모드 무관 항상 허용 (자기 에이전트 접근)
                is_creator = user_id is not None and user_id == agent_tm.created_by
                if member_id not in allowed_ids and not is_creator:
                    logger.warning(
                        "agent creator policy 403: agent_id=%s sender_id=%s reason=allowlist_miss member_id=%s",
                        agent_tm.id, sender.id, member_id,
                    )
                    raise HTTPException(
                        status_code=403,
                        detail={
                            "code": "AGENT_MESSAGE_POLICY_DENIED",
                            "message": "Member is not in this agent's message allowlist",
                            "details": {
                                "agent_id": str(agent_tm.id),
                                "member_id": str(member_id),
                                "reason": "allowlist_miss",
                            },
                        },
                    )
            continue

        # creator_only (default·기존 동작): 에이전트 creator가 참가자여야
        if agent_tm.created_by is None:
            logger.warning(
                "agent creator policy 403: agent_id=%s sender_id=%s reason=created_by_none",
                agent_tm.id, sender.id,
            )
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "AGENT_MESSAGE_POLICY_DENIED",
                    "message": "Agent has no creator — conversation not allowed",
                    "details": {
                        "agent_id": str(agent_tm.id),
                        "reason": "created_by_none",
                    },
                },
            )
        if agent_tm.created_by not in human_user_ids:
            logger.warning(
                "agent creator policy 403: agent_id=%s sender_id=%s reason=creator_not_participant created_by=%s",
                agent_tm.id, sender.id, agent_tm.created_by,
            )
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "AGENT_MESSAGE_POLICY_DENIED",
                    "message": "Agent's creator must be a participant in this conversation",
                    "details": {
                        "agent_id": str(agent_tm.id),
                        "reason": "creator_not_participant",
                    },
                },
            )


async def _resolve_member(
    auth: AuthContext,
    org_id: uuid.UUID,
    db: AsyncSession,
    project_id: uuid.UUID | None = None,
) -> "ResolvedMember | TeamMember":
    """TeamMember 우선; grant-only 휴먼이면 ResolvedMember(org_member.id) 반환."""
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        tm = (await db.execute(select(TeamMember).where(TeamMember.id == uuid.UUID(auth.user_id)))).scalars().first()
        if tm is None:
            raise HTTPException(status_code=400, detail="Team member not found")
        return tm

    # JWT 휴먼: team_member 먼저 시도
    filters = [TeamMember.user_id == uuid.UUID(auth.user_id), TeamMember.org_id == org_id]
    if project_id is not None:
        filters.append(TeamMember.project_id == project_id)
    tm = (await db.execute(select(TeamMember).where(*filters))).scalars().first()
    if tm is not None:
        return tm

    # team_member 없음 (grant-only 휴먼) → org_member 경로
    return await resolve_member(auth, org_id, db, project_id=project_id)


async def _effective_org_role(
    auth: AuthContext, org_id: uuid.UUID, db: AsyncSession, sender: "ResolvedMember | TeamMember",
    project_id: uuid.UUID | None = None,
) -> str:
    """sender.role에 org owner/admin 상속(S-MBR-03). team_members 뷰는 **project role만** 주므로
    org owner/admin이 project-member로 나오는 갭(#1223 agent-view 게이트 ↔ 멤버-SSOT 뷰)을 보정 —
    /me effective-role과 일관(버그: org owner/admin이 agent-view 403).

    E-SECURITY SEC-S8(story 83ea3d6a) V(까심 전수스윕, 실HTTP 확定): 에이전트는 org-wide role
    개념이 없음(project_access.role만 존재)인데 `_resolve_member`의 agent 분기가 project_id
    무관하게 `.first()`로 임의 1행을 뽑아(P와 동형 비결정 row-pick) sender.role을 그대로
    신뢰했다 — mixed-role 에이전트(예: X=admin·Y=grant 0)가 project_x의 admin 지위를 빌려와
    project_y의 agent-only 대화를 admin-bypass로 열람할 수 있었다(참가자 아님에도 200). fix=
    project_id가 주어지면 **그 project 전용** effective role을 get_project_role(P가 쓴 SSOT)로
    재평가 — 휴먼은 원래대로 org-wide OrgMember.role(진짜 org 전체 권한이라 무관)."""
    if bool(auth.claims.get("app_metadata", {}).get("api_key_id")):
        if project_id is None:
            return sender.role  # 레거시 폴백(project_id 미전달 호출부 — 현재 전 호출부가 전달함)
        from app.services.project_auth import get_project_role
        role = await get_project_role(db, sender.id, project_id)
        return role or "member"
    if sender.role in ("owner", "admin"):
        return sender.role
    om_role = (await db.execute(
        select(OrgMember.role).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == uuid.UUID(auth.user_id),
            OrgMember.deleted_at.is_(None),
        ).limit(1)
    )).scalar_one_or_none()
    return om_role if om_role in ("owner", "admin") else sender.role


async def _conversation_has_human_participant(conversation_id: uuid.UUID, db: AsyncSession) -> bool:
    """대화에 휴먼 참가자가 있으면 True(=private·admin 우회 금지).
    보수적: agent team_member로 확정 안 된 참가자는 human 간주(grant-only/미앵커 휴먼 포함).

    story #2697: get_conversation()은 더 이상 이 함수를 안 쓴다(conversation_readable_
    predicate SSOT로 이관) — 하지만 attachments.py의 authorize 엔드포인트가 여전히 이
    정확한 함수를 직접 import해 자신의 admin-bypass 판정에 쓴다(별도 콜사이트, 삭제 시
    ImportError). 그래서 이 함수는 존치 — 삭제가 아니라 "소비자 하나만 이관"이 맞는
    변경이었다(#2697 첫 시도에서 삭제했다가 test_attachment_authorize_a54ddc16.py로 잡힘)."""
    pids = (await db.execute(
        select(ConversationParticipant.member_id).where(ConversationParticipant.conversation_id == conversation_id)
    )).scalars().all()
    if not pids:
        return False
    agent_ids = set((await db.execute(
        select(TeamMember.id).where(TeamMember.id.in_(pids), TeamMember.type == "agent")
    )).scalars().all())
    return any(p not in agent_ids for p in pids)  # agent 확정 외 = human 보수적


async def _conversations_with_human_participant(conv_ids: list[uuid.UUID], db: AsyncSession) -> set[uuid.UUID]:
    """conv_ids 중 휴먼 참가자가 있는 conversation_id 집합(보수적·agent 확정 외 human)."""
    if not conv_ids:
        return set()
    rows = (await db.execute(
        select(ConversationParticipant.conversation_id, ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id.in_(conv_ids))
    )).all()
    # member_id 중 agent 확정 집합
    all_mids = {m for _, m in rows}
    agent_ids = set((await db.execute(
        select(TeamMember.id).where(TeamMember.id.in_(all_mids), TeamMember.type == "agent")
    )).scalars().all()) if all_mids else set()
    result: set[uuid.UUID] = set()
    for cid, mid in rows:
        if mid not in agent_ids:  # human 참가자 발견
            result.add(cid)
    return result


# ─── story #1976 (E-CHAT-REALTIME 트랙A): read state 서버 truth ──────────────────
# doc: chat-realtime-track-a-read-state-design §3/§4. 순수 SQLAlchemy 쿼리/stmt 조립
# 함수(DB 실행 없음) — 단위 테스트 가능(TDD RED→GREEN, DB 미기동 시에도 compile() 검증 가능).

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)  # last_read_at NULL(한 번도 안 읽음) 기준선


def _mark_read_update_stmt(conversation_id: uuid.UUID, member_id: uuid.UUID, up_to: datetime):
    """GREATEST 래칫 UPDATE — last_read_at을 단조증가만 허용(멱등·역행 방지, §4-3).

    GREATEST(COALESCE(last_read_at, epoch), up_to): 이미 더 최신 read 상태면 과거 up_to로
    덮어쓰지 않는다. WHERE가 (conversation_id, member_id) 매치 0행이면 비참여자 — 호출부가
    RETURNING 결과 None으로 403 판단.
    """
    return (
        update(ConversationParticipant)
        .where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == member_id,
        )
        .values(
            last_read_at=func.greatest(
                func.coalesce(ConversationParticipant.last_read_at, text("'epoch'::timestamptz")),
                up_to,
            )
        )
        .returning(ConversationParticipant.last_read_at)
    )


def _unread_count_stmt(conversation_id: uuid.UUID, member_id: uuid.UUID, since: datetime | None):
    """단건 unread_count — last_read_at(since) 이후 & sender IS DISTINCT FROM 나(§4-1).

    IS DISTINCT FROM(NOT !=) 필수: sender_id nullable(발신자 탈퇴 시 SET NULL) 이라 `!=`는
    SQL 3-값 논리상 NULL != x → NULL(제외) 이 돼 발신자소실 메시지가 unread에서 누락된다.
    since=None(한 번도 안 읽음)이면 _EPOCH 기준선 사용.
    """
    baseline = since if since is not None else _EPOCH
    return select(func.count(ConversationMessage.id)).where(
        ConversationMessage.conversation_id == conversation_id,
        ConversationMessage.created_at > baseline,
        ConversationMessage.sender_id.is_distinct_from(member_id),
    )


def _list_unread_counts_stmt(member_id: uuid.UUID, conv_id_list: list[uuid.UUID] | None = None):
    """list_conversations 배치 unread_count — 단일 JOIN+GROUP BY(N+1 방지, §4-2).

    대화마다 기준 시각(last_read_at)이 다른 상관 카운트라 순수 IN 배치로는 불가 — JOIN
    조건에 기준 시각 비교를 박아 넣어 페이지 대화 수(N)와 무관하게 쿼리 1회로 해결.
    INNER JOIN이라 unread=0인 대화는 결과행 자체가 없음(호출부가 dict.get(id, 0)으로 처리).

    conv_id_list=None이면 caller가 참여 중인 **모든** 대화를 대상(전량, 페이지네이션 무관) —
    story #1992(GNB unread 총합)가 `_total_unread_count_stmt`로 이 "전량 모드"를 서브쿼리로
    감싸 SUM 재사용(동일 JOIN+`IS DISTINCT FROM` 조건 SSOT, 중복 없음).
    """
    stmt = (
        select(
            ConversationParticipant.conversation_id,
            func.count(ConversationMessage.id).label("unread_count"),
        )
        .join(
            ConversationMessage,
            and_(
                ConversationMessage.conversation_id == ConversationParticipant.conversation_id,
                ConversationMessage.created_at > func.coalesce(
                    ConversationParticipant.last_read_at, text("'epoch'::timestamptz")
                ),
                ConversationMessage.sender_id.is_distinct_from(member_id),
            ),
        )
        .where(ConversationParticipant.member_id == member_id)
        .group_by(ConversationParticipant.conversation_id)
    )
    if conv_id_list is not None:
        stmt = stmt.where(ConversationParticipant.conversation_id.in_(conv_id_list))
    return stmt


def _total_unread_count_stmt(member_id: uuid.UUID):
    """story #1992: GNB 채팅 unread 총합(count-only) — caller의 전 참여 대화(페이지네이션 무관)
    unread_count SUM.

    `_list_unread_counts_stmt(member_id)`(conv_id_list=None → 전량 모드)를 서브쿼리로 감싸
    SUM 래퍼만 추가한다 — JOIN+`IS DISTINCT FROM` 계산 로직 재구현 없음(단일 SSOT, list_conversations
    의 per-conversation unread_count와 동일 정의). INNER JOIN 특성상 대화별 최소 1건이라도 unread가
    있어야 그룹행이 생기므로, 참여 대화가 전무하거나 전부 unread 0이면 서브쿼리 결과가 0행 —
    COALESCE(SUM(...), 0)으로 NULL을 0으로 정규화한다.
    """
    per_conv = _list_unread_counts_stmt(member_id).subquery()
    return select(func.coalesce(func.sum(per_conv.c.unread_count), 0))


async def _fetch_conversation_participants(
    conv_ids: list[uuid.UUID],
    db: AsyncSession,
) -> dict[uuid.UUID, list[dict]]:
    """story #2009: conversation(들)의 participants 배치 조회 — list_conversations의 기존
    N+1 방지 배치 로직을 단건(`get_conversation`)에서도 재사용하도록 추출(로직 복제 금지, AC).

    반환 dict shape는 두 엔드포인트가 항상 동일 JSON을 내려주도록 고정:
    `{"member_id", "name", "avatar_url", "type", "runtime_type"}` (list_conversations의
    participants 항목과 byte-identical — FE 파싱 일관성).
    """
    if not conv_ids:
        return {}

    p_rows = (await db.execute(
        select(ConversationParticipant.conversation_id, ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id.in_(conv_ids))
    )).all()

    all_member_ids = {r.member_id for r in p_rows}
    resolved_map = await lookup_members_by_ids(all_member_ids, db) if all_member_ids else {}

    # E-CHAT-CMD S8b: participant 의 runtime_type 노출(team_members 뷰서 read — 에이전트만 값, 휴먼 NULL).
    runtime_type_map: dict[uuid.UUID, str | None] = {}
    if all_member_ids:
        rt_rows = (await db.execute(
            select(TeamMember.id, TeamMember.runtime_type).where(TeamMember.id.in_(all_member_ids))
        )).all()
        runtime_type_map = {r.id: r.runtime_type for r in rt_rows}

    conv_participants: dict[uuid.UUID, list[dict]] = defaultdict(list)
    for r in p_rows:
        resolved = resolved_map.get(r.member_id)
        conv_participants[r.conversation_id].append({
            "member_id": str(r.member_id),
            "name": resolved.name if resolved else str(r.member_id)[:8],
            "avatar_url": getattr(resolved, "avatar_url", None) if resolved else None,
            "type": resolved.type if resolved else "human",
            "runtime_type": runtime_type_map.get(r.member_id),
        })
    return conv_participants


# story #2925(2921-S2 선행, 유나 확定 스펙) — L1 대화 행을 ProofCapsule card로 승격시킬지
# 판별하는 신호. 「참조(게이트/작업) 있는 대화만 승격·색은 참조 대상의 실제 상태가 몬다·
# 참조 없으면 plain(fail-safe·거짓 색 금지)」(2921-S2 서면 확定). 오늘 코드베이스에서 대화가
# 게이트를 "임베드"하는 유일한 실 메커니즘은 `dispatch_approval_request_cards`(approval_
# delivery.py)가 심는 `msg_metadata['approval_target']['gate_id']`뿐이다 — entity_references
# (source_type='chat_message', target_type='gate')는 이 delivery 경로가 안 거쳐(mentions
# 추출은 insert_chat_mentions·conversations.py의 일반 send_message 경로에서만 발화) 실제로
# 채워지지 않는다. 「작업(task) 상태」 폴백은 이 그라운딩에서 대화-임베드 메커니즘을 찾지
# 못해(지어내지 않는다) 이번 판에는 뺐다 — gate 참조가 없으면 null(스토리 fail-safe 원칙
# 그대로), task 전용 대화-임베드 축은 별도 결정 필요(PO/유나 확認 대상으로 완료 보고에 명시).
#
# 상태 매핑(PO 전달 유나 확定): rejected→violation(red) · approved/auto_passed→verified
# (green) · pending+requires_human→pending_human(blue) · pending(아직 human 단계 아님)·
# held→waiting(amber). voided는 4상태 어디에도 안 맞는(관리자 회수·실 판정 아님) 상태라
# 후보에서 제외한다(거짓 색 금지 원칙 — 차라리 null이 낫다).
def _derive_gate_proof_state(gate: "Gate") -> str | None:
    if gate.status == "rejected":
        return "violation"
    if gate.status in ("approved", "auto_passed"):
        return "verified"
    if gate.status == "pending":
        return "pending_human" if gate.requires_human else "waiting"
    if gate.status == "held":
        return "waiting"
    return None  # voided(또는 알려지지 않은 값) — 지어내지 않는다.


_OPEN_GATE_STATUSES = ("pending", "held")


async def _batch_resolve_linked_proof(
    conv_ids: list[uuid.UUID],
    org_id: uuid.UUID,
    db: AsyncSession,
) -> dict[uuid.UUID, dict | None]:
    """대화(들)의 「행 승격 신호」 배치 조회 — N+1 방지(리스트 크기 무관 쿼리 2개 고정,
    `_fetch_conversation_participants`/unread_map과 동일 배치 패턴). 대화당 여러 approval
    카드가 있으면(재상신 등) 열린(pending/held) 게이트를 우선하고, 없으면 가장 최근에
    해소된 게이트를 반환한다(승인 완료도 "증명"으로서 보여줄 가치가 있다는 2916-B 원칙).
    voided뿐이거나 참조가 아예 없으면 None(스토리의 fail-safe 원칙)."""
    if not conv_ids:
        return {}

    approval_rows = (await db.execute(
        select(
            ConversationMessage.conversation_id,
            ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext.label("gate_id"),
            ConversationMessage.created_at,
        ).where(
            ConversationMessage.conversation_id.in_(conv_ids),
            ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext.isnot(None),
        )
    )).all()
    if not approval_rows:
        return {}

    conv_candidates: dict[uuid.UUID, list[tuple[uuid.UUID, object]]] = defaultdict(list)
    all_gate_ids: set[uuid.UUID] = set()
    for row in approval_rows:
        try:
            gate_id = uuid.UUID(row.gate_id)
        except (ValueError, TypeError, AttributeError):
            continue  # 손상된/구형 payload — 지어내지 않고 건너뜀.
        conv_candidates[row.conversation_id].append((gate_id, row.created_at))
        all_gate_ids.add(gate_id)

    gates = (await db.execute(
        select(Gate).where(Gate.id.in_(all_gate_ids), Gate.org_id == org_id)
    )).scalars().all()
    gate_map: dict[uuid.UUID, Gate] = {g.id: g for g in gates}

    result: dict[uuid.UUID, dict | None] = {}
    for conv_id, candidates in conv_candidates.items():
        # 최신 배달 우선(같은 게이트가 재상신돼도 최신 참조가 "그 대화가 지금 가리키는 것").
        candidates.sort(key=lambda c: c[1], reverse=True)
        open_pick: Gate | None = None
        fallback_pick: Gate | None = None
        for gate_id, _created_at in candidates:
            gate = gate_map.get(gate_id)
            if gate is None or gate.status == "voided":
                continue
            if gate.status in _OPEN_GATE_STATUSES and open_pick is None:
                open_pick = gate
            elif fallback_pick is None:
                fallback_pick = gate
        chosen = open_pick or fallback_pick
        if chosen is None:
            continue
        state = _derive_gate_proof_state(chosen)
        if state is None:
            continue
        result[conv_id] = {"kind": "gate", "state": state, "gate_id": str(chosen.id)}
    return result


_SUMMARY_PREVIEW_MAX = 80


def _build_message_summary(content: str | None, sender_name: str | None, has_attachment: bool) -> str:
    """알림 카피용 사람-친화 summary (e2608901). 형식: "{발신자}: {내용 미리보기 80자}".

    notification-bell이 `payload.summary ?? event_type`로 렌더하므로, summary 미생성 시 raw
    이벤트명(`conversation.message_created`)이 노출됐다. 발신자+미리보기로 "무슨 일인지" 1초 노출.
    """
    name = sender_name or "Someone"
    preview = " ".join((content or "").split())  # 개행/연속공백 정규화
    if len(preview) > _SUMMARY_PREVIEW_MAX:
        preview = preview[:_SUMMARY_PREVIEW_MAX].rstrip() + "…"
    if not preview:
        preview = "📎" if has_attachment else ""
    return f"{name}: {preview}" if preview else name


def _msg_payload(
    msg: ConversationMessage, sender: "ResolvedMember | TeamMember | None",
    *, references: list[dict[str, str]] | None = None,
    blocked_sender_ids: set[uuid.UUID] | None = None,
) -> dict:
    # story #2319 미완(미르코 dev 라이브 실측 2026-08-02) — tombstone인데 attachments가 응답에
    # 그대로 남아 첨부(영상 등)가 계속 재생됐다. AC③(오발송 스크럽) 근거가 이걸로 무너진다 —
    # 여기서 빈 배열로 덮는다(실제 근본은 attachments.py authorize의 belongs 쿼리에 deleted_at
    # 필터를 추가한 것 — 이 payload 필터는 FE가 애초에 못 보게 하는 2차 방어).
    attachments = (msg.attachments if isinstance(msg.attachments, list) else []) if msg.deleted_at is None else []
    payload = {
        "id": str(msg.id),
        "conversation_id": str(msg.conversation_id),
        "thread_id": str(msg.thread_id) if msg.thread_id else None,
        "reply_count": msg.reply_count,
        "last_reply_at": msg.last_reply_at.isoformat() if msg.last_reply_at else None,
        # story #2319 — tombstone. content는 삭제 시 이미 ""로 덮여 있다(스크럽); FE는 이
        # 필드로 placeholder("삭제된 메시지입니다")를 렌더한다(i18n — 여기 문구를 안 심는다).
        "deleted_at": msg.deleted_at.isoformat() if msg.deleted_at else None,
        "content": msg.content,
        "mentioned_ids": [str(m) for m in (msg.mentioned_ids or [])],
        # E-FILE S1: 첨부 직렬화 (SSE + GET messages 공통). list 아니면 [](레거시/None/mock 안전).
        "attachments": attachments,
        "sender": {
            "id": str(sender.id),
            "name": sender.name,
            "type": sender.type,
            "avatar_url": sender.avatar_url,
        } if sender else None,
        # e2608901: 알림 카피 — raw event_type 대신 사람-친화 summary를 payload에 동봉.
        "summary": _build_message_summary(msg.content, sender.name if sender else None, bool(attachments)),
        "created_at": msg.created_at.isoformat(),
    }
    # story #2263 AC6(오르테가 판정 2026-07-29, 스레드 7256d5cc): 읽기 경로(list_messages·
    # get_message·list_message_replies)만 이 키를 싣는다 — 그 셋만 호출부에서 `references=`
    # 를 넘긴다(항상 list, 빈 배열도 명시). 다른 호출부(SSE 디스패치·POST 전송 응답)는 넘기지
    # 않아 키 자체가 없다(기존 동작 무변경) — 그 표면들은 이미 별개의 write-time 사이드밴드
    # (`response["references"] = {stored, dropped}`, #2294/#2315)를 갖고 있어 의미가 다르다.
    # ⛔`references is None`(파라미터 미전달)과 `references=[]`(읽기 경로·저장된 참조 0건)를
    # 여기서 구분한다 — 빈 배열도 없는 배열처럼 다뤄 키를 빼면, FE가 "옛 서버라 필드가 없다"와
    # "이 메시지엔 참조가 없다"를 못 가른다(오늘 아침 유령 칩 사고의 뿌리와 같은 모양).
    if references is not None:
        payload["references"] = references
    # story #2349 AC3 — 마스킹은 tombstone(#2319)과 다르다: 서버가 안 내주는 게 아니라
    # «내려주되 클라가 가린다»(펼쳐볼 수 있어야 하는 UX). references와 동형으로 읽기 경로
    # (list_messages·get_message·list_message_replies)만 이 키를 싣는다 — viewer가 누구인지
    # 모르는 SSE/write-response 경로는 넘기지 않아 키 자체가 없다(기존 references 규율 재사용).
    if blocked_sender_ids is not None:
        payload["is_blocked_sender"] = bool(sender and sender.id in blocked_sender_ids)
    # E-ACTIVATION S1: typed activation 필드 top-level 노출(없으면 None). connector 헤더 주입용.
    payload.update(_activation_payload(msg))
    # story #2604 P2: approval-request 카드 스키마 top-level 노출(없으면 None·additive).
    payload.update(_approval_payload(msg))
    # story #2637 AC 0-a: 이벤트 발행 메시지 스키마 top-level 노출(없으면 None·additive).
    payload.update(_event_payload(msg))
    return payload


_ACTIVATION_KINDS = frozenset({"request", "handoff", "result", "ack"})


def _activation_meta(req: "SendMessageRequest") -> dict | None:
    """E-ACTIVATION S1: typed-activation 필드 → msg_metadata['activation']. 없으면 None(완전 additive).
    audience는 빈/None이면 저장 안 함(=all·현행) — 서버가 org 필터한 값을 받는다(호출부).
    message_kind는 4개 enum만 수용(개행/자유텍스트 헤더 오염 차단 — 까디르 QA)."""
    act: dict = {}
    if req.audience:
        act["audience"] = [str(a) for a in req.audience]
    if req.message_kind in _ACTIVATION_KINDS:
        act["kind"] = req.message_kind
    if req.expects_response is not None:
        act["expects_response"] = bool(req.expects_response)
    return {"activation": act} if act else None


def _event_meta(req: "SendMessageRequest") -> dict | None:
    """story #2637 AC 0-a: req.event_context({"event_key","payload"}) → msg_metadata['event'].
    없으면 None(완전 additive) — publish_registry_event만 이 필드를 채운다."""
    return {"event": req.event_context} if isinstance(req.event_context, dict) else None


def _combined_msg_metadata(req: "SendMessageRequest") -> dict | None:
    """_activation_meta/_event_meta 둘 다 독립 namespace라 병합 — 한쪽만 있어도, 둘 다
    없어도(None), 이론상 둘 다 있어도 안전하게 합친다(현재 호출부는 상호배타적으로 쓰지만
    강제하지 않음 — 필드 자체가 각자 optional이라 자연히 배타적이 된다)."""
    merged: dict = {}
    act = _activation_meta(req)
    if act:
        merged.update(act)
    ev = _event_meta(req)
    if ev:
        merged.update(ev)
    return merged or None


def _activation_payload(msg: "ConversationMessage") -> dict:
    """msg_metadata['activation'] → payload top-level(audience/message_kind/expects_response).
    ⚠️ __dict__ 로 «이미 로드된 값만» 읽는다 — `getattr(msg, 'msg_metadata')`는 미로드 컬럼에
    async lazy-load(refresh)를 유발해 sync _msg_payload 안에서 greenlet_spawn 크래시(realdb GET/list).
    __dict__.get = 로드 안 됐으면 None·SimpleNamespace fake 안전·dispatch 경로는 방금 set해 값 있음."""
    meta = (getattr(msg, "__dict__", None) or {}).get("msg_metadata")
    act = meta.get("activation") if isinstance(meta, dict) else None
    act = act or {}
    return {
        "audience": act.get("audience"),
        "message_kind": act.get("kind"),
        "expects_response": act.get("expects_response"),
    }


def _approval_payload(msg: "ConversationMessage") -> dict:
    """story #2604 P2(delivery-contract-blueprint-v0-1): msg_metadata['approval_target'] →
    payload top-level(없으면 None). _activation_payload와 동형(additive·__dict__ 전용 read —
    동일 greenlet_spawn 회피 이유). 카드 *렌더*는 FE 몫 — 여기는 스키마만 실어 나른다."""
    meta = (getattr(msg, "__dict__", None) or {}).get("msg_metadata")
    target = meta.get("approval_target") if isinstance(meta, dict) else None
    return {"approval_target": target if isinstance(target, dict) else None}


def _event_payload(msg: "ConversationMessage") -> dict:
    """story #2637 AC 0-a: msg_metadata['event'] → payload top-level(없으면 None).
    _approval_payload와 동형(additive·__dict__ 전용 read — 동일 greenlet_spawn 회피 이유).
    FE가 이 필드로 "이벤트 발행 메시지"임을 알고 event_key로 block_template을 찾는다
    (#2637 렌더러 축, FE 레인) — 여기는 스키마만 실어 나른다."""
    meta = (getattr(msg, "__dict__", None) or {}).get("msg_metadata")
    event = meta.get("event") if isinstance(meta, dict) else None
    return {"event": event if isinstance(event, dict) else None}


async def _viewer_blocked_sender_ids(auth: AuthContext, org_id: uuid.UUID, db: AsyncSession) -> set[uuid.UUID]:
    """story #2349 — 읽기 경로 전용. viewer(현재 caller)가 차단한 member_id 집합.

    grant-only 휴먼(team_member 행 없음)은 차단 기능을 아직 못 쓴다(user_blocks.py의 동일
    경계) — 여기서는 read 경로가 안 깨지게 빈 집합으로 조용히 폴백한다(차단 0건과 동치).
    """
    resolved = await _resolve_member(auth, org_id, db)
    if not isinstance(resolved, TeamMember):
        return set()
    rows = (await db.execute(
        select(UserBlock.blocked_member_id).where(UserBlock.blocker_member_id == resolved.id)
    )).scalars().all()
    return set(rows)


async def _dispatch_conversation_event(
    db: AsyncSession,
    conversation: Conversation,
    msg: ConversationMessage,
    org_id: uuid.UUID,
    sender: "ResolvedMember | TeamMember",
    exclude_ids: set[uuid.UUID] | None = None,
    webhook_covered_ids: set[uuid.UUID] | None = None,
    references: list[dict[str, str]] | None = None,
) -> list[tuple[str, dict]]:
    """conversation:message → Event INSERT + flush. push 페이로드 반환 (commit 후 호출).

    exclude_ids: SSE 발송에서 제외할 member_id 집합 (Discord 수신자 등).
    webhook_covered_ids: E-EVENT-1CONFIG — webhook 으로 전달되는(=SSE enqueue 스킵할) agent
        member 집합. send_message 요청 트랜잭션서 webhook 전달 대상과 **같은 snapshot** 으로
        산출돼 넘어온다(resolve_conversation_webhook_targets) → skip↔deliver 동일 결정·TOCTOU 차단.
    references: story #2889(S2h, #2263 AC6이 남긴 "SSE/POST 응답은 이 키가 없다" 갭을 닫는다) —
        send_message가 insert_chat_mentions 직후 같은 트랜잭션에서 fetch_stored_references로
        해소해 넘긴다. None이면 기존 동작(키 자체 없음) 무변경 — 이 함수의 다른 잠재 호출부를
        회귀시키지 않는다.
    반환값: [(pid_str, payload)] — db.commit() 완료 후 _push_to_agent() 호출용.
    """
    if not conversation.project_id:
        return []

    payload = _msg_payload(msg, sender, references=references)

    # story #2650: SSE/webhook 패리티 — conversation_webhook.py가 이미 하는 첨부 컨텍스트 주입
    # (attachment_context.py, IDOR-safe·conversation 스코프 게이트 포함)을 SSE 수신자에게도
    # 재사용한다. webhook-covered 수신자는 아래 참여자 루프에서 스킵돼(webhook이 대신 전달)
    # 이 주입은 순수 SSE-only 수신자 payload에만 실린다 — 중복 주입 없음. 이 함수 로컬
    # `payload` dict만 변경하므로 _msg_payload()의 다른 호출부(list_messages 등 읽기 경로)엔
    # 무영향(호출마다 새 dict). 실패는 best-effort(전달 자체는 막지 않음, webhook 경로와 동형) —
    # 로그는 개수만(서명 URL 문자열은 어떤 로그에도 안 찍는다, PO 지적).
    if msg.attachments:
        try:
            from app.services.attachment_context import build_attachment_context
            _ctx, attachment_images = await build_attachment_context(
                msg.attachments, project_id=conversation.project_id,
                conversation_id=conversation.id, org_id=org_id,
            )
            if _ctx:
                _base = payload.get("content") or ""
                payload["content"] = (_base + _ctx) if _base else _ctx.lstrip()
            payload["images"] = attachment_images
            if _ctx or attachment_images:
                logger.info(
                    "attachment_context SSE 주입 message_id=%s attachment_count=%d images=%d",
                    msg.id, len(msg.attachments), len(attachment_images),
                )
        except Exception:
            logger.warning(
                "attachment_context SSE 주입 실패 message_id=%s", msg.id, exc_info=True,
            )

    # 참여자 조회
    rows = (await db.execute(
        select(ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id == conversation.id)
    )).all()
    participant_ids = {r[0] for r in rows} - {sender.id} - (exclude_ids or set())

    if not participant_ids:
        return []

    member_rows = (await db.execute(
        select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(participant_ids))
    )).all()
    member_type_map = {r[0]: r[1] for r in member_rows}

    # E-EVENT-1CONFIG(이중수신 박멸): webhook-covered agent recipient 는 SSE enqueue 스킵 —
    # webhook 경로(deliver_conversation_message_webhook)가 동일 메시지를 전달하므로(대칭). covered
    # 집합은 webhook 실 전달 대상과 같은 snapshot 으로 산출돼(authorized=mentioned 우선·sender 제외 /
    # member-bound / project 독립 / member_id=null 브로드캐스트 제외) 넘어온다 → 비-mentioned
    # participant·human·broadcast 는 covered 밖 → SSE 유지(silent loss 0). human Event 는 무변경(FORK2).
    webhook_covered = webhook_covered_ids or set()

    events_to_push: list[tuple[str, Event]] = []
    _set_working_any = False
    for pid in sorted(participant_ids):  # deadlock 방지: 일관 락 순서
        m_type = member_type_map.get(pid, "human")
        is_agent = m_type == "agent"
        # 1aeecdde P2: agent recipient 에게 메시지가 dispatch = 답장 생성 시작 → working emit.
        # 그 agent 가 reply 를 보내면 send_message 에서 clear, 안 보내면 TTL 자동 소멸(ephemeral).
        # webhook-covered agent 도 webhook 으로 받아 답장하므로 working 표시는 유지한다.
        if is_agent:
            await chat_presence.set_working(str(conversation.id), str(pid))
            _set_working_any = True
        # webhook-covered agent → SSE Event/seq/push 스킵(이중수신 박멸). human Event 는 무변경
        # (웹 UI SSE = events.py status 별경로·FORK2).
        if is_agent and pid in webhook_covered:
            continue
        event = Event(
            project_id=conversation.project_id,
            org_id=org_id,
            event_type="conversation.message_created",  # canonical (S-COMM-12)
            source_entity_type="conversation_message",
            source_entity_id=msg.id,
            sender_id=sender.id,
            recipient_id=pid,
            recipient_type=m_type,
            payload=payload,
            status="pending",
        )
        db.add(event)
        events_to_push.append((str(pid), event))

    # flush로 event.id 확보
    await db.flush()
    # R2(da9d1781): working 변경 → conversation.working + presence SSE 발행(폴링 대체·best-effort).
    if _set_working_any:
        from app.services.presence_events import emit_conversation_working, emit_presence
        await emit_conversation_working(org_id, conversation.id)
        await emit_presence(org_id)
    # per-recipient dense seq 발급 (agent recipient만)
    for pid_str, event in events_to_push:
        if member_type_map.get(event.recipient_id, "human") == "agent":
            await assign_recipient_seq(db, event)
    # L1 BE-3: message fan-out N행 → activity_events 1행 수렴(best-effort·delivery 무영향).
    from app.services.activity_stream import extract_activities_best_effort
    await extract_activities_best_effort(db, [event.id for _, event in events_to_push])
    return [(pid_str, {"event_id": str(event.id), "event_type": "conversation.message_created", **payload,
                       "recipient_seq": event.recipient_seq, "recipient_id": pid_str})
            for pid_str, event in events_to_push]


async def _dispatch_mention_events(
    db: AsyncSession,
    conversation: Conversation,
    msg: ConversationMessage,
    org_id: uuid.UUID,
    sender: TeamMember,
    mention_targets: set[uuid.UUID],
    webhook_covered_ids: set[uuid.UUID] | None = None,
    references: list[dict[str, str]] | None = None,
) -> list[tuple[str, dict]]:
    """AC1: 멘션 대상에게 conversation:mention Event INSERT + flush. push 페이로드 반환 (commit 후 호출).

    webhook_covered_ids: E-EVENT-1CONFIG — webhook 전달 대상과 같은 snapshot 으로 산출된
        SSE-skip agent 집합(_dispatch_conversation_event 와 공유). 멘션 대상 ⊆ authorized 라
        그대로 적용 가능.
    references: story #2889 — _dispatch_conversation_event와 동일 원칙(위 docstring 참고).
    반환값: [(pid_str, payload)] — db.commit() 완료 후 _push_to_agent() 호출용.
    """
    if not conversation.project_id or not mention_targets:
        return []

    payload = _msg_payload(msg, sender, references=references)
    member_rows = (await db.execute(
        select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(mention_targets))
    )).all()
    member_type_map = {r[0]: r[1] for r in member_rows}

    # E-EVENT-1CONFIG(이중수신 박멸): webhook-covered agent 는 SSE(conversation:mention) 스킵 —
    # webhook 이 동일 메시지를 전달. covered 집합은 webhook 실 전달과 같은 snapshot(TOCTOU 차단).
    webhook_covered = webhook_covered_ids or set()

    events_to_push: list[tuple[str, Event]] = []
    for pid in sorted(mention_targets):  # deadlock 방지: 일관 락 순서
        m_type = member_type_map.get(pid, "human")
        # webhook-covered agent → SSE 스킵. human 은 무변경(FORK2).
        if m_type == "agent" and pid in webhook_covered:
            continue
        event = Event(
            project_id=conversation.project_id,
            org_id=org_id,
            event_type="conversation:mention",
            source_entity_type="conversation_message",
            source_entity_id=msg.id,
            sender_id=sender.id,
            recipient_id=pid,
            recipient_type=m_type,
            payload=payload,
            status="pending",
        )
        db.add(event)
        events_to_push.append((str(pid), event))

    # flush로 event.id 확보
    await db.flush()
    for _, event in events_to_push:
        if member_type_map.get(event.recipient_id, "human") == "agent":
            await assign_recipient_seq(db, event)
    # L1 BE-3: mention fan-out N행 → activity_events 1행 수렴(best-effort·delivery 무영향).
    from app.services.activity_stream import extract_activities_best_effort
    await extract_activities_best_effort(db, [event.id for _, event in events_to_push])
    # E-ACTIVATION S1(까디르 QA blocker): 멘션 반환도 recipient_seq/recipient_id를 실어야
    # direct-push↔wake-rescan 활성화 판정이 동형이 된다(안 실으면 대상 본인한테도 addressed_to_you=no로 새고
    # 리플레이 시 뒤집힘 — 이 기능이 막으려던 과소/과잉참여를 오히려 만든다).
    return [(pid_str, {"event_id": str(event.id), "event_type": "conversation:mention", **payload,
                       "recipient_seq": event.recipient_seq, "recipient_id": pid_str})
            for pid_str, event in events_to_push]


async def _dispatch_human_intervention_event(
    db: AsyncSession,
    conversation: Conversation,
    msg: ConversationMessage,
    org_id: uuid.UUID,
    sender: TeamMember,
    blocked_agent_recipient_ids: set[uuid.UUID],
    chain_depth_cap: int,
    references: list[dict[str, str]] | None = None,
) -> list[tuple[str, dict]]:
    """story #2608 P1 AC1: 연쇄 cap 초과로 agent recipient가 막힌 메시지를, 그 대화의 human
    참가자 전원에게 `conversation.human_intervention_requested` Event로 알린다 — "왜 조용한가"
    가 항상 답 가능해야 한다(블루프린트 §3, 침묵이 아니라 이벤트로 전환).

    `_dispatch_mention_events`와 동형 구조(Event INSERT + flush, commit 후 push) — 대상만
    human 참가자로 다르다. human은 recipient_seq 개념이 없어(agent 전용 gap-free 커서)
    assign_recipient_seq를 안 부른다(_dispatch_conversation_event의 기존 관례와 동일).

    references: story #2889 — _dispatch_conversation_event와 동일 원칙.
    """
    if not conversation.project_id:
        return []

    participant_rows = (await db.execute(
        select(ConversationParticipant.member_id, TeamMember.type)
        .join(TeamMember, TeamMember.id == ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id == conversation.id)
    )).all()
    human_targets = {pid for pid, m_type in participant_rows if m_type == "human"}
    if not human_targets:
        return []

    payload = {
        **_msg_payload(msg, sender, references=references),
        "blocked_recipient_ids": [str(rid) for rid in sorted(blocked_agent_recipient_ids)],
        "chain_depth_cap": chain_depth_cap,
        "reason": "chain-expired",
    }

    events_to_push: list[tuple[str, Event]] = []
    for pid in sorted(human_targets):  # deadlock 방지: 일관 락 순서
        event = Event(
            project_id=conversation.project_id,
            org_id=org_id,
            event_type="conversation.human_intervention_requested",
            source_entity_type="conversation_message",
            source_entity_id=msg.id,
            sender_id=sender.id,
            recipient_id=pid,
            recipient_type="human",
            payload=payload,
            status="pending",
        )
        db.add(event)
        events_to_push.append((str(pid), event))

    await db.flush()
    from app.services.activity_stream import extract_activities_best_effort
    await extract_activities_best_effort(db, [event.id for _, event in events_to_push])
    return [
        (pid_str, {"event_id": str(event.id), "event_type": "conversation.human_intervention_requested",
                   **payload, "recipient_id": pid_str})
        for pid_str, event in events_to_push
    ]


async def _command_capability_gate(
    db: AsyncSession,
    conv: Conversation,
    msg: ConversationMessage,
    sender: "ResolvedMember | TeamMember",
    org_id: uuid.UUID,
) -> tuple[set[uuid.UUID], list[dict]]:
    """E-CHAT-CMD S4: capability gate — 슬래시 커맨드를 미지원 런타임 에이전트에 주입하지 않는다.

    메시지가 command candidate(S3 classifier)면, conversation 의 에이전트 수신자 각각의
    runtime_type 을 capability registry(S1)로 조회한다. 결정적 커맨드 미지원(또는 runtime_type
    없음/unknown) 에이전트는 **주입 차단**(반환된 id 를 dispatch exclude 로 사용) + audit log
    `command_blocked_unsupported_runtime` 기록 + hint 생성. 지원 에이전트는 그대로 pass-through.

    비-command 메시지는 빈 결과 → 기존 경로 무영향(AC4 회귀). project_id 없는 conversation 은
    애초에 에이전트 dispatch 가 없어 게이트 무의미 → 빈 결과.

    반환: (blocked_agent_ids, hints) — hints 는 발신자에게 돌려줄 구조화 안내.
    """
    candidate = classify_command(msg.content)
    if candidate is None or not conv.project_id:
        return set(), []

    rows = (await db.execute(
        select(TeamMember.id, TeamMember.name, TeamMember.runtime_type)
        .join(ConversationParticipant, ConversationParticipant.member_id == TeamMember.id)
        .where(
            ConversationParticipant.conversation_id == conv.id,
            TeamMember.type == "agent",
            TeamMember.id != sender.id,
        )
    )).all()

    blocked: set[uuid.UUID] = set()
    hints: list[dict] = []
    for agent_id, agent_name, runtime_type in rows:
        if supports_deterministic_command(runtime_type):
            continue  # AC2: 지원 런타임 → pass-through(기존 dispatch)
        # AC3/AC4: 미지원(또는 runtime_type 없음/unknown) → 차단 + audit + hint
        blocked.add(agent_id)
        db.add(AgentAuditLog(
            org_id=org_id,
            project_id=conv.project_id,
            agent_id=agent_id,
            event_type="command_blocked_unsupported_runtime",
            severity="info",
            summary=f"'/{candidate.name}' blocked — runtime '{runtime_type or 'unset'}' lacks deterministic command support",
            payload={
                "command": candidate.name,
                "raw": candidate.raw,
                "runtime_type": runtime_type,
                "conversation_id": str(conv.id),
                "message_id": str(msg.id),
                "sender_id": str(sender.id),
            },
        ))
        hints.append({
            "agent_id": str(agent_id),
            "agent_name": agent_name,
            "runtime_type": runtime_type,
            "command": candidate.name,
            "reason": "unsupported_runtime",
        })

    if blocked:
        await db.flush()
    return blocked, hints


async def _dispatch_discord_outbound(
    message_id: uuid.UUID,
    org_id: uuid.UUID,
) -> None:
    """Discord 아웃바운드 (AC9~11).

    ChannelRouter가 discord 선택한 수신자 → webhook_configs Discord endpoint 발송.
    Discord 선택 시 SSE 동시 발송 금지 (AC10).
    Discord endpoint 미설정 시 sse fallback (AC11).
    """
    from app.core.database import async_session_factory
    from app.services.channel_router import ChannelRouterError, route_message
    from sqlalchemy import select

    async with async_session_factory() as db:
        try:
            decisions = await route_message(message_id, db)
        except ChannelRouterError:
            logger.exception("ChannelRouter failed message_id=%s — skipping discord outbound", message_id)
            return

        discord_members = [d for d in decisions if d.channel == "discord"]
        if not discord_members:
            return

        import httpx
        for decision in discord_members:
            # discord channel WebhookConfig 조회
            wh = (await db.execute(
                select(WebhookConfig).where(
                    WebhookConfig.member_id == decision.member_id,
                    WebhookConfig.channel == "discord",
                    WebhookConfig.is_active.is_(True),
                )
            )).scalars().first()

            if wh is None:
                # AC11: Discord endpoint 미설정 → sse fallback (SSE는 이미 _dispatch_conversation_event에서 처리)
                logger.info(
                    "Discord endpoint not configured for member %s — SSE fallback already dispatched",
                    decision.member_id,
                )
                continue

            # Discord URL이면 content/embeds 포맷, 아니면 generic JSON
            is_discord_url = (
                "discord.com/api/webhooks" in wh.url
                or "discordapp.com/api/webhooks" in wh.url
            )
            content_text = f"[conversation:message] message_id: {message_id}"
            if is_discord_url:
                discord_payload: dict = {"content": content_text}
            else:
                discord_payload = {"event_type": "conversation.message_created", "message_id": str(message_id)}

            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(wh.url, json=discord_payload)
            except Exception:
                logger.warning(
                    "Discord outbound failed member_id=%s url=%s", decision.member_id, wh.url, exc_info=True
                )


async def _create_conversation_record(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    member_ids: set[uuid.UUID],
    conv_type: str,
    title: str | None,
    created_by: uuid.UUID,
) -> Conversation:
    """story #2604 P2(delivery-contract-blueprint-v0-1) 추출: create_conversation 엔드포인트의
    INSERT 로직(원본 그대로, 추출만 — 동작 불변) — 인가(_enforce_agent_creator_policy)·dedup
    정책(EF-S2 항상-신규)은 호출부 책임. approval-request DM(get-or-create 배달 경로,
    app/services/approval_delivery.py)이 이 프리미티브를 재사용한다."""
    all_members = sorted(member_ids)
    dm_pair_key = "|".join(str(m) for m in all_members) if conv_type == "dm" else None
    conv = Conversation(
        project_id=project_id,
        org_id=org_id,
        type=conv_type,
        title=title,
        created_by=created_by,
        dm_pair_key=dm_pair_key,
    )
    db.add(conv)
    await db.flush()
    for mid in all_members:
        db.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    return conv


# ─── Schemas ──────────────────────────────────────────────────────────────────

class CreateConversationRequest(BaseModel):
    type: str = "group"  # dm | group
    title: str | None = None
    participant_ids: list[uuid.UUID]
    project_id: uuid.UUID


class ConversationResponse(BaseModel):
    """단독 conversation 메타. 03fe1663: 첨부 업로드 라우트가 path projectId를
    클라이언트 쿠키 대신 conversation.project_id로 server-side 도출하는 데 사용."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    type: str
    title: str | None = None
    status: str
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    # 270c87e6: caller의 알림 mute 상태(participant muted_at 기반) — FE mute 토글 초기 상태용(#1426).
    muted: bool = False
    # story #1976 (E-CHAT-REALTIME 트랙A): caller의 read state(participant.last_read_at) +
    # 파생 unread_count. 비참여자(admin-bypass agent-only 대화)는 last_read_at=None·unread_count=0.
    last_read_at: datetime | None = None
    unread_count: int = 0
    # story #2009: list_conversations와 동일 shape의 participants(재사용, 로직 복제 금지 — AC).
    # dict 그대로 노출(별도 Pydantic 서브모델 미도입) — list 엔드포인트와 byte-identical JSON 보장.
    participants: list[dict] = Field(default_factory=list)


# E-FILE S1: 채팅 첨부. GCS 기록은 FE-proxy(uploadToGcs)가 처리하고 BE는 URL+메타만 저장.
_MAX_ATTACHMENTS = 10
_MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024  # 100MB (메타 sanity 상한)

# E-MCP-OPT S2(bbfd24ba)/S6: MCP(비-브라우저) 클라이언트용 JSON/base64 업로드 공용 프리미티브
# (S6 부터 story/doc 도 공유 — `app/services/mcp_attachment_upload.py` 참조).
_MAX_JSON_ATTACHMENT_UPLOAD_SIZE = mcp_attachment_upload.MAX_JSON_ATTACHMENT_UPLOAD_SIZE
_MAX_ATTACHMENT_NAME_LEN = mcp_attachment_upload.MAX_ATTACHMENT_NAME_LEN
_MCP_MAX_ATTACHMENTS = mcp_attachment_upload.MCP_MAX_ATTACHMENTS
_MCP_MAX_TOTAL_ATTACHMENT_BYTES = mcp_attachment_upload.MCP_MAX_TOTAL_ATTACHMENT_BYTES


def _is_mcp_upload_object_path(url: str) -> bool:
    return mcp_attachment_upload.is_mcp_upload_object_path(url, kind="chat")


class MessageAttachment(BaseModel):
    url: str           # FE-proxy 업로드 객체 url(https GCS 또는 canonical bare path·provider 추상)
    name: str          # 원본 파일명
    content_type: str  # MIME
    size: int          # 바이트
    # E-STORAGE-SSOT S7: asset registry row id(denorm·catch#4). asset_links=SSOT·이 필드=denorm.
    # optional(legacy 첨부·미등록 호환). save 시 이 값으로 asset_link 파생(drift 0).
    asset_id: uuid.UUID | None = None
    # story #2055 AC1/AC2/AC4: 이미지 첨부의 픽셀 크기 — 서버가 업로드 시점에 측정해 채운다
    # (client 제공값은 위조 가능해 신뢰 안 함, image_dimensions.measure_image_dimensions).
    # 비이미지 첨부(문서/오디오/비디오)·측정 실패·기존(이 필드 도입 전) 첨부는 None이 정상
    # (AC4·AC3 — additive·nullable, 백필 안 함. FE는 None이면 기존 고정 프레임으로 폴백).
    width: int | None = None
    height: int | None = None

    @field_validator("url")
    @classmethod
    def _validate_url(cls, v: str) -> str:
        # https URL(legacy/GCS) 또는 canonical bare object path(local/s3) 허용·외부 스킴 거부.
        return validate_attachment_url(v)

    @field_validator("name", "content_type")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v

    @field_validator("size")
    @classmethod
    def _validate_size(cls, v: int) -> int:
        if v < 0:
            raise ValueError("size must be >= 0")
        if v > _MAX_ATTACHMENT_SIZE:
            raise ValueError(f"attachment too large (max {_MAX_ATTACHMENT_SIZE} bytes)")
        return v


class SendMessageRequest(BaseModel):
    content: str
    mentioned_ids: list[uuid.UUID] = []
    thread_id: uuid.UUID | None = None
    attachments: list[MessageAttachment] = []
    # E-ACTIVATION S1 (typed activation · additive): 발신자가 «응답 의무»를 구조로 선언.
    # audience=응답 대상 member_ids(빈/None=all·현행 유지·서버가 org 필터) · message_kind=의미유형
    # (라우팅 event_type과 별개인 새 의미 필드·4개 enum만 저장) · expects_response. connector가 헤더로 주입(Y).
    audience: list[uuid.UUID] | None = None
    message_kind: str | None = None  # request | handoff | result | ack
    expects_response: bool | None = None
    # story #2637 AC 0-a: publish_registry_event(#2633) 전용 additive 필드 — {"event_key":
    # str, "payload": dict}. approval_target(approval_delivery.py)과 동형 namespace 패턴이지만
    # 그쪽은 send_message()를 우회해 ConversationMessage를 직접 구성하는 반면(#2604의 승인
    # 카드 전용 별도 경로, 그 자체가 명시적 예외), 이건 send_message()의 기존 확장 메커니즘
    # (E-ACTIVATION S1의 typed-field→msg_metadata 패턴)을 그대로 따른다 — #2633 AC2(신규
    # 전달 계통 금지)를 지키면서 publish_registry_event가 이 필드로 "이 메시지가 이벤트
    # 발행분임"을 msg_metadata에 실을 수 있게 한다. 공개 REST 문서에는 안 실을 내부 필드.
    event_context: dict | None = None

    @field_validator("attachments")
    @classmethod
    def _limit_attachments(cls, v: list[MessageAttachment]) -> list[MessageAttachment]:
        if len(v) > _MAX_ATTACHMENTS:
            raise ValueError(f"too many attachments (max {_MAX_ATTACHMENTS})")
        return v


class UploadConversationAttachmentRequest(BaseModel):
    """E-MCP-OPT S2: MCP(비-브라우저)용 JSON/base64 첨부 업로드 요청."""

    content_base64: str
    name: str
    content_type: str

    @field_validator("content_base64", "name", "content_type")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v

    @field_validator("content_type")
    @classmethod
    def _content_type_sane(cls, v: str) -> str:
        if len(v) > _MAX_ATTACHMENT_NAME_LEN or any(ord(ch) < 32 for ch in v):
            raise ValueError("invalid content_type")
        return v


class UpdateStatusRequest(BaseModel):
    status: str  # open | resolved


class UpdateConversationRequest(BaseModel):
    # EF-S2 (db75ecd0) AC3: 방 title 사용자 편집. title 제공 시만 갱신(기본 생성 title 보존).
    title: str | None = None
    # story #2603 P0 AC2: free_response 대화 스코프 옵트아웃(channel_router.py 참조).
    # 제공 시만 갱신 — 미제공은 기존값 보존(title과 동일 partial-update 규약).
    free_response: bool | None = None


class AddParticipantRequest(BaseModel):
    member_id: uuid.UUID


class MuteRequest(BaseModel):
    muted: bool


class MarkReadRequest(BaseModel):
    """story #1976: up_to 지정 시 그 시각으로 SET(FE 실 렌더 마지막 메시지 timestamp — 권장 경로).
    up_to 생략 시 서버 now() 사용 — 이는 "전체 읽음"(mark-all-read) 명시 액션 전용 의도(§3-2)."""

    up_to: datetime | None = None


class CircuitBreakerReleaseRequest(BaseModel):
    """story #2630: 서킷브레이커 수동 해제 — reason은 감사 표시용(선택)."""

    reason: str | None = None


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
async def create_conversation(
    body: CreateConversationRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/conversations — dm/group 생성 (dm 중복 방지)."""
    sender = await _resolve_member(auth, org_id, db, project_id=body.project_id)

    # E-SECURITY SEC-S3(story 90cd7e57): participant_ids가 org 멤버십 필터 없이 그대로 insert
    # 됐음(add_participant/멘션발송과 비대칭 — 그 두 경로는 이미 org-scope 검증). cross-org UUID를
    # 참가자로 넣을 수 있던 갭 봉쇄 — 조용히 제거(에러 아님, 존재하는 유효 참가자만 방에 남음).
    valid_participant_ids = await filter_org_member_ids(set(body.participant_ids), org_id, db)

    # ⭐ 인가 불변식: 휴먼↔에이전트 대화 — 에이전트 creator 동석 필수
    await _enforce_agent_creator_policy(sender, list(valid_participant_ids), db)

    # EF-S2 (db75ecd0): "기존방 다이렉트" 제거 — 동일 2인 pair여도 매 호출 신규 conversation 생성
    # (여러 conversation 공존·각 1주제·hermes 세션별 1방=1주제). 179db213 의 1-DM-per-pair
    # dedup + uq_conversations_dm_pair 정책 회귀(마이그 0111 에서 unique index drop).
    # 불변 보존: creator 동석/allow_list(_enforce_agent_creator_policy 위), 메시지 dedup(send_message·별개),
    # thread=스토리. dm_pair_key 컬럼은 2인 룸 태깅용으로 유지(non-unique·dedup 아님).
    all_members = sorted({sender.id, *valid_participant_ids})
    is_dm = len(all_members) == 2

    try:
        conv = await _create_conversation_record(
            db,
            org_id=org_id,
            project_id=body.project_id,
            member_ids=set(all_members),
            conv_type=("dm" if is_dm else body.type),
            title=body.title,
            created_by=sender.id,
        )
        await db.commit()
    except IntegrityError:
        # dedup unique 제거 후엔 DM pair 레이스 충돌 없음 — 잔여 무결성 오류는 reuse 없이 전파.
        await db.rollback()
        raise
    await db.refresh(conv)
    return {"id": str(conv.id), "type": conv.type, "title": conv.title, "existing": False}


@router.get("")
async def list_conversations(
    project_id: uuid.UUID = Query(...),
    include_agent_conversations: bool = Query(default=False),
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations — 최근 메시지 미리보기 + 참여 대화 목록."""
    sender = await _resolve_member(auth, org_id, db, project_id=project_id)

    # AC5: include_agent_conversations는 owner/admin만 허용 (org-effective role — project team_member
    # role이 낮아도 org owner/admin이면 상속·#1223↔SSOT뷰 갭 보정)
    if include_agent_conversations and await _effective_org_role(
        auth, org_id, db, sender, project_id=project_id,
    ) not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Only owner/admin can view agent conversations.")

    conv_ids_result = await db.execute(
        select(
            ConversationParticipant.conversation_id,
            ConversationParticipant.muted_at,
            ConversationParticipant.last_read_at,
        ).where(
            ConversationParticipant.member_id == sender.id
        )
    )
    _caller_rows = conv_ids_result.all()
    conv_ids = set(r.conversation_id for r in _caller_rows)
    # 270c87e6: caller의 대화별 mute 상태(FE 토글 초기 상태·#1426). admin-bypass로 추가되는
    # agent-only 대화는 caller가 참여자 아니라 자연히 False.
    caller_muted = {r.conversation_id: r.muted_at is not None for r in _caller_rows}
    # story #1976: caller의 대화별 read state(participant.last_read_at) — 같은 배치 쿼리에 편승
    # (신규 쿼리 추가 아님·N+1 무영향). admin-bypass agent-only 대화는 caller 미참여라 자연히 None.
    caller_last_read_at = {r.conversation_id: r.last_read_at for r in _caller_rows}

    # AC1/2 + #1262: admin-bypass는 **agent-only 대화로 한정**(사적 DM 프라이버시).
    # project 내 agent type member가 participant인 conversation 후보를 모으되,
    # 휴먼 참가 대화(=private)는 보수적 판별로 제외 — admin에게 추가 노출 금지.
    # (본인 참여 대화는 base conv_ids로 이미 포함되니 무관.)
    if include_agent_conversations:
        agent_ids_result = await db.execute(
            select(TeamMember.id).where(
                TeamMember.project_id == project_id,
                TeamMember.org_id == org_id,
                TeamMember.type == "agent",
                TeamMember.is_active.is_(True),
            )
        )
        agent_ids = [r[0] for r in agent_ids_result.all()]
        if agent_ids:
            agent_conv_result = await db.execute(
                select(ConversationParticipant.conversation_id).where(
                    ConversationParticipant.member_id.in_(agent_ids)
                )
            )
            candidate_conv_ids = {r[0] for r in agent_conv_result.all()}
            human_convs = await _conversations_with_human_participant(list(candidate_conv_ids), db)
            conv_ids.update(candidate_conv_ids - human_convs)  # agent-only만 admin에게 추가

    if not conv_ids:
        return {"data": [], "total": 0, "limit": limit, "offset": offset}

    conv_filter = (
        Conversation.id.in_(conv_ids),
        Conversation.org_id == org_id,
        Conversation.project_id == project_id,
    )
    total = (await db.execute(
        select(func.count()).select_from(Conversation).where(*conv_filter)
    )).scalar_one()

    convs = (await db.execute(
        select(Conversation)
        .where(*conv_filter)
        .order_by(Conversation.updated_at.desc())
        .limit(limit).offset(offset)
    )).scalars().all()

    # participants 배치 조회 (N+1 방지) — story #2009: get_conversation과 공유하는 헬퍼로 추출.
    conv_id_list = [c.id for c in convs]
    conv_participants = await _fetch_conversation_participants(conv_id_list, db)

    # story #1976: unread_count 배치 — 단일 JOIN+GROUP BY(N+1 방지, §4-2). INNER JOIN이라
    # unread=0 대화는 결과행 없음 → dict.get(id, 0)으로 자연 0 처리.
    unread_rows = (await db.execute(
        _list_unread_counts_stmt(sender.id, conv_id_list)
    )).all() if conv_id_list else []
    unread_map: dict[uuid.UUID, int] = {r[0]: r[1] for r in unread_rows}

    # story #2925: 행 승격 신호 배치 조회(N+1 방지 — 쿼리 2개 고정, 리스트 크기 무관).
    linked_proof_map = await _batch_resolve_linked_proof(conv_id_list, org_id, db)

    result = []
    for conv in convs:
        latest_msg = (await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.conversation_id == conv.id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()

        result.append({
            "id": str(conv.id),
            "type": conv.type,
            "title": conv.title,
            "status": conv.status,
            "resolved_by": str(conv.resolved_by) if conv.resolved_by else None,
            "resolved_at": conv.resolved_at.isoformat() if conv.resolved_at else None,
            "participants": conv_participants.get(conv.id, []),
            "muted": caller_muted.get(conv.id, False),  # 270c87e6: FE mute 토글 초기 상태
            # story #1976: caller read state + 파생 unread_count(단일 JOIN+GROUP BY, N+1 없음).
            "last_read_at": (
                caller_last_read_at.get(conv.id).isoformat()
                if caller_last_read_at.get(conv.id) else None
            ),
            "unread_count": unread_map.get(conv.id, 0),
            # story #2925(2921-S2 선행) — 참조 없으면 null(fail-safe, 거짓 색 금지).
            "linked_proof": linked_proof_map.get(conv.id),
            "latest_message": {
                "content": latest_msg.content,
                "created_at": latest_msg.created_at.isoformat(),
            } if latest_msg else None,
            "updated_at": conv.updated_at.isoformat(),
        })

    return {"data": result, "total": total, "limit": limit, "offset": offset}


@router.get("/unread-count")
async def get_unread_count_total(
    # story #2451(§6 Phase3 A1): 고빈도 카운터·create→self-read 흐름 없음 → read replica.
    db: AsyncSession = Depends(get_read_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations/unread-count — story #1992: GNB 채팅 unread 총합(count-only).

    caller(인증된 member)가 참여 중인 **전 대화**(페이지네이션 무관)의 unread_count를 SUM한
    `{"count": int}`만 반환 — 대화 메타데이터(제목/참가자 등) 미포함. list_conversations의
    per-conversation unread_count(story #1976, §4-2 `_list_unread_counts_stmt`)와 동일
    SSOT 쿼리를 확장(`_total_unread_count_stmt`)해 재사용 — 계산 로직 재구현 없음.

    project_id 미지정: GNB는 프로젝트 무관 org-wide 집계(다른 count-only 엔드포인트인
    event-notifications/unread-count·notifications/count와 동일 관례로 `{"count": int}`
    shape 통일 — PO 정정, 2026-07-18: 초안은 `{"total"}`이었으나 API 일관성 우선).

    주의(기존 아키텍처 갭 · 본 story 스코프 밖): `_resolve_member`가 project_id 없이 호출되면
    복수 project의 team_member 행을 가진 human은 `.first()`로 임의 1개 project만 해소된다
    (event_notifications.py `_resolve_member_id`도 동일 관례). grant-only 휴먼은 canonical
    org_member.id로 해소되어 이 갭이 없다.
    """
    sender = await _resolve_member(auth, org_id, db)
    total = (await db.execute(_total_unread_count_stmt(sender.id))).scalar_one()
    return {"count": int(total)}


@router.get("/recent-outside-project")
async def list_recent_conversations_outside_project(
    project_id: uuid.UUID = Query(..., description="현재 보고 있는 프로젝트(제외 대상)"),
    limit: int = Query(default=5, ge=1, le=5),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations/recent-outside-project — story #2168 PR-② BE.

    현재 프로젝트 **밖**에서 caller가 참여 중인 대화 최근 5개. 정렬 축은 유나·오르테가군
    승인 스펙(2026-07-27) 그대로 caller 자신의 `ConversationParticipant.last_read_at`
    (내가 마지막으로 들어간 시각) DESC — ⛔ 대화의 마지막 메시지 시각이 아니다(크로스-프로젝트
    목록에서 그 축은 "남이 더 떠든 방이 위로 온다"는 소음이 된다, 스펙 문구 그대로).
    NULL(한 번도 안 들어간 참여)은 가장 오래 전 취급으로 정렬 뒤로 밀린다(`nulls_last()`).

    인가(스펙 실패-자리 "수동 사라짐=조용히 빠짐, 무알림"의 BE 축): FE가 나중에 403/404로
    거르는 게 아니라 **이 쿼리 자체가** 지금 시점 접근 불가 대화를 담지 않는다 —
    `project_access_valid_correlated`(project_auth.py, `has_project_access`와 동일
    SSOT `_project_access_predicate` 재사용, story #1994 5회차가 확립한 "참가 행은 남아도
    project_access 회수 시 못 읽는다" 불변식)를 메인 statement의 WHERE절에 직접 correlate —
    별도 SELECT로 "접근 가능 project 집합"을 먼저 만들어 `.in_()`으로 거르는 2-phase가 아니라
    같은 스냅샷 안에서 평가되는 correlated EXISTS(TOCTOU-by-construction, backlinks.py와 동형).

    admin-bypass(`conversation_readable_predicate`의 우변, agent-only 대화를 관리자에게
    추가 노출하는 축)는 여기서 의도적으로 미적용 — 이 엔드포인트는 애초에
    `ConversationParticipant`(caller 자신의 참가 행)를 INNER JOIN해 "내가 참여한 대화"로만
    후보를 좁힌다(비참여 admin-bypass 대화는 `last_read_at`이라는 정렬 축 자체가 없어
    "오래 안 들어간 것부터" 캡의 의미론에 애초에 안 낀다 — list_conversations의
    `include_agent_conversations`처럼 별도 admin 전용 노출 축이 필요하면 그건 이 스토리
    스코프 밖의 별개 결정).

    story #2972 — participants는 unread_count/latest_message와 달리 "미리보기용 부가정보"가
    아니라 DM 행의 **유일한 이름 소스**다(Conversation.title은 DM에서 항상 NULL — 표시명은
    참가자 이름으로 클라 조립하는 게 list_conversations 관례). 애초 스펙(#2168)이 이걸
    "미리보기"로 묶어 함께 뺐던 게 원인 — limit≤5라 배치조회 비용은 무시 가능해 여기만
    되살린다(unread_count/latest_message는 스펙 그대로 계속 뺀다).
    """
    sender = await _resolve_member(auth, org_id, db, project_id=None)
    uid = uuid.UUID(str(auth.user_id))

    # 응답용 project 조인은 별도 alias로 둔다 — `project_access_valid_correlated`가 내부에서
    # 다루는 `Project`와 identity가 겹치면 SQLAlchemy가 이 outer join의 Project를 correlated
    # EXISTS 안쪽으로 잘못 끌어들여(auto-correlation) "FROM 절 0개"로 즉시 InvalidRequestError —
    # 실측으로 발견(realdb 테스트 최초 실행 시 100% 재현).
    ProjectAlias = aliased(Project)

    stmt = (
        select(Conversation, ProjectAlias.name, ProjectAlias.slug, ConversationParticipant.last_read_at)
        .join(
            ConversationParticipant,
            and_(
                ConversationParticipant.conversation_id == Conversation.id,
                ConversationParticipant.member_id == sender.id,
            ),
        )
        .join(ProjectAlias, ProjectAlias.id == Conversation.project_id)
        .where(
            Conversation.org_id == org_id,
            Conversation.project_id != project_id,
            project_access_valid_correlated(Conversation.project_id, caller_id=uid, org_id=org_id),
        )
        .order_by(ConversationParticipant.last_read_at.desc().nulls_last())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()

    # story #2972 — DM 행은 title이 항상 NULL(대화명은 참가자 이름으로 클라 조립, list_conversations
    # 관례 그대로)인데 이 엔드포인트가 participants를 안 내려줘 FE가 조립할 재료 자체가 없었다
    # ("님과의 대화"라는 접미 조각만 그대로 노출되던 원인). limit≤5라 배치조회 비용 무시 가능
    # — list_conversations/get_conversation과 동일 헬퍼(_fetch_conversation_participants) 재사용.
    conv_participants = await _fetch_conversation_participants([conv.id for conv, *_ in rows], db)

    return {
        "data": [
            {
                "id": str(conv.id),
                "type": conv.type,
                "title": conv.title,
                "project_id": str(conv.project_id),
                "project_name": project_name,
                "project_slug": project_slug,
                "last_read_at": last_read_at.isoformat() if last_read_at else None,
                "participants": conv_participants.get(conv.id, []),
            }
            for conv, project_name, project_slug, last_read_at in rows
        ]
    }


@router.get("/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ConversationResponse:
    """GET /api/v2/conversations/{id} — 단독 메타 조회(project_id 포함).

    03fe1663: 첨부 업로드 라우트가 attachment path의 projectId를 클라이언트 쿠키
    대신 conversation.project_id로 server-side 도출하도록 메타를 제공한다.
    인가(#1262 갱신): admin-bypass=agent-only 대화 한정 — 휴먼 참가 대화(=private)는
    owner/admin도 participant only(사적 DM 프라이버시). 본인 참여 대화는 항상 정상.
    """
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # story #2697: get_conversation이 conversation_readable_predicate SSOT(§6회차 — backlinks.py·
    # list_conversations·_can_read_conversation이 이미 쓰는 canonical judge)로 안 옮겨간 마지막
    # 소비자였다(reviewer round-5 verdict가 이 자리를 스코프 밖으로 남겼던 것 — 여기서 마저
    # 닫는다). _effective_org_role의 사전 해소(TOCTOU류·project_scope.py 문서와 동일 클래스) +
    # 별도 participant SELECT 대신 이미 검증된 SSOT를 그대로 재사용한다(재구현 0) — 판정 자체
    # (participant∧project-access-valid ∨ ¬human-participant∧admin-bypass)는 불변, 소싱만
    # 통일. 404로 존재-비노출(구 403 "Not a participant"는 참가여부를 노출했다 — 다른 리소스
    # (goals·stories·sprints·retros·gates) 다수 관례에 맞춰 통일, story #2697 AC②).
    if not await _can_read_conversation(
        conversation_id, db, auth, org_id, _conv_project_id=conv.project_id,
    ):
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)

    # 270c87e6: caller의 mute 상태 노출(FE 토글 초기 상태·#1426). 비참여자(admin-bypass agent-only)는 False.
    # story #1976: 같은 단건 조회에 last_read_at도 편승(신규 쿼리 아님) — unread_count는 참여자일 때만 계산.
    caller_row = (await db.execute(
        select(ConversationParticipant.muted_at, ConversationParticipant.last_read_at).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).one_or_none()
    # story #2009: `ConversationResponse.model_validate(conv)`(from_attributes) 대신 필드별
    # 명시 구성 — `Conversation.participants`는 SQLAlchemy 관계(lazy="select")라 동명의
    # Pydantic 필드를 자동추출 시도하면 sync getattr가 비동기 세션 lazy-load를 트리거해
    # `MissingGreenlet`으로 500(신규 필드 도입 시 실측 발견). 배치 헬퍼 결과로 아래서 명시 대입.
    resp = ConversationResponse(
        id=conv.id,
        project_id=conv.project_id,
        org_id=conv.org_id,
        type=conv.type,
        title=conv.title,
        status=conv.status,
        created_by=conv.created_by,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
    )
    resp.muted = caller_row is not None and caller_row.muted_at is not None
    if caller_row is not None:
        resp.last_read_at = caller_row.last_read_at
        resp.unread_count = (await db.execute(
            _unread_count_stmt(conversation_id, sender.id, caller_row.last_read_at)
        )).scalar_one()
    # story #2009: 단건 조회도 list_conversations와 동일 participants shape을 자체 포함 —
    # FE가 30건 캡 있는 list 엔드포인트에 기대던 workaround(.find() miss 버그) 제거.
    participants_map = await _fetch_conversation_participants([conversation_id], db)
    resp.participants = participants_map.get(conversation_id, [])
    return resp


async def _can_read_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession,
    auth: AuthContext,
    org_id: uuid.UUID,
    *,
    _conv_project_id: uuid.UUID | None = None,
) -> bool:
    """story #1994(E-KNOWLEDGE-LINK S2) 4~6회차 pass §8②: 메시지 조회 인가의 canonical bool 술어.

    실제 판정 로직(participant∧project-access-valid ∨ ¬human-participant∧admin-bypass)은
    `app.services.conversation_auth.conversation_readable_predicate`(SSOT — 문서화된 캐노니컬
    predicate, `app/services/backlinks.py`의 벌크 쿼리도 **같은 함수**를 호출해 SAME WHERE절에
    correlate한다)에 있다. §6회차부터 `admin_bypass_eligible` atom도 `backlinks.py`와 **같은**
    correlated SSOT(`org_admin_valid_correlated`/`project_admin_valid_correlated`,
    project_auth.py)를 재사용한다(재구현 0) — 예전엔 `_effective_org_role`의 사전 해소 결과를
    bool 리터럴로 넘겼다(별개 pre-resolve TOCTOU 클래스, 아래 본문 참조). `project_access_valid`
    atom은 여전히 `has_project_access` 단건 호출(§6회차 스코프 밖 — reviewer round-5 verdict가
    `admin_bypass_eligible`만 잔여로 지목). 이 함수는 그 앞뒤로 project_id 조회·caller 신원
    해소(이 hot path의 기존 pre-fetch 관례 유지 — 성능/행동 불변)를 감싸고, 존재하지
    않는 대화/비참여자 판정 모두 raise 대신 False를 반환하는 total-boolean 계약을 지킨다.
    백링크 API처럼 404/403 semantics(존재 비노출 오라클 회피)가 필요 없는 호출부가 "읽을 수
    있는가"만 물을 때 쓴다. 404/403이 필요한 기존 호출부는 여전히 `_authorize_message_read`를
    쓴다(zero duplication — 그쪽이 이 함수를 얇게 감싼다).

    **계약: 이 함수는 절대 raise하지 않는다(total boolean predicate)** — story #1994 B1
    하드닝(산티아고 sabotage-probe): `_resolve_member`가 project-scoped 해소에서 grant-loss
    시 HTTPException(403)을 raise할 수 있었는데, 과거엔 이게 여기서 안 잡혀 백링크 API처럼
    행 단위 판정을 기대하는 호출부까지 통째로 poison했다. 아래 본문은 try/except HTTPException
    로 감싸 False로 정규화한다.

    `_conv_project_id`: `_authorize_message_read`가 이미 조회해둔 project_id를 넘기면 동일 PK
    SELECT를 중복 실행하지 않는다(메시지 목록/단건/리플 등 hot path 성능 보존). 직접 호출부
    (백링크)는 생략 — 이 함수가 자체적으로 조회한다.
    """
    conv_project_id = _conv_project_id
    if conv_project_id is None:
        conv_project_id = (await db.execute(
            select(Conversation.project_id).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
        )).scalar_one_or_none()
        if conv_project_id is None:
            return False

    # story #1994 B1 하드닝(산티아고 sabotage-probe 발견): 아래(org-level 1차 해소부터
    # project-access 재확인까지)는 `_resolve_member` → `member_resolver.resolve_member`가
    # project_id 스코프에서 HTTPException(403 "No access to this project")을 raise할 수 있다
    # (caller가 SOURCE project 접근을 잃은 grant-loss 케이스). 이 함수는 "raise 없는 total
    # boolean predicate" 계약이다(백링크 API처럼 존재-비노출 오라클이 필요한 호출부가 mention
    # 행 단위 판정에 쓴다) — raise가 새면 mention 한 행의 미인가가 전체 backlinks 응답을
    # poison한다(B1: 한 행 제외가 아니라 엔드포인트 전체 실패). try/except로 전 구간을 봉합 —
    # `_authorize_message_read`(아래·기존 raise-based wrapper)는 이 함수가 False를 반환하면
    # 자신의 403을 별도로 raise하므로, 실제 메시지 엔드포인트(list/get)가 외부에 노출하는
    # "grant-loss ⇒ 403" 동작 자체는 그대로 유지된다(상태코드 불변, 회귀 아님).
    try:
        # owner/admin: org-level 조회(project 소속 무관 접근), member: project-level 유지
        sender = await _resolve_member(auth, org_id, db, project_id=None)

        # §6회차(마지막 atom, 산티아고 명시 요구 — "_can_read_conversation 단건도 같은 atom"):
        # `admin_bypass_eligible`을 더 이상 `_effective_org_role`의 사전 해소 결과(bool 리터럴)로
        # 소싱하지 않는다. 예전엔 `_effective_org_role(...)`이 별도 SELECT(휴먼=OrgMember.role
        # 조회, 에이전트=`get_project_role`)로 admin 여부를 **먼저** 확정한 뒤, 그 결과를 bool
        # 리터럴로 아래 `select(predicate)` 메인 조회에 바인딩했다 — `backlinks.py`가 5회차
        # 이전까지 갖고 있던 것과 동형인 "pre-resolve → 메인 statement 리터럴 바인딩" TOCTOU
        # 클래스(그 SELECT와 이 메인 조회 사이에 org role/project grant가 revoke되면 메인
        # 조회는 그 revoke를 못 본다). `backlinks.py`가 6회차에서 이 atom을
        # `org_admin_valid_correlated`/`project_admin_valid_correlated`(project_auth.py)로
        # 전환한 것과 정확히 같은 SSOT 함수를, 이 단건 소비자도 그대로 재사용한다(재구현 0) —
        # human/agent 판별(`is_api_key`)만 여기서 하고, 어느 correlated 표현식을 쓸지 결정한
        # 뒤 그 표현식 자체는 아래 `select(predicate)` 실행 시점까지 평가를 미룬다(pre-resolve
        # 없음). `_effective_org_role`은 이 함수 밖의 다른 소비자(`list_conversations`의
        # `include_agent_conversations` 게이트, `get_conversation`의 participant-bypass 여부
        # 판단)에서 여전히 쓰이므로 그대로 유지 — 이 함수만 소싱 방식을 바꾼다.
        from sqlalchemy import literal

        from app.services.project_auth import (
            has_project_access,
            org_admin_valid_correlated,
            project_admin_valid_correlated,
        )

        is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))

        admin_bypass_eligible = (
            project_admin_valid_correlated(
                literal(conv_project_id), caller_id=sender.id, org_id=org_id,
            )
            if is_api_key
            else org_admin_valid_correlated(caller_id=uuid.UUID(auth.user_id), org_id=org_id)
        )

        # project_access_valid(B1 grant-loss recheck — "참가 당시"가 아니라 "지금" 접근 가능한가):
        # `has_project_access`(project_auth.py SSOT)를 boolean으로 직접 호출한다(재구현 아님).
        #
        # §5회차(산티아고 Blocker 2): 예전엔 API-key(에이전트) caller에게 `project_access_valid`를
        # `True`로 하드코딩하고 재검증을 생략했다("기존 `_resolve_member`의 is_api_key 분기가
        # project_id 무관하게 TeamMember.id 매치만 확인했다"는 이유로 그 동작을 "보존"한 것 — 그러나
        # 산티아고 지적대로 이 "보존된" 동작 자체가 버그였다: grant가 회수된 에이전트도 여기선 계속
        # `project_access_valid=True`를 받아, 같은 caller/project 쌍에 대해 `backlinks.py`(항상 live
        # grant set을 correlate)와 이 함수(항상 True)가 서로 다른 답을 내는 "사실 하나·구현 둘" 드리프트가
        # 있었다. `has_project_access`의 4-branch WHERE는 이미 caller type별로 내부 분기한다
        # (`tm.type='human'` team_member 분기 vs `m.type='agent'` project_access grant 분기) —
        # human/agent 무관하게 그냥 호출하면 두 caller 모두 정확한 답을 받는다(Python 레벨
        # is_api_key 분기 자체가 불필요 — 재구현 0, project_auth.py가 이미 caller-type-aware SSOT).
        #
        # 이 atom(`project_access_valid`)은 §6회차 스코프 밖 — 여전히 요청당 1회 사전 SELECT로
        # 소싱한다(reviewer round-5 verdict가 `admin_bypass_eligible` 하나만 잔여로 지목했다).
        project_access_valid = await has_project_access(
            db, uuid.UUID(auth.user_id), conv_project_id, org_id,
        )

        from app.services.conversation_auth import conversation_readable_predicate

        predicate = conversation_readable_predicate(
            literal(conversation_id),
            caller_member_id=sender.id,
            project_access_valid=project_access_valid,
            # §6회차 fix: 위에서 조립한 correlated EXISTS — `_effective_org_role`의 사전
            # 해소 bool이 아니라, 이 `select(predicate)` 실행 시점의 스냅샷으로 평가된다.
            admin_bypass_eligible=admin_bypass_eligible,
        )
        result = (await db.execute(select(predicate))).scalar_one()
        return bool(result)
    except HTTPException:
        return False


async def _authorize_message_read(
    conversation_id: uuid.UUID,
    db: AsyncSession,
    auth: AuthContext,
    org_id: uuid.UUID,
) -> uuid.UUID:
    """메시지 조회(목록/단건/리플) 공용 인가. #1262: admin-bypass=agent-only 대화 한정 —
    휴먼 참가 대화(=private)는 participant only. 반환: conversation.project_id.

    story #1994 리팩터: 실제 판정 로직은 `_can_read_conversation`(canonical bool 술어)에 있다 —
    이 함수는 그 위에 404(대화 없음)/403(비참여자) raise semantics만 얹는 얇은 wrapper.
    """
    conv_project_id = (await db.execute(
        select(Conversation.project_id).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv_project_id is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not await _can_read_conversation(conversation_id, db, auth, org_id, _conv_project_id=conv_project_id):
        raise HTTPException(status_code=403, detail="Not a participant")
    return conv_project_id


@router.get("/{conversation_id}/messages")
async def list_messages(
    conversation_id: uuid.UUID,
    limit: int = Query(default=30, le=200),
    before: str | None = Query(default=None),
    thread_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations/{id}/messages — cursor 기반 페이지네이션.

    thread_id 미지정: top-level 메시지만 반환 (thread_id IS NULL).
    thread_id 지정: 해당 thread의 reply 목록 반환.

    story #2428: cursor가 `created_at` 단독이라 동률 시 페이지 경계에서 메시지가 누락/중복될
    수 있었다(docs.py·backlinks.py가 각자 발견해 고친 것과 동형 결함 — #2231이 이 함수를
    "참조 구현"으로 지목했는데 정작 이 결함을 안고 있었다). (created_at, id) 복합 cursor로
    이관 — 순수 리팩터 아님, 기존 cursor 무효화.
    """
    await _authorize_message_read(conversation_id, db, auth, org_id)

    if thread_id is None:
        thread_filter = ConversationMessage.thread_id.is_(None)
    else:
        thread_filter = ConversationMessage.thread_id == thread_id

    stmt = (
        select(ConversationMessage)
        .where(ConversationMessage.conversation_id == conversation_id, thread_filter)
        .order_by(ConversationMessage.created_at.desc(), ConversationMessage.id.desc())
        .limit(limit + 1)
    )
    if before:
        before_dt, before_id = decode_cursor(before)
        stmt = stmt.where(tuple_(ConversationMessage.created_at, ConversationMessage.id) < tuple_(before_dt, before_id))

    rows = (await db.execute(stmt)).scalars().all()
    page, has_more, next_cursor = assemble_page(rows, limit, lambda m: (m.created_at, m.id))
    # 화면 표시는 오래된→최신 순(자연스러운 대화 순서) — cursor 경계 계산은 desc 원본
    # `page`(assemble_page가 그 순서로 계산)에서 이미 끝났으니 여기서 reverse해도 안전.
    msgs = list(reversed(page))

    sender_ids = {m.sender_id for m in msgs if m.sender_id}
    member_map = await lookup_members_by_ids(sender_ids, db)
    # story #2263 AC6(오르테가 판정 2026-07-29): 페이지 전체를 쿼리 1회로 해소(N+1 방지) —
    # 메시지별 왕복 없음.
    from app.services.mention_parser import fetch_stored_references
    refs_by_msg = await fetch_stored_references(
        db, org_id=org_id, source_type="chat_message", source_ids=[m.id for m in msgs],
    )
    blocked_sender_ids = await _viewer_blocked_sender_ids(auth, org_id, db)

    data = [
        _msg_payload(
            m, member_map.get(m.sender_id), references=refs_by_msg.get(m.id, []),
            blocked_sender_ids=blocked_sender_ids,
        )
        for m in msgs
    ]

    return {"data": data, "meta": {"next_cursor": next_cursor, "has_more": has_more}}


@router.get("/{conversation_id}/messages/{message_id}")
async def get_message(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations/{id}/messages/{message_id} — 단건 원문 조회(최상위+리플 공용).

    story 3cf50d90: 게이트/QA 리플이 웹훅 payload 잘림으로 도달하면 원문 재조회 경로가 없어
    "잘렸다·재발신" 왕복이 반복됐다. 인가는 list_messages와 동형(참여자 전용·admin-bypass는
    agent-only 대화 한정).
    """
    await _authorize_message_read(conversation_id, db, auth, org_id)

    msg = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.id == message_id,
            ConversationMessage.conversation_id == conversation_id,
        )
    )).scalar_one_or_none()
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not found")

    sender_map = await lookup_members_by_ids({msg.sender_id} if msg.sender_id else set(), db)
    from app.services.mention_parser import fetch_stored_references
    refs_by_msg = await fetch_stored_references(
        db, org_id=org_id, source_type="chat_message", source_ids=[msg.id],
    )
    blocked_sender_ids = await _viewer_blocked_sender_ids(auth, org_id, db)
    return _msg_payload(
        msg, sender_map.get(msg.sender_id), references=refs_by_msg.get(msg.id, []),
        blocked_sender_ids=blocked_sender_ids,
    )


@router.delete("/{conversation_id}/messages/{message_id}", status_code=200)
async def delete_message(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """DELETE /api/v2/conversations/{id}/messages/{message_id} — story #2319.

    PO 결정(2026-07-29 04:41Z): tombstone, hard delete 아님. 행은 남고 content만 실제로
    지운다(ConversationMessage.deleted_at — SoftDeleteMixin, 모델 docstring 참조: Doc/Story와
    달리 목록에서 안 걸러낸다).

    ⛔카디르 QA(2026-08-02, PR #2806 CI): 최초 구현은 인가를 이 함수 안에서 손으로
    짰다(`_resolve_member` + sender_id 대조) — 지금 당장 「제3자가 남의 메시지를 못 지우는가」
    답이 예여도, 이 저장소가 이 정확한 도메인(메시지 인가)에서 과거에 실제 결함(story #1994
    B1, 산티아고 sabotage-probe)을 겪고 세운 canonical 경로(`_authorize_message_read`)를
    우회했다는 사실 자체가 문제다 — "지금 안전한가"와 "세운 규율을 지켰는가"는 다른 질문이고,
    이걸 그냥 두면 다음 사람이 또 우회한다. read-canonical을 재사용하고 그 위에 sender
    소유권만 얹는다("읽을 수 있는 사람 중 자기 것만"이 삭제 인가의 자연스러운 형태) — 삭제가
    읽기보다 더 좁아야 할 이유가 없다(삭제 대상은 이미 sender_id로 추가 제한된다).

    ⭐부수효과(카디르가 짚은 미답 질문 해소): participant에서 제거된 뒤에는 예전에 보낸
    메시지도 못 지운다 — `_authorize_message_read`가 먼저 403을 raise한다(read-gate와
    동일 fail-closed). 의도적 결정이다: 못 읽는 대화의 메시지를 지울 수 있으면 그게 더
    이상하다.
    """
    conv_project_id = await _authorize_message_read(conversation_id, db, auth, org_id)
    member = await _resolve_member(auth, org_id, db, project_id=conv_project_id)

    msg = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.id == message_id,
            ConversationMessage.conversation_id == conversation_id,
        )
    )).scalar_one_or_none()
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not found")

    if msg.sender_id != member.id:
        raise HTTPException(status_code=403, detail="Not the message owner")

    # ⛔AC7 블라인드스팟(의도적 범위 밖, 선언) — 이 삭제는 다른 참가자의 이미 열려 있는 화면에
    # 실시간(SSE) 반영되지 않는다. send_message의 실시간 fan-out(_dispatch_conversation_event)은
    # Event insert·recipient_seq·webhook-dedup까지 얽힌 별도 배선이라, 이 스토리 하나로 같이
    # 만들면 그 정합성까지 새로 떠안는다 — 여기서는 안 한다. 새로고침/재조회 시에는 정확히
    # 반영된다(AC5 ①의 실측 기준). 실시간 전파가 필요해지면 별도 스토리로 뗀다.
    if msg.deleted_at is None:
        msg.deleted_at = datetime.now(timezone.utc)
        msg.content = ""  # ③ 오발송 스크럽 — 플레이스홀더 문구는 FE가 deleted_at 보고 렌더(i18n).
        await db.flush()
        await db.commit()

    return {"id": str(msg.id), "deleted_at": msg.deleted_at.isoformat() if msg.deleted_at else None}


@router.get("/{conversation_id}/messages/{message_id}/replies")
async def list_message_replies(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    limit: int = Query(default=30, le=200),
    before: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations/{id}/messages/{message_id}/replies — 이 메시지의 리플 목록.

    story 3cf50d90: list_messages의 `?thread_id=` 파라미터와 동형 필터(discoverability용 전용
    서브리소스 — 호출자가 thread_id 쿼리파라미터의 존재를 몰라도 원문 리플 왕복이 가능하도록).

    story #2428: list_messages와 동형 결함(단독 created_at cursor, 동률 시 페이지 경계
    누락/중복) — (created_at, id) 복합 cursor로 이관. 순수 리팩터 아님, 기존 cursor 무효화.
    """
    await _authorize_message_read(conversation_id, db, auth, org_id)

    stmt = (
        select(ConversationMessage)
        .where(
            ConversationMessage.conversation_id == conversation_id,
            ConversationMessage.thread_id == message_id,
        )
        .order_by(ConversationMessage.created_at.desc(), ConversationMessage.id.desc())
        .limit(limit + 1)
    )
    if before:
        before_dt, before_id = decode_cursor(before)
        stmt = stmt.where(tuple_(ConversationMessage.created_at, ConversationMessage.id) < tuple_(before_dt, before_id))

    rows = (await db.execute(stmt)).scalars().all()
    page, has_more, next_cursor = assemble_page(rows, limit, lambda m: (m.created_at, m.id))
    msgs = list(reversed(page))

    sender_ids = {m.sender_id for m in msgs if m.sender_id}
    member_map = await lookup_members_by_ids(sender_ids, db)
    # story #2263 AC6: list_messages와 동형 — 페이지 전체 쿼리 1회(N+1 방지).
    from app.services.mention_parser import fetch_stored_references
    refs_by_msg = await fetch_stored_references(
        db, org_id=org_id, source_type="chat_message", source_ids=[m.id for m in msgs],
    )
    blocked_sender_ids = await _viewer_blocked_sender_ids(auth, org_id, db)

    data = [
        _msg_payload(
            m, member_map.get(m.sender_id), references=refs_by_msg.get(m.id, []),
            blocked_sender_ids=blocked_sender_ids,
        )
        for m in msgs
    ]

    return {"data": data, "meta": {"next_cursor": next_cursor, "has_more": has_more}}


@router.get("/{conversation_id}/working")
async def list_working_members(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """1aeecdde P2: GET /api/v2/conversations/{id}/working — 지금 답장 생성 중인 member 목록.

    presence(online) 와 **별도 축**(working/typing). FE 는 이 결과로 "...is typing"/working dot 을
    online dot 과 분리 표시(AC2). ephemeral·TTL 기반(미reply 시 자동 소멸). participant 만 조회 가능.
    응답: {"data": [{"member_id", "state", "updated_at"}]}.
    """
    conv_project_id = (await db.execute(
        select(Conversation.project_id).where(
            Conversation.id == conversation_id, Conversation.org_id == org_id
        )
    )).scalar_one_or_none()
    if conv_project_id is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv_project_id)
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    # 본인은 제외 — 내가 typing 중인 건 내 UI에 안 띄움(memo presence.py 동형).
    items = [
        e for e in await chat_presence.list_working(str(conversation_id))
        if e["member_id"] != str(sender.id)
    ]
    return {"data": items}


@router.patch("/{conversation_id}/mute")
async def set_conversation_mute(
    conversation_id: uuid.UUID,
    body: MuteRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """PATCH /api/v2/conversations/{id}/mute — per-대화 알림 mute/unmute (270c87e6).

    caller의 participant 행에 muted_at set(mute)/null(unmute). 참여자 지위·가시성·메시지 수신은
    불변 — 알림 노출만 억제(mute가 발화 carve-out보다 우선). 비참여자는 403.
    """
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)
    participant = (await db.execute(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    participant.muted_at = datetime.now(timezone.utc) if body.muted else None
    await db.commit()
    return {"conversation_id": str(conversation_id), "muted": body.muted}


@router.post("/{conversation_id}/read")
async def mark_conversation_read(
    conversation_id: uuid.UUID,
    body: MarkReadRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/conversations/{id}/read — read state 서버 truth 갱신(멱등·GREATEST 래칫).

    story #1976(E-CHAT-REALTIME 트랙A, doc chat-realtime-track-a-read-state-design §3):
    up_to 지정 시 그 시각으로 SET(FE가 실 렌더된 마지막 메시지 timestamp 전달 — 권장 경로,
    §4-3 레이스 방지). up_to 생략 시 서버 now() 사용 — "전체 읽음"(mark-all-read) 명시 액션
    전용 의도(§3-2/§3-4). GREATEST(last_read_at, up_to) 원자 UPDATE로 역행 방지(여러 번
    호출해도 안전 — 오래된 up_to가 늦게 도착해도 무해). 비참여자는 403(읽음 상태는 본인 것만
    의미 있음 — admin-bypass 없음).
    """
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)
    up_to = body.up_to or datetime.now(timezone.utc)

    result = await db.execute(_mark_read_update_stmt(conversation_id, sender.id, up_to))
    new_last_read_at = result.scalar_one_or_none()
    if new_last_read_at is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    # story #2686(축D): 채팅 read → 그 대화 소속 event-notification(벨/인박스) read_at 동기.
    # SAVEPOINT 격리(feedback_savepoint_failopen_session_poison 동형) — 이 동기 실패가
    # read-state 갱신(위 UPDATE) 자체를 막으면 안 된다. up_to=new_last_read_at(GREATEST
    # 래칫 후 값)로 넘겨 미래 메시지 알림까지 앞당겨 읽는 과잉살상을 막는다.
    try:
        async with db.begin_nested():
            from app.routers.event_notifications import sync_notification_read_on_chat_read
            await sync_notification_read_on_chat_read(
                db, org_id, conversation_id, sender.id, new_last_read_at,
            )
    except Exception:
        logger.warning(
            "채팅 read → notification read_at 동기 실패 conversation=%s member=%s",
            conversation_id, sender.id, exc_info=True,
        )

    await db.commit()

    # 재계산(가정 아님 — up_to가 최신 메시지보다 과거인 엣지케이스에서 0이 아닐 수 있음, §3-3).
    unread_count = (await db.execute(
        _unread_count_stmt(conversation_id, sender.id, new_last_read_at)
    )).scalar_one()

    sse_payload = {
        "event_type": "conversation.read",
        "conversation_id": str(conversation_id),
        "member_id": str(sender.id),
        "last_read_at": new_last_read_at.isoformat(),
        "unread_count": unread_count,
    }
    # 본인의 타 커넥션에만 전파(read-receipt=상대방 노출은 스코프 아웃, §5-1 PO 확定).
    # _push_to_agent가 member_id의 모든 열린 탭/기기 큐에 자동 팬아웃(trust_pipeline.py 선례
    # 동형 패턴, §1-3/§5-2) — Event DB row 미생성(순수 transient push, org 브로드캐스트 아님).
    _push_to_agent(str(sender.id), sse_payload)

    return {
        "conversation_id": str(conversation_id),
        "member_id": str(sender.id),
        "last_read_at": new_last_read_at.isoformat(),
        "unread_count": unread_count,
    }


@router.post("/{conversation_id}/circuit-breaker/release")
async def release_circuit_breaker_endpoint(
    conversation_id: uuid.UUID,
    body: CircuitBreakerReleaseRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/conversations/{id}/circuit-breaker/release — story #2630 수동 해제.

    무감독 연쇄 알림(conversation.circuit_breaker_opened)의 «차단 해제» 액션이 이 엔드포인트를
    친다. **human org owner/admin 전용**(gates.py transition_gate_endpoint의 93fc7aeb 선례와
    동형 이유 — 서킷 open 대화는 정의상 human-less라 참가자 기반 authz가 성립 안 하고, 무엇보다
    "agent가 자기 서킷을 스스로 풀 수 있으면 안전망 자체가 무의미"하다). `is_org_owner_or_admin`
    은 human 전용을 명시 강제(agent auth는 애초에 매치 불가 — 함수 자체 불변식).

    멱등: 이미 닫혀 있으면(중복 클릭·레이스) 200 + released=false로 응답, 에러 아님.
    """
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if not await is_org_owner_or_admin(db, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(
            status_code=403,
            detail="서킷브레이커 해제는 org owner/admin만 가능합니다.",
        )

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)

    from app.services.chain_escalation import release_circuit_breaker

    released = await release_circuit_breaker(
        db, conversation_id=conversation_id, released_by=sender.id, reason=body.reason,
    )
    await db.commit()
    return {"conversation_id": str(conversation_id), "released": released}


@router.post("/{conversation_id}/participants", status_code=201)
async def add_participant(
    conversation_id: uuid.UUID,
    body: AddParticipantRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/conversations/{id}/participants — 참여자 추가."""
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)

    # 요청자 참여 여부 확인
    is_participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if is_participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    # 추가 대상 멤버가 같은 org인지 확인
    # E-MEMBER-SSOT Phase 0: grant-only 휴먼(org_member)도 참가자로 추가 허용
    target = await resolve_member_identity(body.member_id, org_id, db)
    if target is None:
        raise HTTPException(status_code=404, detail="Member not found")

    # E-MSG-POLICY S1: 참가자 추가도 동일 정책 게이트 (back-door 차단).
    # 기존 참가자 ∪ 신규 대상으로 각 에이전트 정책 재검증 (list 모드 비허용 휴먼 추가 시 403 등).
    _existing_ids = (await db.execute(
        select(ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id == conversation_id)
    )).scalars().all()
    await _enforce_agent_creator_policy(sender, list(set(_existing_ids) | {body.member_id}), db)

    # DM → 기존 DM 유지, 기존 참여자 + 신규 참여자로 그룹 conversation fork
    if conv.type == "dm":
        existing_member_ids = (await db.execute(
            select(ConversationParticipant.member_id)
            .where(ConversationParticipant.conversation_id == conversation_id)
        )).scalars().all()

        new_conv = Conversation(
            project_id=conv.project_id,
            org_id=org_id,
            type="group",
            created_by=sender.id,
        )
        db.add(new_conv)
        await db.flush()

        all_member_ids = set(existing_member_ids) | {body.member_id}
        for mid in all_member_ids:
            db.add(ConversationParticipant(conversation_id=new_conv.id, member_id=mid))

        await db.commit()
        await db.refresh(new_conv)
        return {
            "conversation_id": str(new_conv.id),
            "member_id": str(body.member_id),
            "name": target.name,
            "avatar_url": target.avatar_url,
            "forked": True,
        }

    # group → 기존 conversation에 직접 추가
    try:
        db.add(ConversationParticipant(conversation_id=conversation_id, member_id=body.member_id))
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Already a participant")

    return {
        "conversation_id": str(conversation_id),
        "member_id": str(body.member_id),
        "name": target.name,
        "avatar_url": target.avatar_url,
        "forked": False,
    }


@router.post("/{conversation_id}/messages", status_code=201)
async def send_message(
    conversation_id: uuid.UUID,
    body: SendMessageRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/conversations/{id}/messages — 전송 + SSE dispatch."""
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)

    # 참여자 검증
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        # 발화 403 해소(270c87e6): 프로젝트 접근권 휴먼이 그룹/스레드 대화에 발화하면 auto-join.
        # _resolve_member가 이미 project 접근을 검증했으므로 접근권은 성립. 단 타인 간 1:1 DM은
        # 예외(비공개 보호·여전히 403)이고, 에이전트 인가(allowlist·creator 동석)는 불변(403 유지).
        if sender.type == "human" and conv.type != "dm":
            db.add(ConversationParticipant(conversation_id=conversation_id, member_id=sender.id))
            await db.flush()
        else:
            raise HTTPException(status_code=403, detail="Not a participant")

    # story #2630: 서킷브레이커 발신 차단 — human-less 대화에서 폭주 에피소드가 열려 있으면
    # agent 발신을 여기서 막는다. 참가자 검증 다음(비참여자는 그 이유로 이미 403 — 참여자
    # 여부와 무관한 사실인 서킷 상태를 그보다 먼저 노출할 이유가 없다), 그 뒤의 실 side-effect
    # (working clear 등) 이전 — 막힌 시도가 부수 상태를 안 남기게. human 발신은 이 체크
    # 대상이 아니다(페드루 필수수정 2026-08-13): 서킷이 연 방에 사람이 들어와 개입하려는
    # 발화까지 막으면 안 된다 — 사람의 개입이 사태 수습의 정공 경로고, human 늦참여
    # 자동해제를 v1 밖으로 미룬 것과도 정합(사람이 말은 할 수 있으니 해제 버튼 누를 판단도
    # 대화 안에서 가능). breaker 행은 human-less 대화에서만 열리므로(open 호출부 조건) 이
    # 조회 결과가 있다는 것 자체가 "이 대화는 human-less"를 함의 — 별도 human 유무 쿼리 불요.
    if sender.type == "agent":
        from app.services.chain_escalation import get_open_circuit_breaker_id

        open_breaker_id = await get_open_circuit_breaker_id(db, conversation_id)
        if open_breaker_id is not None:
            raise HTTPException(
                status_code=423,
                detail={
                    "error": "circuit_breaker_open",
                    "message": "폭주 감지로 이 대화의 agent 발신이 일시 차단되었습니다 — "
                                "org owner/admin의 해제 또는 자동 해소를 기다려주세요.",
                    "conversation_id": str(conversation_id),
                    "circuit_breaker_id": str(open_breaker_id),
                },
            )

    # 1aeecdde P2: sender 가 이 conversation 에 메시지를 보냄 = 답장 생성 종료 → working clear.
    # fork 분기(아래) 전 **원본 conversation_id** 기준 — working 은 그 conversation 에 set 됐다.
    # 휴먼 sender 면 set 된 적 없어 no-op(무해). agent reply 면 즉시 "...typing" 해제.
    #
    # story #2791(P0) 정정(2026-08-19, 페드루 판정) — system publisher(서버 자동발행 전용
    # 합성 발신자, runtime_type='system-publisher')는 이 블록을 건너뛴다. 우회가 아니라
    # 의미 정정: presence·working은 "이 구성원이 지금 활동 중"이라는 신호인데, system
    # 발신자는 애초에 presence 개념이 성립하지 않는 존재라 그걸 org 전체에 쏘는 것 자체가
    # 원래 틀렸다. 사람이 실제로 타이핑할 때만 타던 이 경로의 암묵 전제가, 도메인 전이마다
    # 대량으로 트리거되는 자동발행에서 처음 드러났다(재QA 중 story #2791의
    # test_e_ui_daegbyeon_9ef0f914_sse_bridge_realdb.py cross-project 하드게이트가 이
    # org-wide presence 방출과 우연히 충돌해 발각).
    if getattr(sender, "runtime_type", None) != "system-publisher":
        await chat_presence.clear_working(str(conversation_id), str(sender.id))
        # R2(da9d1781): working clear → conversation.working + presence SSE 발행(폴링 대체·best-effort).
        from app.services.presence_events import emit_conversation_working, emit_presence
        await emit_conversation_working(org_id, conversation_id)
        await emit_presence(org_id)

    # cross-org 차단: mentioned_ids를 현재 org 소속 member로 일괄 필터링 (QA B1).
    # E-MEMBER-SSOT Phase 0: 저장·DM포크·group 멘션 발송 모든 경로에 org 필터를 한 번 적용.
    #   grant-only 휴먼(org_member) 멘션은 포함하고, cross-org UUID는 저장/발송 전에 제거.
    #   group conversation은 fork 분기가 없어 별도 필터가 누락돼 있던 것을 여기서 함께 막는.
    valid_mentioned_ids: list[uuid.UUID] = []
    if body.mentioned_ids:
        _org_member_ids = await filter_org_member_ids(set(body.mentioned_ids), org_id, db)
        # 원본 순서 보존 + 중복 제거
        _seen: set[uuid.UUID] = set()
        for mid in body.mentioned_ids:
            if mid in _org_member_ids and mid not in _seen:
                _seen.add(mid)
                valid_mentioned_ids.append(mid)

    # story #2646(2026-08-14, 은퇴): 본문 `@handle` 텍스트 파싱(story #2603 P0,
    # handle_mention_parser.py)을 여기서 mentioned_ids와 합집합하던 블록을 제거했다 —
    # dev 실측 0/1139(최근 @포함 메시지 3000건 스캔, 실 handle 매치 0건) vs 구조화
    # mentioned_ids 153건 실사용. 파서를 만든 원 사유(#2603: "MCP/API 발신엔 mentioned_ids
    # 필드가 없다")는 story #2618/#3043(같은 날 선착 랜드)이 MCP SendChatInput에
    # mentioned_ids를 배선하며 해소됐다 — 남는 존치 근거("handle을 노출하면 자유형식 LLM
    # 런타임이 자연 발화할 것")는 실측 뒷받침 0인 가정뿐이었다(PO 판정). 멘션 경로는 이제
    # 구조화 mentioned_ids 하나로 수렴한다. 재도입 필요 시 이 커밋을 되살리지 말고 독립
    # 조각으로 새로 설계할 것(PO 지시) — handle_mention_parser.py 전체·members.handle 채번
    # 호출부(agent_anchor_sync.py)도 같은 커밋에서 함께 제거됨.

    # story #2629(P0의 @handle 파서와 동형 철학, 2026-08-14): 본문의 맨 스토리 번호(`#24`류)를
    # entity 임베드 토큰으로 서버가 저장 시점에 승격 — 에이전트가 임베드 문법을 배우든 말든
    # 흡수한다. @handle(`@word`)과 어휘상 안 겹쳐 위 블록과의 순서는 무관. body.content
    # 재대입 지점은 이 함수 전체에서 여기 하나뿐이라(아래 ConversationMessage 생성이 유일한
    # 소비처) 다른 호출부 변경 없이 자동 전파된다.
    # story #2679: 반환이 (content, auto_story_ids)로 바뀌었다 — 아래 insert_chat_mentions
    # 호출에 auto_story_ids를 그대로 넘겨 entity_references.origin(explicit vs auto)을
    # 가른다(promoter가 여기서 심은 토큰과 caller가 직접 타이핑한 브라켓 토큰은 파싱만으론
    # 구분이 안 되므로 별도 채널로 전달).
    from app.services.mention_parser import extract_chat_entity_mentions
    from app.services.story_ref_promoter import promote_bare_story_refs

    # story #2702 — 같은 메시지에 같은 story의 bare #N 과 명시 브라켓 멘션이 둘 다 있으면,
    # 승격(promote) 후엔 파싱만으로 "그 story_id가 애초에 명시로도 타이핑돼 있었다"는 걸 더는
    # 못 가른다(브라켓 토큰 모양이 같아져서). 그래서 승격 *전* 원문에서 명시 멘션을 먼저 뽑아
    # 두고, 그 id들을 auto_story_ids에서 빼 둔다 — insert_chat_mentions의 origin 판정
    # (`"auto" if eid in auto_story_ids else "explicit"`)이 자연히 explicit을 고르게 된다.
    _explicit_story_ids_before_promotion = {
        eid for etype, eid in extract_chat_entity_mentions(body.content or "") if etype == "story"
    }
    body.content, _auto_story_ids = await promote_bare_story_refs(
        db, org_id=org_id, project_id=conv.project_id, content=body.content or "",
    )
    _auto_story_ids -= _explicit_story_ids_before_promotion

    # E-ACTIVATION S1(까디르 QA): audience 도 cross-org/삭제 id 차단 — mentioned_ids 와 동형 org 필터.
    # 안 하면 삭제·타조직 member_id 를 audience 에 넣어 «실 수신자 전원이 addressed=no» 메시지를 만들 수 있다.
    # 전량 필터돼 []가 되면 어댑터에서 `not audience`=True → all-addressed(현행)로 안전 degrade.
    if body.audience:
        _aud_ok = await filter_org_member_ids(set(body.audience), org_id, db)
        body.audience = [a for a in body.audience if a in _aud_ok]

    # CB-S2: DM + 비참여자 멘션 → 자동 그룹 conversation fork (AC1, AC2)
    fork_info: dict | None = None
    if conv.type == "dm" and valid_mentioned_ids:
        valid_member_ids = set(valid_mentioned_ids)

        current_participant_ids = set((await db.execute(
            select(ConversationParticipant.member_id)
            .where(ConversationParticipant.conversation_id == conversation_id)
        )).scalars().all())

        non_participants = [mid for mid in valid_member_ids if mid not in current_participant_ids]
        if non_participants:
            fork_conv_id = uuid.uuid4()
            fork_conv = Conversation(
                id=fork_conv_id,
                project_id=conv.project_id,
                org_id=org_id,
                type="group",
                created_by=sender.id,
            )
            db.add(fork_conv)
            await db.flush()

            all_participant_ids = current_participant_ids | valid_member_ids
            for mid in all_participant_ids:
                db.add(ConversationParticipant(conversation_id=fork_conv_id, member_id=mid))

            fork_info = {"forked_conversation_id": str(fork_conv_id)}
            # 메시지를 fork된 group conversation에 저장
            conversation_id = fork_conv_id
            conv = fork_conv

    # thread_id 유효성 검증 — 같은 conversation의 top-level message만 허용
    root_msg: ConversationMessage | None = None
    if body.thread_id is not None:
        root_msg = (await db.execute(
            select(ConversationMessage).where(
                ConversationMessage.id == body.thread_id,
                ConversationMessage.conversation_id == conversation_id,
            )
        )).scalar_one_or_none()
        if root_msg is None:
            raise HTTPException(status_code=400, detail="Thread root not found in this conversation")
        if root_msg.thread_id is not None:
            raise HTTPException(status_code=400, detail="Cannot reply to a reply (single-level thread only)")

    # S8: 서버사이드 capacity 게이트(ee seam·SaaS only·OSS no-op) — asset commit 前 per-file+총량 enforce.
    # 직접 API 우회 불가(commit-time gate). 초과 시 402 PLAN_LIMIT_EXCEEDED.
    if settings.is_ee_enabled and body.attachments:
        from ee.plan_limits import check_storage_capacity  # type: ignore[import]
        await check_storage_capacity(db, org_id, [a.model_dump() for a in body.attachments])

    # E-MCP-OPT S5(#2): MCP JSON 업로드 엔드포인트가 개별 업로드마다 파일당 2MiB만 검사하고
    # 선언 한도(5개/6MiB 합계)를 강제 안 해 다회 호출로 우회 가능했다 — 이 메시지가 실제로
    # 참조하는 mcp-origin 첨부 부분집합에 한해 여기서 재검증(전체 attachments 가 아님 — FE 업로드
    # 첨부는 기존 100MB/10개 한도만 적용받는다·회귀0).
    if body.attachments:
        mcp_origin = [a for a in body.attachments if _is_mcp_upload_object_path(a.url)]
        if len(mcp_origin) > _MCP_MAX_ATTACHMENTS or (
            sum(a.size for a in mcp_origin) > _MCP_MAX_TOTAL_ATTACHMENT_BYTES
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"mcp attachments exceed declared limit "
                    f"(max {_MCP_MAX_ATTACHMENTS} files / {_MCP_MAX_TOTAL_ATTACHMENT_BYTES} bytes total)"
                ),
            )

    # story #2055 AC1: 이미지 첨부 픽셀 크기를 서버가 측정해 채운다 — client 제공 width/height는
    # asset_id와 동일하게 위조 가능하므로 신뢰하지 않고 항상 서버 측정값으로 덮어쓴다(server
    # authority). 저장 전 in-place로 채워서 이후 model_dump() 호출(메시지 저장·asset registry
    # 동기화 둘 다)이 자동으로 값을 반영하게 한다. best-effort(측정 실패해도 전송을 막지 않음).
    if body.attachments:
        from app.services.image_dimensions import measure_image_dimensions
        for a in body.attachments:
            a.width, a.height = await measure_image_dimensions(a.content_type, a.url) or (None, None)

    msg = ConversationMessage(
        conversation_id=conversation_id,
        sender_id=sender.id,
        content=body.content,
        mentioned_ids=valid_mentioned_ids,
        thread_id=body.thread_id,
        # E-FILE S1: 첨부 메타(URL+name+content_type+size)를 0093 attachments JSONB에 저장.
        # S7: client 제공 asset_id 는 strip(서버 권위·drift 방지·까심)·아래 sync url_map 으로만 역기입.
        attachments=[{**a.model_dump(), "asset_id": None} for a in body.attachments],
        # E-ACTIVATION S1: typed-activation(audience/kind/expects_response) → metadata(additive·마이그레이션 불요).
        # story #2637 AC 0-a: event_context → metadata['event'](additive, 둘 다 독립 namespace).
        msg_metadata=_combined_msg_metadata(body),
    )
    db.add(msg)

    # reply인 경우 root message의 reply_count / last_reply_at 원자 업데이트
    if root_msg is not None:
        await db.execute(
            update(ConversationMessage)
            .where(ConversationMessage.id == body.thread_id)
            .values(
                reply_count=ConversationMessage.reply_count + 1,
                last_reply_at=datetime.now(timezone.utc),
            )
        )

    await db.flush()

    # story #1993(E-KNOWLEDGE-LINK S1): org 지식 연결 레이어 — mentions 정규화 테이블 write-path.
    # insert-only(메시지 불변 전제 — 재조정 불필요). 기존 mentioned_ids(멤버 알림) 파이프라인과
    # 완전 별개 병행 경로(비접촉). **같은 트랜잭션**(try/except 로 삼키지 않음) — 파싱/insert 실패 시
    # 예외가 그대로 propagate 되어 메시지 전송 전체가 롤백된다(AC4 원자성 — 아래 best-effort 블록들과
    # 의도적으로 다른 격리 수준).
    from app.services.mention_parser import insert_chat_mentions
    # story #2889(S2h③, 페드루 확定 2026-08-21): gate/pull_request/member는 TARGET_ONLY_TYPES
    # (완전지원 ENTITY_RESOLVERS 아님)라 insert_chat_mentions의 기본 target_types(=ENTITY_
    # RESOLVERS만)엔 안 잡힌다 — "존재판정+멘션 자동감지"까지가 이 세 타입의 계약(reference_
    # registry.py 참고)이라 여기서 명시로 넓힌다. chat_message는 안 넣는다(자기 자신을
    # @멘션하는 토큰은 의미가 없음 — proof form의 별도 경로로만 채팅 메시지를 인용한다).
    from app.services.reference_registry import ENTITY_RESOLVERS
    mention_result = await insert_chat_mentions(
        db, org_id=org_id, message_id=msg.id, content=msg.content, created_by=sender.id,
        auto_story_ids=frozenset(_auto_story_ids),
        target_types=frozenset(ENTITY_RESOLVERS) | {"gate", "pull_request", "member"},
    )

    # story #2889(S2h): #2263 AC6이 남긴 갭(SSE/POST 응답엔 읽기 경로의 references[] 키가
    # 없다 — 방금 보낸 메시지의 임베드가 즉시 리치로 안 뜬다)을 닫는다. 같은 트랜잭션·같은
    # 세션이라 위 insert_chat_mentions가 방금 쓴 행을 이 SELECT가 그대로 본다(SQLAlchemy
    # autoflush가 미flush 변경분도 이 쿼리 前에 flush한다 — 별도 flush 불요). 읽기 경로
    # (list_messages 등)와 정확히 같은 함수·같은 반환 shape 재사용(재구현 0).
    from app.services.mention_parser import fetch_stored_references
    msg_references = (
        await fetch_stored_references(db, org_id=org_id, source_type="chat_message", source_ids=[msg.id])
    ).get(msg.id, [])

    # E-STORAGE-SSOT S2: 첨부를 asset registry로 동기화(SAVE-time·같은 트랜잭션·orphan 0).
    # S7: 반환 url→asset_id 로 JSONB asset_id 역기입(denorm·catch#4: asset_links=SSOT·JSONB=denorm).
    if body.attachments:
        url_map = await sync_attachment_assets(
            db,
            org_id=org_id,
            project_id=conv.project_id,
            source_type="conversation_message",
            source_id=msg.id,
            attachments=[a.model_dump() for a in body.attachments],
            created_by=sender.id,
            # S7 AC1: 업로드 path 는 conversation_id 로 스코프(`.../chat/{conv_id}/`)·asset_link.source_id 는
            # msg.id 유지. path 검증만 conv_id 로(축 분리·영구 mismatch 해소). IDOR: conv 의 project/org 는
            # 이 핸들러가 이미 검증(conv.project_id·get_verified_org_id) + exact-prefix 그대로.
            path_scope_id=conversation_id,
        )
        if url_map:
            msg.attachments = [
                {**a, "asset_id": str(url_map[a["url"]])} if a.get("url") in url_map else a
                for a in (msg.attachments or [])
            ]
            await db.flush()

    # AC10: Discord 수신자 파악 → SSE dispatch에서 제외 (동일 db 세션, flush 완료 상태)
    # ⛔P0(message-loss, 2026-08-08 diagnosed): 이 블록이 SAVEPOINT 없이 bare except였을 때는
    # 실패 시 Postgres 트랜잭션이 ABORTED로 남고, 그 뒤 최종 commit()이 예외 없이 조용히
    # ROLLBACK 처리되어(asyncpg 실측 확認) msg insert까지 통째로 사라졌다 — "성공 id 반환하는데
    # 저장 안 됨" 증상의 근본. `_dispatch_conversation_event` 호출부와 동형으로 begin_nested()
    # SAVEPOINT 격리 — 여기서 실패해도 이 nested만 롤백되고 바깥 트랜잭션(msg insert)은 안전.
    # story #2603 P0(delivery-contract-blueprint-v0-1) ①: SSE 코어가 ChannelRouter의
    # DeliveryDecision을 소비한다 — 예전엔 이 decisions가 discord 채널 판정에만 쓰이고
    # `_dispatch_conversation_event`(실제 turn 트리거) 자체는 mute/mentions를 전혀 안 봤다
    # (지도 ②③). preference_excluded_ids = 참가자였지만 route_message가 mute/mentions로
    # 걸러 decisions에 없는 대상 — 이제 이들은 discord 판정과 같은 자리에서 SSE Event
    # 생성 자체가 제외된다(막는 쪽과 하는 쪽이 같은 판정을 본다).
    # story #2620: decisions는 discord_exclude_ids·preference_excluded_ids뿐 아니라 아래
    # webhook_authorized_ids(resolve_conversation_webhook_targets)까지 먹이는 단일 snapshot이라
    # try 실패 시에도(디폴트 []) 참조 가능하게 try 밖에서 미리 초기화한다.
    decisions: list = []
    discord_exclude_ids: set[uuid.UUID] = set()
    preference_excluded_ids: set[uuid.UUID] = set()
    try:
        async with db.begin_nested():
            from app.services.channel_router import ChannelRouterError, route_message as _route
            decisions = await _route(msg.id, db)
            discord_exclude_ids = {d.member_id for d in decisions if d.channel == "discord"}
            decided_ids = {d.member_id for d in decisions}
            _participant_rows = (await db.execute(
                select(ConversationParticipant.member_id).where(
                    ConversationParticipant.conversation_id == conversation_id,
                )
            )).scalars().all()
            preference_excluded_ids = {
                pid for pid in _participant_rows if pid != sender.id and pid not in decided_ids
            }
    except Exception:
        logger.warning("ChannelRouter pre-check failed message_id=%s — no SSE exclusion", msg.id)

    # E-CHAT-CMD S4: capability gate — 슬래시 커맨드를 미지원 런타임 에이전트에 주입 차단(+audit+hint).
    # 비-command 면 빈 결과 → 무영향. 차단 대상은 dispatch exclude 로 합쳐 주입 0.
    blocked_agent_ids, command_hints = await _command_capability_gate(db, conv, msg, sender, org_id)

    # story #2349 AC3 — 「이 발신자를 차단한 수신자」는 대화 메시지 SSE/멘션/알림에서 감산한다.
    # PO 경계(2026-08-02): 이건 conversations.py::send_message(대화)만이다 — 스토리 멘션(업무)은
    # 별도 경로라 안 건드린다. blocked_agent_ids(위, capability gate)와는 개념이 달라 이름을
    # 안 겹친다(이름이 겹쳐 합칠 뻔한 논의가 있었다 — 결론: 못 합침, PO 판정 참조).
    # 이 조회 하나가 실패했다고 메시지 전송 자체가 막히면 안 된다 — 아래 채널라우터 pre-check·
    # 웹훅 타겟·멘션/알림 dispatch가 전부 같은 철학(best-effort, try/except+warning)이라 이
    # 조회도 그 옆에 맞춘다(실패 시 fail-open=차단 미반영, 메시지 전송은 계속).
    # P0 message-loss savepoint 격리(위 discord_exclude_ids 블록과 동일 근거) — 이 SELECT 자체는
    # 저위험이나 실패 시 트랜잭션을 poison하지 않도록 통일.
    user_blocker_ids: set[uuid.UUID] = set()
    try:
        async with db.begin_nested():
            user_blocker_ids = set((await db.execute(
                select(UserBlock.blocker_member_id).where(UserBlock.blocked_member_id == sender.id)
            )).scalars().all())
    except Exception:
        logger.warning("user_blocker_ids lookup failed message_id=%s — fail-open(no exclusion)", msg.id, exc_info=True)

    # E-EVENT-1CONFIG + story #2620(P3, DeliveryDecision 단일화): webhook 전달 대상을 요청
    # 트랜잭션서 1회 산출(SSOT) — SSE-skip 결정과 실제 webhook delivery 가 **같은 snapshot**을
    # 쓰게 해 TOCTOU silent loss 를 차단한다(산티아고 Finding 1). 산출된 target 을 그대로
    # delivery task 로 넘기고(post-commit requery 0), 그로부터 도출한 covered member 집합을
    # SSE-skip 에 쓴다. #2620부터는 authorized_member_ids 자체가 route_message()의 decisions
    # (위, discord_exclude_ids/preference_excluded_ids와 같은 호출)에서 유도돼, webhook이 더
    # 이상 자체 mentioned_ids 판정을 하지 않는다 — SSE·discord·webhook 셋 다 같은 판정 원천.
    from app.services.conversation_webhook import resolve_conversation_webhook_targets
    webhook_targets: list = []
    webhook_authorized_ids = {d.member_id for d in decisions} - {sender.id}
    if conv.project_id and webhook_authorized_ids:
        try:
            # P0 message-loss savepoint 격리 — 위 blocks와 동일 근거.
            async with db.begin_nested():
                webhook_targets = await resolve_conversation_webhook_targets(
                    db,
                    org_id=org_id,
                    project_id=conv.project_id,
                    sender_id=sender.id,
                    authorized_member_ids=webhook_authorized_ids,
                )
        except Exception:
            logger.warning(
                "webhook target resolve failed conversation_id=%s — SSE 유지(skip 0·fail-open)",
                conversation_id, exc_info=True,
            )
    webhook_covered_ids = {t.member_id for t in webhook_targets if t.member_id is not None}

    pending_sse_pushes: list[tuple[str, dict]] = []
    try:
        async with db.begin_nested():
            pending_sse_pushes += await _dispatch_conversation_event(
                db, conv, msg, org_id, sender,
                exclude_ids=discord_exclude_ids | blocked_agent_ids | user_blocker_ids | preference_excluded_ids,
                webhook_covered_ids=webhook_covered_ids,
                references=msg_references,
            )
    except Exception as _dispatch_err:
        # dispatch 실패를 삼키지 않고 surface — 게이트웨이 이벤트 미생성 무음 방지
        logger.error("conversation event dispatch failed conversation_id=%s", conversation_id, exc_info=True)
        raise HTTPException(status_code=500, detail="event dispatch failed") from _dispatch_err

    # story #2608 P1 AC1 + #2617: agent가 보낸 메시지면 연쇄 깊이를 잰다(chain_depth.py 판정
    # 로직 SSOT — route_message() 안의 게이트와 같은 함수 재사용, 중복 구현 없음). 호출
    # 위치만 recipient-필터(route_message)·이벤트-발생(여기, 메시지당 1회)으로 갈린다.
    if sender.type == "agent":
        from app.services.chain_depth import compute_agent_chain_depth
        from app.services.channel_router import _AGENT_CHAIN_DEPTH_CAP

        chain_depth = await compute_agent_chain_depth(
            db, conversation_id, max_scan=_AGENT_CHAIN_DEPTH_CAP,
        )
        if chain_depth > _AGENT_CHAIN_DEPTH_CAP:
            # story #2608 P1 AC1: A↔B 상호멘션류(멘션 자체는 항상 유효해 route_message의
            # mentions 체크로는 절대 안 끊김)를 잡는다 — agent를 명시 멘션했는데(=turn이
            # 시도됐을 대상이 실재) 연쇄가 cap을 넘었으면, "침묵"이 아니라 human 참가자에게
            # human_intervention_requested 이벤트로 알린다(블루프린트 §3). 「멘션됐는데
            # agent가 없다」(전부 human 멘션)면 turn 자체가 애초에 대상 없어 no-op.
            if msg.mentioned_ids:
                _mentioned_agent_rows = (await db.execute(
                    select(TeamMember.id).where(
                        TeamMember.id.in_(msg.mentioned_ids), TeamMember.type == "agent",
                    )
                )).scalars().all()
                chain_expired_agent_targets = set(_mentioned_agent_rows)
                if chain_expired_agent_targets:
                    try:
                        async with db.begin_nested():
                            pending_sse_pushes += await _dispatch_human_intervention_event(
                                db, conv, msg, org_id, sender,
                                chain_expired_agent_targets, _AGENT_CHAIN_DEPTH_CAP,
                                references=msg_references,
                            )
                    except Exception:
                        logger.warning(
                            "human_intervention_requested dispatch failed conversation_id=%s",
                            conversation_id, exc_info=True,
                        )

        # story #2626(재설계, 2026-08-13 PO 승인): 무감독 연쇄 «알림»은 depth-cap(#2608,
        # 위 블록·상시 상태)과 완전히 분리된 별도 트리거 — 속도 기반 이상 에피소드 감지로
        # 교체했다(원 게이트 조건 depth > cap이 human-less 대화에서 영구 참이라 dedup만으론
        # 소음을 못 없앴다, #3016 진단). 그래서 이 블록은 depth-cap 조건 밖으로 뺐다 — human-
        # less 대화의 매 agent 메시지마다 속도를 평가한다(chain_escalation.py 내부에서 org
        # 설정·임계·에피소드 마커·플래핑 쿨다운까지 전부 판단, 여기는 호출만).
        from app.services.channel_router import _conversation_has_human
        if not await _conversation_has_human(db, conversation_id):
            try:
                async with db.begin_nested():
                    from app.services.chain_escalation import evaluate_unsupervised_chain_episode
                    await evaluate_unsupervised_chain_episode(
                        db, org_id=org_id, conversation_id=conversation_id,
                        project_id=conv.project_id,
                    )
            except Exception:
                logger.warning(
                    "unsupervised chain escalation dispatch failed conversation_id=%s",
                    conversation_id, exc_info=True,
                )

    # AC1: 멘션 대상에게 conversation:mention SSE 발송 (participant 여부 무관)
    #
    # story #2127(2026-07-22, 까심군 #2090 QA 후속): "participant 여부 무관"은 group
    # conversation 기준이다 — DM은 위 CB-S2 fork 분기(conversation_id/conv가 이미 재대입돼
    # 있음)가 비참여자 멘션을 그룹으로 자동승격 + 참가자 편입시키므로, 이 지점에 도달할 때는
    # DM에서 온 멘션 대상도 이미 참가자다(git log -S "CB-S2: DM" 확認, [CB-S2] PR#747, 의도된
    # 기능·버그 아님). 즉 "진짜 비참가자에게 message_created 없이 mention만 감"이 실제로
    # 일어나는 건 group conversation에서 기존 비참가자를 멘션하는 경우뿐이다.
    if msg.mentioned_ids:
        mention_targets = set(msg.mentioned_ids) - {sender.id} - discord_exclude_ids - blocked_agent_ids - user_blocker_ids
        if mention_targets:
            try:
                async with db.begin_nested():
                    pending_sse_pushes += await _dispatch_mention_events(
                        db, conv, msg, org_id, sender, mention_targets,
                        webhook_covered_ids=webhook_covered_ids,
                        references=msg_references,
                    )
            except Exception:
                logger.warning("mention event dispatch failed conversation_id=%s", conversation_id, exc_info=True)

        # story 1934(선생님 앱 done-gate — 대상은 human만): 멘션 대상 human에게 in-app
        # Notification + Expo push. **agent는 명시 제외** — agent는 이미 _dispatch_mention_events
        # (위)로 SSE/Event 전달을 별도 경로로 받고 있어, 여기서 또 dispatch_notification을 태우면
        # 같은 메시지에 대해 Event가 이중 INSERT된다(event_type 다른 두 행 — 폴링 중복 수신).
        # best-effort.
        if mention_targets:
            try:
                # P0 message-loss savepoint 격리 — dispatch_notification 이 실제 write(outbox)를
                # 하는 유력 용의자 지점(위 blocks와 동일 근거).
                async with db.begin_nested():
                    human_mention_rows = (await db.execute(
                        select(TeamMember.id).where(
                            TeamMember.id.in_(mention_targets), TeamMember.type == "human",
                        )
                    )).all()
                    human_mention_targets = [r[0] for r in human_mention_rows]
                    if human_mention_targets:
                        from app.services.notification_dispatch import dispatch_notification
                        await dispatch_notification(
                            db, org_id=org_id, event_type="conversation.mention",
                            target_member_ids=human_mention_targets,
                            title=f"{sender.name}님이 회원님을 멘션했습니다",
                            body=(msg.content or "")[:200],
                            reference_type="conversation", reference_id=conversation_id,
                            source_project_id=conv.project_id,
                            # story #2460(§6 봉합②): 개인 webhook·Expo push 실배달을 요청 트랜잭션 밖으로.
                            via_outbox=True,
                        )
            except Exception:
                logger.warning(
                    "conversation.mention notification failed conversation_id=%s", conversation_id, exc_info=True,
                )

    # story 1934(선생님 명시 스코프 확장 — human만): 멘션 여부 무관 스레드 참여 human 전원에게
    # 새 메시지 in-app Notification + Expo push. agent는 제외(위와 동일 이유 — agent는
    # _dispatch_conversation_event로 이미 Event 전달받는 중, 여기서 또 태우면 이중 INSERT).
    # 이미 conversation.mention으로 알림 받은 대상은 제외(중복 push 방지 — 멘션이 더 구체적).
    # best-effort.
    try:
        # P0 message-loss savepoint 격리 — dispatch_notification 이 실제 write(outbox)를
        # 하는 유력 용의자 지점(위 blocks와 동일 근거). 이 블록이 4곳 중 처음엔 빠져 있었다 —
        # PR 셀프게이트 뮤테이션 체크(테스트 파일 참조) 중 발견해 즉시 보강.
        async with db.begin_nested():
            participant_rows = (await db.execute(
                select(ConversationParticipant.member_id)
                .where(ConversationParticipant.conversation_id == conversation_id)
            )).all()
            candidate_targets = (
                {r[0] for r in participant_rows}
                - {sender.id} - discord_exclude_ids - blocked_agent_ids - user_blocker_ids - set(msg.mentioned_ids or [])
            )
            if candidate_targets:
                human_message_rows = (await db.execute(
                    select(TeamMember.id).where(
                        TeamMember.id.in_(candidate_targets), TeamMember.type == "human",
                    )
                )).all()
                message_targets = [r[0] for r in human_message_rows]
                if message_targets:
                    from app.services.notification_dispatch import dispatch_notification
                    await dispatch_notification(
                        db, org_id=org_id, event_type="conversation.message",
                        target_member_ids=message_targets,
                        title=f"{sender.name}님의 새 메시지",
                        body=(msg.content or "")[:200],
                        reference_type="conversation", reference_id=conversation_id,
                        source_project_id=conv.project_id,
                        # story #2460(§6 봉합②): 개인 webhook·Expo push 실배달을 요청 트랜잭션 밖으로.
                        via_outbox=True,
                    )
    except Exception:
        logger.warning("conversation.message notification failed conversation_id=%s", conversation_id, exc_info=True)

    # conversation updated_at 갱신
    conv.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(msg)

    # Phase 6-1: human 발신 메시지 → process_event 훅
    # agent sender는 제외 — agent 응답이 다시 트리거해 무한 루프 생기는 것 방지
    if sender.type != "agent" and conv.project_id:
        try:
            from app.services.workflow_pipeline import process_event
            from app.services.rule_evaluator import EventContext as WorkflowEventContext
            await process_event(db, org_id, conv.project_id, WorkflowEventContext(
                event_type="message.created",
                trigger_type_slug="kickoff",
                actor_id=str(sender.id),
                metadata={
                    "conversation_id": str(conversation_id),
                    "message_id": str(msg.id),
                    "content_preview": (msg.content or "")[:200],
                    "project_id": str(conv.project_id),
                    "org_id": str(org_id),
                    "sender_type": sender.type,
                },
            ))
        except Exception:
            logger.warning("process_event failed for message.created message_id=%s", msg.id, exc_info=True)

    # commit 완료 후 SSE push — Event가 DB에 커밋된 상태에서 push해야 race condition 없음
    for pid_str, sse_payload in pending_sse_pushes:
        _push_to_agent(pid_str, sse_payload)
    # story #2090 정정(2026-07-22, 까심 발견 — 2026-07-21 PR #2375의 착오 정정) + #2132(2026-07-23
    # 근본수정): publish_event()의 org _subscribers fanout은 영구 죽은 레지스트리(story #2059/
    # #2067과 동일 근본)라 실제 SSE 전달 경로가 아니었다 — 그 함수 자체를 삭제했다. L1
    # activity_events 캡처는 이 함수 호출과 무관하게 위쪽 `Event(...)` DB row 생성(:474/:477,
    # event_type="conversation.message_created")으로 이미 이뤄지므로 무영향. 실 전달은 위
    # pending_sse_pushes push 루프(commit 후)가 담당한다: `_dispatch_conversation_event`가
    # conversation participant 전원에게, `_dispatch_mention_events`가 멘션 대상(참가자 여부
    # 무관) 전원에게 각각 event_type을 정확히 나눠(message_created vs conversation:mention)
    # push하므로 별도 함수로 다시 push할 필요가 없다 — PR #2375가 이 사실을 놓치고
    # `_push_conversation_message_created()`로 동일 pid에 conversation.message_created를
    # 중복 발송했고(참가자 기준 순수 중복), 게다가 pending_sse_pushes 전체를 pid 기준 dedup하면서
    # 멘션-only 비참가자에게도 message_created를 함께 보내 use-chat-unread-total.ts의 "SSE는 실
    # 참여자에게만 전달되므로 +1 정확" 전제를 깨는 phantom unread 증분 부작용까지 냈다(비참가자는
    # /api/conversations/unread-count 서버 truth엔 안 잡히므로 배지만 어긋남). 그 함수 자체를 삭제.

    # ws_chat WebSocket 브로드캐스트 — agent 참가자 room에 실시간 전달 (conv.type/title 무관)
    try:
        from app.routers.ws_chat import _broadcast, _rooms

        if _rooms:  # 활성 WS 연결 없으면 쿼리 스킵
            # ConversationParticipant 중 agent type 멤버 수집
            agent_result = await db.execute(
                select(TeamMember.id)
                .join(ConversationParticipant, ConversationParticipant.member_id == TeamMember.id)
                .where(
                    ConversationParticipant.conversation_id == conversation_id,
                    TeamMember.type == "agent",
                )
            )
            agent_ids: set[str] = {str(row[0]) for row in agent_result.all()}

            # ws-chat 전용 conv 호환 — created_by 포함 (participant 테이블에 없는 경우 대비)
            if conv.created_by:
                agent_ids.add(str(conv.created_by))

            # story #2349 AC3 — 카디르 QA 재발견(2026-08-03): 이 WS 브로드캐스트가 msg.content
            # 원문을 필터 없이 agent 참가자 room 전원에게 보내고 있었다 — user_blocker_ids
            # (위 L2049~2053, send_message 요청 트랜잭션서 이미 계산된 값) 미적용. #2814/#2817과
            # 같은 결로 여기서도 뺀다(새 쿼리 없음, caller의 값 재사용).
            agent_ids -= {str(bid) for bid in user_blocker_ids}

            if agent_ids:
                ws_payload = json.dumps({
                    "id": str(msg.id),
                    "conversation_id": str(conversation_id),
                    "sender_id": str(sender.id),
                    "sender_name": sender.name,
                    "content": msg.content,
                    "ts": msg.created_at.isoformat(),
                })
                for aid in agent_ids:
                    if aid in _rooms:
                        await _broadcast(aid, ws_payload)
    except Exception:
        logger.warning("ws_chat broadcast failed message_id=%s", msg.id, exc_info=True)

    # webhook delivery BackgroundTask (AC1~8) — E-EVENT-1CONFIG: targets 를 요청 트랜잭션서 산출한
    # webhook_targets 로 고정 전달(post-commit requery 0·SSE-skip 과 동일 snapshot·TOCTOU 차단).
    from app.services.conversation_webhook import deliver_conversation_message_webhook
    background_tasks.add_task(
        deliver_conversation_message_webhook,
        message_id=msg.id,
        conversation_id=conversation_id,
        org_id=org_id,
        project_id=conv.project_id,
        sender_id=sender.id,
        thread_id=msg.thread_id,
        created_at=msg.created_at,
        mentioned_ids=list(msg.mentioned_ids) if msg.mentioned_ids else None,
        content=msg.content,
        targets=webhook_targets,
    )

    # Discord 아웃바운드 (AC9~11)
    background_tasks.add_task(
        _dispatch_discord_outbound,
        message_id=msg.id,
        org_id=org_id,
    )

    # S-COMM-12 AC1: agent 답신 시 해당 conversation의 최근 gateway_accepted delivery → agent_replied
    if sender.type == "agent":
        from app.services.conversation_webhook import mark_agent_replied
        background_tasks.add_task(mark_agent_replied, conversation_id)

    # S-C2: agent sender인 경우에만 message_sent 기록 (AC2, AC4, AC5, AC6)
    if sender.type == "agent":
        from app.services.activity_log import record_activity_bg
        background_tasks.add_task(
            record_activity_bg,
            org_id=org_id,
            action="message_sent",
            actor_id=sender.id,
            actor_type="agent",
            project_id=conv.project_id,
            entity_type="conversation",
            entity_id=conversation_id,
            context={
                "message_id": str(msg.id),
                "content_preview": msg.content[:80] if msg.content else "",
            },
        )

    response: dict = {"data": _msg_payload(msg, sender, references=msg_references)}
    if fork_info:
        response["forked"] = True
        response["forked_conversation_id"] = fork_info["forked_conversation_id"]
    # E-CHAT-CMD S4: 미지원 런타임으로 차단된 커맨드의 hint 를 발신자에게 반환(AC3 hint response).
    if command_hints:
        response["command_gate"] = {"blocked": command_hints}
    # story #2294 ③(PO 판정, 미르코 실측): `command_gate.blocked[]`와 동일 원칙 — 화면이
    # 링크를 그린 뒤 "저장 결과"를 실제로 볼 창구가 구조적으로 없었다(epic/task는 backlinks
    # read 엔드포인트 자체가 없다). mention 토큰이 하나라도 있었을 때만 싣는다(대부분의
    # 평문 메시지는 무변경 — 회귀 0). 정상 경로(#2294 ①이 서면 화면이 애초에 못 고르는
    # 종류를 못 보낸다)에선 dropped가 항상 빈 배열이다 — 그래도 필드를 남기는 이유는
    # mention_parser.ChatMentionResult 참조(사람이 손으로 토큰을 치거나 에이전트가 API로
    # 직접 쓰는 경로는 여전히 존재).
    if mention_result.stored or mention_result.dropped:
        response["references"] = {"stored": mention_result.stored, "dropped": mention_result.dropped}
    return response


@router.post(
    "/{conversation_id}/attachments",
    status_code=201,
    response_model=MessageAttachment,
    response_model_exclude_none=True,
)
async def upload_conversation_attachment(
    conversation_id: uuid.UUID,
    body: UploadConversationAttachmentRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> MessageAttachment:
    """E-MCP-OPT S2(bbfd24ba): 비-브라우저 클라이언트(MCP)용 JSON/base64 첨부 업로드.

    인가는 `send_message`의 실제 발신 요건과 **동일**(참가자 필수) — 읽기 전용 엔드포인트의
    admin-agent-only-conversation 우회는 여기 적용하지 않는다: 그 우회는 GET(list/get_conversation)
    전용이고, 업로드는 결국 이 conversation 에 메시지를 보내는 것과 같은 쓰기 동작이라
    `send_message`(에이전트 sender 는 참가자 아니면 무조건 403·우회/auto-join 없음)와 정합해야
    한다 — 그렇지 않으면 비참가자 admin 에이전트가 업로드는 성공하고 뒤이은 send_chat_message 는
    403 나는 모순이 생긴다.
    """
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    data = mcp_attachment_upload.decode_json_attachment(body.content_base64)

    safe_name = mcp_attachment_upload.safe_attachment_filename(body.name)
    # S7 namespace — FE 업로드 라우트(apps/web .../conversations/[id]/attachments/route.ts)와 동일
    # 접두(org/<org>/project/<project>/chat/<conv>/...). path_in_source_scope 는 이 접두까지만
    # segment-match 하므로(그 뒤 세그먼트 수는 안 봄) 추가된 `mcp/` 세그먼트는 IDOR 가드/read-authorize
    # 통과에 영향 없다 — E-MCP-OPT S5(#2): 이 엔드포인트로 실제 생성된 객체만 식별하는 마커
    # (`_is_mcp_upload_object_path`)로 send_message 의 선언 한도 재검증이 소비한다.
    object_path = mcp_attachment_upload.build_mcp_object_path(
        org_id=org_id, project_id=conv.project_id, kind="chat", resource_id=conversation_id,
        safe_name=safe_name,
    )

    uploaded = await get_storage_provider().put_object(
        DEFAULT_CONTAINER, object_path, data, content_type=body.content_type,
    )
    if not uploaded:
        raise HTTPException(status_code=502, detail="upload failed")

    # story #2055 AC1: 바이트가 이미 메모리에 있으므로 재다운로드 없이 직접 측정.
    from app.services.image_dimensions import measure_image_dimensions_from_bytes
    dims = measure_image_dimensions_from_bytes(body.content_type, data)
    width, height = dims if dims is not None else (None, None)

    return MessageAttachment(
        url=object_path,
        name=body.name,
        content_type=body.content_type,
        size=len(data),
        width=width,
        height=height,
    )


@router.patch("/{conversation_id}/status", status_code=200)
async def update_conversation_status(
    conversation_id: uuid.UUID,
    body: UpdateStatusRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """PATCH /api/v2/conversations/{id}/status — open/resolved 전환."""
    if body.status not in ("open", "resolved"):
        raise HTTPException(status_code=400, detail="Invalid status. Must be 'open' or 'resolved'")

    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    requester = await _resolve_member(auth, org_id, db, project_id=conv.project_id)

    # 참여자 검증
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == requester.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    now = datetime.now(timezone.utc)
    if body.status == "resolved":
        conv.status = "resolved"
        conv.resolved_by = requester.id
        conv.resolved_at = now
    else:
        conv.status = "open"
        conv.resolved_by = None
        conv.resolved_at = None

    conv.updated_at = now
    await db.commit()
    await db.refresh(conv)

    return {
        "id": str(conv.id),
        "status": conv.status,
        "resolved_by": str(conv.resolved_by) if conv.resolved_by else None,
        "resolved_at": conv.resolved_at.isoformat() if conv.resolved_at else None,
    }


@router.patch("/{conversation_id}", status_code=200)
async def update_conversation(
    conversation_id: uuid.UUID,
    body: UpdateConversationRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """PATCH /api/v2/conversations/{id} — 방 title·free_response 사용자 편집(EF-S2 AC3·
    story #2603 P0 AC2·참여자 권한).

    각 필드는 제공 시만 갱신(기본값 보존). status PATCH 와 동일 참여자 게이트.
    """
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    requester = await _resolve_member(auth, org_id, db, project_id=conv.project_id)
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == requester.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    if body.title is not None:
        conv.title = body.title
        conv.updated_at = datetime.now(timezone.utc)
    if body.free_response is not None:
        conv.free_response = body.free_response
        conv.updated_at = datetime.now(timezone.utc)
    if body.title is not None or body.free_response is not None:
        await db.commit()
        await db.refresh(conv)

    return {"id": str(conv.id), "title": conv.title, "free_response": conv.free_response}
