"""E-A2A-POC S1+S2+S3 / E-A2A-P1 S1+S2: A2A 서버 — Agent Card + JSON-RPC
(SendMessage/GetTask) + CC 어댑터(fakechat 대체) + 발견 + 프로덕션 하드닝.

PoC 스코프였던 부분(2026-07-06): signed Card·멀티tenant는 여전히 Phase 3 대상. Card fetch
(`GET .../agent-card.json`)는 P1-S1 판단대로 unauth 유지(`public_docs.py` 선례 — 실 A2A
컨벤션상 개별 Card는 의도적 공개, opaque member_id당 name+skills뿐이라 PII 아님).

⚠️ **`/rpc`는 P1-S2(story 7b93eb10)로 authed+org-scoped 승격됨**(PO 크럭스) — action-triggering
엔드포인트라 caller org 소속 agent에게만 위임 가능(`_get_agent_member`에 org_id 검증 추가,
cross-org IDOR 봉인·오늘 S20 스윕과 동형 클래스였음).

spec shape는 `a2aproject/A2A`(GitHub, main) `specification/a2a.proto` + `docs/specification.md`
실측 기준(PascalCase 메소드명·camelCase 필드·`TASK_STATE_`/`ROLE_` enum) — story AC의
`message/send`/`tasks/get` 표기(구초안)가 아니다. PO 크럭스로 확認됨.

**S2(story 1485217f) — CC 어댑터**: 재실측 결과(문서 `e-a2a-poc-s2-design-crux`, PO+선생님
정정 2026-07-06) fakechat의 실체는 Discord webhook이 **아니라** 내장 WS 채팅 허브
(`ws_chat.py`의 `WS /ws/chat/{agent_id}` room + `channel.py:channel_deliver`가 그 room으로
`_broadcast`)다. 플랫폼은 멤버의 **member-bound `WebhookConfig` 유무로 택일**한다(有→Discord
webhook/`conversation_webhook.py`, 無→fakechat WS). S2는 이 기존 라우팅을 그대로 재사용해
**두 경로를 A2A 어댑터 뒤로 캡슐화**한다: SendMessage가 task-태깅 Conversation(=`context_id`)
+ root ConversationMessage를 만들고, WebhookConfig 유무에 따라 Discord webhook 또는 fakechat
WS `_broadcast`로 전달(`TASK_STATE_WORKING`) → CC가 그 메시지의 thread(reply)로 답신 →
GetTask가 그 thread를 폴링해 첫 답신을 발견하면 `TASK_STATE_COMPLETED` + artifact로 승격
(PO 크럭스 채택안, Q1+Q2 결합 — 두 전달 경로 공통).

⚠️ **알려진 한계(PO 크럭스 finding)**: (1) 완료 신호는 CC가 "task thread에 답신"하는 관례에
의존한다 — model-mediated 에이전트는 직접 완료 훅이 없어 A2A 표준이 기대하는 명시적 완료
신호를 얻을 근본 방법이 없다. (2) fakechat WS 경로는 Discord webhook과 신뢰성이 다르다 —
`_broadcast`는 그 순간 연결된 소켓에만 push하고 재시도/영속 큐가 없어(Discord webhook의
`ConversationWebhookDelivery` retry+상태추적과 다름) CC가 그 순간 미접속이면 실시간 유실된다
(단 `ConversationMessage` 자체는 DB에 영속). A2A는 인터페이스를 캡슐화하나 하위 채널의
신뢰성 차이까지 없애진 못한다 — Phase 3 이후 재검토 대상.

**S3(story 5578a8e2) — 발견→위임**: `GET /api/v2/a2a/members`(신규, 문서
`e-a2a-poc-s3-design-crux`)가 org 내 활성 agent 전원의 Agent Card를 반환 + `?skill=` 필터.
⚠️ **S1/S2의 개별 member_id 엔드포인트와 달리 이건 org 전체 로스터 열거라 인증 필수**
(PO 판정 — 오늘 S20 IDOR 스윕과 동형 노출 클래스, `get_verified_org_id`+`get_current_user`로
기존 `list_team_members`와 동일하게 authed). 발견된 member_id로 기존 S2 `SendMessage`/`GetTask`
경로를 그대로 재사용(신규 위임 코드 없음).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.a2a_task import A2ATask
from app.models.agent_deployment import AgentPersona
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
from app.models.team import TeamMember
from app.repositories.team_member import TeamMemberRepository
from app.routers.ws_chat import _broadcast, _rooms
from app.services.webhook_targeting import active_webhook_member_ids
from app.schemas.a2a import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
    Artifact,
    GetTaskParams,
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcResponse,
    Message,
    Part,
    SendMessageParams,
    Task,
    TaskStatus,
)
from app.services.conversation_webhook import deliver_conversation_message_webhook

router = APIRouter(prefix="/api/v2/a2a", tags=["a2a"])

_METHOD_NOT_FOUND = -32601
_INVALID_PARAMS = -32602
_TASK_NOT_FOUND = -32001  # A2A-specific error range(-32001~-32099)

_TERMINAL_STATES = {
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
}

# P1-S2(story 7b93eb10, PO 크럭스 승인): model-mediated 완료신호 부재의 백스톱 — CC가 이 시간
# 안에 task-thread 답신을 안 하면 GetTask가 폴링 시점에 TASK_STATE_FAILED로 전이한다(영구
# WORKING 정체 방지). ⚠️ tradeoff(정직히 문서화, PO 지시): CC가 30분 넘게 조용히 오래 작업하는
# 정상 케이스도 false-FAIL될 수 있다(interim ack 없는 model-mediated 구조의 근본 제약) — 실사용
# 데이터가 쌓이면 이 값을 튜닝한다. PoC→P1 단계에선 설정가능화(요청별 override) 대신 고정 상수로
# 시작(실사용 데이터 없이 설정 노출은 과설계).
A2A_TASK_TIMEOUT_MINUTES = 30


class _JsonRpcException(Exception):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message


async def _get_agent_member(
    session: AsyncSession, member_id: uuid.UUID, org_id: uuid.UUID | None = None
) -> TeamMember:
    """P1-S2(story 7b93eb10, PO 크럭스 승인): `org_id`가 주어지면 caller org로 스코프한다 —
    `/rpc`는 이제 authed+org-scoped 호출이라 이 검증이 필수(이전엔 org_id 비교가 없어 caller
    org와 무관하게 아무 agent에게나 SendMessage 가능한 cross-org IDOR였다, S20과 동형).
    Card fetch(`get_agent_card`)는 P1-S1 판단대로 org_id 없이(unauth) 그대로 호출한다."""
    conditions = [
        TeamMember.id == member_id, TeamMember.type == "agent", TeamMember.is_active.is_(True)
    ]
    if org_id is not None:
        conditions.append(TeamMember.org_id == org_id)
    result = await session.execute(select(TeamMember).where(*conditions))
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return member


async def _build_agent_card(session: AsyncSession, member: TeamMember, base_url: str) -> AgentCard:
    """skills[]는 role_template 능력 반영 — 별도 저장 없이 요청 시 AgentPersona(config.tool_allowlist)
    + role_template slug/name/description에서 동적 조립(SSOT는 role_templates, 문서
    `e-a2a-poc-s1-design-crux` §A 판단)."""
    persona_result = await session.execute(
        select(AgentPersona).where(
            AgentPersona.agent_id == member.id,
            AgentPersona.is_default.is_(True),
            AgentPersona.deleted_at.is_(None),
        )
    )
    persona = persona_result.scalar_one_or_none()

    if persona is not None:
        tool_allowlist = persona.config.get("tool_allowlist", []) if isinstance(persona.config, dict) else []
        skills = [
            AgentSkill(
                id=persona.slug,
                name=persona.name,
                description=persona.description or persona.name,
                tags=list(tool_allowlist),
            )
        ]
    else:
        # 미채용(recruit 이전) 에이전트 — team_members.agent_role만으로 최소 skill 하나.
        skills = [
            AgentSkill(
                id=member.agent_role or "unassigned",
                name=member.agent_role or member.name,
                description=f"{member.name} — role_template 미배정(recruit 이전)",
                tags=[],
            )
        ]

    interface_url = f"{base_url}/api/v2/a2a/members/{member.id}/rpc"
    return AgentCard(
        name=member.name,
        description=f"Sprintable team member — {member.agent_role or 'agent'}",
        supported_interfaces=[
            AgentInterface(
                url=interface_url,
                protocol_binding="JSONRPC",
                protocol_version="1.0",
                tenant=str(member.id),
            )
        ],
        version="0.1.0-poc",
        capabilities=AgentCapabilities(streaming=False, push_notifications=False, extended_agent_card=False),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=skills,
    )


def _skill_matches(card: AgentCard, query: str) -> bool:
    q = query.lower()
    for skill in card.skills:
        if q == skill.id.lower():
            return True
        if any(q in tag.lower() for tag in skill.tags):
            return True
        if q in skill.name.lower() or q in skill.description.lower():
            return True
    return False


@router.get("/members", response_model=list[AgentCard])
async def list_agent_cards(
    request: Request,
    skill: str | None = Query(default=None),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[AgentCard]:
    """S3(story 5578a8e2) — 발견: caller org 내 활성 agent 전원의 Agent Card 열거 + `?skill=`
    필터(id/tags/name/description OR 매칭, 대소문자 무시). 개별 member_id 엔드포인트와 달리
    org 전체 로스터 열거라 인증 필수(PO 판정, 오늘 S20 IDOR 스윕과 동형 노출 클래스)."""
    repo = TeamMemberRepository(session, org_id)
    agents = await repo.list(type="agent", is_active=True)

    base_url = str(request.base_url).rstrip("/")
    cards = [await _build_agent_card(session, agent, base_url) for agent in agents]

    if skill:
        cards = [c for c in cards if _skill_matches(c, skill)]

    return cards


@router.get("/members/{member_id}/agent-card.json")
async def get_agent_card(
    member_id: uuid.UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> AgentCard:
    member = await _get_agent_member(session, member_id)
    card = await _build_agent_card(session, member, str(request.base_url).rstrip("/"))
    return card


def _task_to_dict(task: A2ATask) -> dict:
    status_message = None
    failure_reason = (task.task_metadata or {}).get("failure_reason") if task.state == "TASK_STATE_FAILED" else None
    if failure_reason:
        status_message = Message(
            message_id=str(uuid.uuid4()), context_id=str(task.context_id),
            role="ROLE_AGENT", parts=[Part(text=failure_reason)],
        )
    return Task(
        id=str(task.id),
        context_id=str(task.context_id),
        status=TaskStatus(
            state=task.state,
            message=status_message,
            timestamp=task.updated_at.isoformat() if task.updated_at else None,
        ),
        artifacts=[Artifact.model_validate(a) for a in task.artifacts],
        history=[Message.model_validate(m) for m in task.history],
        metadata=task.task_metadata,
    ).model_dump(by_alias=True, mode="json")


def _first_text(message: Message) -> str:
    for part in message.parts:
        if part.text:
            return part.text
    return ""


async def _handle_send_message(session: AsyncSession, member: TeamMember, params: dict) -> dict:
    try:
        send_params = SendMessageParams.model_validate(params)
    except Exception as exc:  # noqa: BLE001 — JSON-RPC InvalidParamsError로 매핑
        raise _JsonRpcException(_INVALID_PARAMS, f"Invalid params: {exc}") from exc

    incoming = send_params.message
    text = _first_text(incoming)

    # commit() 이후 이 세션에 로드된 모든 ORM 객체(member 포함)의 속성이 expire_on_commit
    # 기본값으로 만료돼 greenlet 컨텍스트 밖 lazy-load(MissingGreenlet)를 유발한다 —
    # commit 전에 필요한 member 필드를 로컬 변수로 고정해두고 이후엔 이것만 쓴다.
    member_id = member.id
    member_org_id = member.org_id
    member_project_id = member.project_id
    member_name = member.name

    # S2(정정 2026-07-06)+P1-S3 §10(SSOT 교체): 플랫폼 기존 라우팅과 동형으로 택일 —
    # member-bound WebhookConfig 有→Discord webhook, 無→fakechat WS(_broadcast). "존재 여부"
    # 판정은 이제 인라인 쿼리가 아니라 플랫폼 SSOT(webhook_targeting.active_webhook_member_ids —
    # notification_dispatch/conversations.py가 이미 공유하는 그 함수)를 그대로 호출한다 — 병렬
    # 구현 박멸(멤버 다중 WebhookConfig 케이스도 이 함수가 이미 처리: member_id.in_() + 존재만
    # 보므로 MultipleResultsFound 위험이 애초에 없다). `_get_agent_member`가 이미 type="agent"+
    # is_active를 강제해 여기 도달하는 멤버는 항상 둘 중 하나로 도달 가능하므로 REJECTED 분기는
    # 없다. 실 전달은 다중 타깃 resolve를 이미 하는 deliver_conversation_message_webhook에 위임
    # (아래, 변경 없음).
    has_webhook = member_id in await active_webhook_member_ids(session, member_org_id, [member_id])

    # S2: task-태깅 Conversation(=A2A context_id) — CC 어댑터가 이 두 경로 중 하나로 실 주입한다.
    conv_id = uuid.uuid4()
    root_message_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    session.add(Conversation(
        id=conv_id,
        project_id=member_project_id,
        org_id=member_org_id,
        type="group",
        title=f"A2A task → {member_name}",
        created_by=None,
    ))
    await session.flush()
    session.add(ConversationParticipant(conversation_id=conv_id, member_id=member_id))
    session.add(ConversationMessage(
        id=root_message_id,
        conversation_id=conv_id,
        sender_id=None,
        content=text,
        thread_id=None,
        created_at=now,
    ))
    await session.flush()
    await session.commit()

    task_metadata: dict = {"delivery_channel": "webhook" if has_webhook else "fakechat_ws"}

    if has_webhook:
        await deliver_conversation_message_webhook(
            message_id=root_message_id,
            conversation_id=conv_id,
            org_id=member_org_id,
            project_id=member_project_id,
            sender_id=None,
            thread_id=None,
            created_at=now,
            mentioned_ids=None,
            content=text,
            targets=None,
        )
    else:
        # fakechat WS 경로 — channel.py:_persist_and_broadcast와 동일 payload shape,
        # 다만 A2A엔 실 caller member가 없어 sender_id=None(시스템 발신, 기존 패턴).
        # P1-S2(C): _broadcast는 ack가 없어 그 순간 연결 소켓 0이어도 예외가 안 난다 — 하드 실패로
        # 단정하지 않고(메시지는 conversation_messages에 영속·재연결 시 여전히 도달 가능) 정보성
        # 신호만 task_metadata에 남긴다. 최종 안전망은 A2A_TASK_TIMEOUT_MINUTES 백스톱(GetTask).
        task_metadata["connected_at_send"] = bool(_rooms.get(str(member_id)))
        payload = json.dumps({
            "id": str(root_message_id),
            "conversation_id": str(conv_id),
            "sender_id": None,
            "sender_name": "A2A",
            "content": text,
            "ts": now.isoformat(),
        })
        await _broadcast(str(member_id), payload)

    task_id = uuid.uuid4()
    session.add(A2ATask(
        id=task_id,
        context_id=conv_id,
        root_message_id=root_message_id,
        member_id=member_id,
        state="TASK_STATE_WORKING",
        task_metadata=task_metadata,
        history=[incoming.model_dump(by_alias=True, mode="json")],
        artifacts=[],
    ))
    await session.flush()
    await session.commit()

    task = (await session.execute(
        select(A2ATask).where(A2ATask.id == task_id)
    )).scalar_one()
    return _task_to_dict(task)


async def _handle_get_task(session: AsyncSession, member: TeamMember, params: dict) -> dict:
    try:
        get_params = GetTaskParams.model_validate(params)
    except Exception as exc:  # noqa: BLE001
        raise _JsonRpcException(_INVALID_PARAMS, f"Invalid params: {exc}") from exc

    result = await session.execute(
        select(A2ATask).where(A2ATask.id == get_params.id, A2ATask.member_id == member.id)
    )
    task = result.scalar_one_or_none()
    if task is None:
        raise _JsonRpcException(_TASK_NOT_FOUND, "Task not found")

    if task.state not in _TERMINAL_STATES and task.root_message_id is not None:
        reply = (await session.execute(
            select(ConversationMessage)
            .where(ConversationMessage.thread_id == task.root_message_id)
            .order_by(ConversationMessage.created_at.asc())
            .limit(1)
        )).scalar_one_or_none()

        if reply is not None:
            reply_message = Message(
                message_id=str(reply.id),
                context_id=str(task.context_id),
                role="ROLE_AGENT",
                parts=[Part(text=reply.content)],
            )
            task.state = "TASK_STATE_COMPLETED"
            task.history = [*task.history, reply_message.model_dump(by_alias=True, mode="json")]
            task.artifacts = [
                Artifact(
                    artifact_id=str(reply.id),
                    name="agent-reply",
                    parts=[Part(text=reply.content)],
                ).model_dump(by_alias=True, mode="json")
            ]
            await session.flush()
            await session.commit()
            await session.refresh(task)
        else:
            # P1-S2(B, PO 크럭스 승인): 답신이 아직 없으면 2단 판정 — (1) Discord webhook 경로면
            # 실 배달상태(ConversationWebhookDelivery, root_message_id로 조인 — 신규 컬럼 불요)로
            # 확실히 아는 실패를 우선 반영. (2) 그것도 아니면 생성 후 타임아웃 경과를 두 경로
            # 공통 백스톱으로 사용(fakechat WS는 ack가 없어 이게 유일한 실패 신호).
            failure_reason: str | None = None

            delivery = (await session.execute(
                select(ConversationWebhookDelivery)
                .where(ConversationWebhookDelivery.message_id == task.root_message_id)
                .order_by(ConversationWebhookDelivery.created_at.desc())
                .limit(1)
            )).scalar_one_or_none()
            if delivery is not None and delivery.status == "failed":
                failure_reason = (
                    f"webhook delivery failed after {delivery.attempt_count} attempts: "
                    f"{delivery.last_error or 'unknown error'}"
                )
            elif datetime.now(timezone.utc) - task.created_at > timedelta(minutes=A2A_TASK_TIMEOUT_MINUTES):
                failure_reason = (
                    f"timed out waiting for agent response after {A2A_TASK_TIMEOUT_MINUTES}m"
                )

            if failure_reason is not None:
                task.state = "TASK_STATE_FAILED"
                task.task_metadata = {**(task.task_metadata or {}), "failure_reason": failure_reason}
                await session.flush()
                await session.commit()
                await session.refresh(task)

    return _task_to_dict(task)


_METHODS = {
    "SendMessage": _handle_send_message,
    "GetTask": _handle_get_task,
}


@router.post("/members/{member_id}/rpc")
async def a2a_rpc(
    member_id: uuid.UUID,
    body: JsonRpcRequest,
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JsonRpcResponse:
    """P1-S2: action-triggering 엔드포인트라 authed+org-scoped(PO 크럭스 — S1 PoC 리스크 노트
    봉인). Card fetch(GET .../agent-card.json)는 P1-S1 판단대로 unauth 유지, 여기만 인증."""
    member = await _get_agent_member(session, member_id, org_id)

    handler = _METHODS.get(body.method)
    if handler is None:
        return JsonRpcResponse(
            id=body.id,
            error=JsonRpcError(code=_METHOD_NOT_FOUND, message=f"Method not found: {body.method}"),
        )

    try:
        result = await handler(session, member, body.params or {})
    except _JsonRpcException as exc:
        return JsonRpcResponse(id=body.id, error=JsonRpcError(code=exc.code, message=exc.message))

    return JsonRpcResponse(id=body.id, result=result)
