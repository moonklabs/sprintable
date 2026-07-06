"""E-A2A-POC S1+S2(story 480e81fb·1485217f): 최소 A2A 서버 — Agent Card + JSON-RPC
(SendMessage/GetTask) + CC 어댑터(fakechat 대체).

PoC 스코프(선생님 지시 + PO 크럭스 2026-07-06): 인증·멀티tenant·signed Card·push 웹훅 생략
(Phase 3). member_id로만 스코프(org_id 검증 없음) — `public_docs.py` 선례처럼 비인증 라우트.

⚠️ Phase 3 리스크 노트(PO 크럭스): `/rpc`의 `SendMessage`는 실제 task를 생성/트리거하는
action-triggering 엔드포인트다 — PoC는 내부 2에이전트 contained 시나리오라 비인증이 허용되지만
외부 interop 단계에서는 인증이 반드시 필요하다.

spec shape는 `a2aproject/A2A`(GitHub, main) `specification/a2a.proto` + `docs/specification.md`
실측 기준(PascalCase 메소드명·camelCase 필드·`TASK_STATE_`/`ROLE_` enum) — story AC의
`message/send`/`tasks/get` 표기(구초안)가 아니다. PO 크럭스로 확認됨.

**S2(story 1485217f) — CC 어댑터**: 기존 fakechat 하향 경로 실측 결과(문서
`e-a2a-poc-s2-design-crux`), "fakechat"의 실체는 `conversation_webhook.py:deliver_conversation_message_webhook`
가 그 멤버의 **member-bound WebhookConfig(Discord webhook)**로 메시지를 POST하는 것뿐이었다.
S2는 echo 대신 이 실 전달 경로를 재사용한다: SendMessage가 task-태깅 Conversation(=`context_id`)
+ root ConversationMessage를 만들어 그 경로로 전달(`TASK_STATE_WORKING`) → CC가 그 메시지의
thread(reply)로 답신 → GetTask가 그 thread를 폴링해 첫 답신을 발견하면 `TASK_STATE_COMPLETED`
+ artifact로 승격(PO 크럭스 채택안, Q1+Q2 결합).

⚠️ **알려진 한계(PO 크럭스 finding)**: 완료 신호는 CC가 "task thread에 답신"하는 관례에
의존한다 — model-mediated 에이전트는 직접 완료 훅이 없어 A2A 표준이 기대하는 명시적 완료
신호를 얻을 근본 방법이 없다(이 세션의 substrate로는). Phase 3 이후 재검토 대상.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.models.a2a_task import A2ATask
from app.models.agent_deployment import AgentPersona
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.team import TeamMember
from app.models.webhook_config import WebhookConfig
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


class _JsonRpcException(Exception):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message


async def _get_agent_member(session: AsyncSession, member_id: uuid.UUID) -> TeamMember:
    result = await session.execute(
        select(TeamMember).where(
            TeamMember.id == member_id, TeamMember.type == "agent", TeamMember.is_active.is_(True)
        )
    )
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
    return Task(
        id=str(task.id),
        context_id=str(task.context_id),
        status=TaskStatus(
            state=task.state,
            timestamp=task.updated_at.isoformat() if task.updated_at else None,
        ),
        artifacts=[Artifact.model_validate(a) for a in task.artifacts],
        history=[Message.model_validate(m) for m in task.history],
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

    webhook = (await session.execute(
        select(WebhookConfig).where(
            WebhookConfig.member_id == member_id, WebhookConfig.is_active.is_(True)
        )
    )).scalar_one_or_none()

    if webhook is None:
        # A2A 표준 상태 — agent가 이 task를 처리할 수단(주입 경로)이 없어 즉시 거부.
        task_id = uuid.uuid4()
        session.add(A2ATask(
            id=task_id,
            context_id=uuid.uuid4(),
            member_id=member_id,
            state="TASK_STATE_REJECTED",
            history=[incoming.model_dump(by_alias=True, mode="json")],
            artifacts=[],
        ))
        await session.flush()
        await session.commit()
        task = (await session.execute(select(A2ATask).where(A2ATask.id == task_id))).scalar_one()
        return _task_to_dict(task)

    # S2: task-태깅 Conversation(=A2A context_id) — CC 어댑터가 실 webhook 경로로 주입한다
    # (echo 대신 `deliver_conversation_message_webhook` 재사용 — fakechat 실체와 동일 경로).
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

    task_id = uuid.uuid4()
    session.add(A2ATask(
        id=task_id,
        context_id=conv_id,
        root_message_id=root_message_id,
        member_id=member_id,
        state="TASK_STATE_WORKING",
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

    return _task_to_dict(task)


_METHODS = {
    "SendMessage": _handle_send_message,
    "GetTask": _handle_get_task,
}


@router.post("/members/{member_id}/rpc")
async def a2a_rpc(
    member_id: uuid.UUID,
    body: JsonRpcRequest,
    session: AsyncSession = Depends(get_db),
) -> JsonRpcResponse:
    member = await _get_agent_member(session, member_id)

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
