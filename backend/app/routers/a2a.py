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

⚠️ **알려진 한계(PO 크럭스 finding)**: 완료 신호는 CC가 "task thread에 답신"하는 관례에
의존한다 — model-mediated 에이전트는 직접 완료 훅이 없어 A2A 표준이 기대하는 명시적 완료
신호를 얻을 근본 방법이 없다.

**헤드라인 fix(2026-07-06, 문서 `a2a-headline-sse-reroute-crux`)**: S2 재그라운딩의 "fakechat=
ws_chat WS hub" 결론이 outdated였음이 드러남 — 실 CC-side fakechat 플러그인
(`packages/fakechat/server.ts`)은 2026-06-02(`26f9cb76`)부로 그 WS hub를 안 쓰고
`GET /agent/stream` SSE dial-out으로 전환됨(그 WS room의 유일한 실 소비자는 브라우저 사람
UI). 무-webhook 분기는 이제 `ws_chat._broadcast` 대신 CC가 실제로 구독 중인 Event/
`agent_gateway.py` SSE 파이프라인에 편승한다: `Event`(event_type="a2a.task_message") 생성→
flush→`assign_recipient_seq`(같은 트랜잭션, flush 後·commit 前 필수)→commit→`wake_agent`
(즉시 push). 미접속이어도 Event는 영속되고 재연결 시 backfill로 도달 — 최종 안전망은 여전히
`A2A_TASK_TIMEOUT_MINUTES` 백스톱(P1-S2). Discord webhook 경로(`ConversationWebhookDelivery`
retry+상태추적)와는 신뢰성 메커니즘이 다르나, 이제 최소한 "죽은 경로로 보내는" 문제는 해소됨.

**S3(story 5578a8e2) — 발견→위임**: `GET /api/v2/a2a/members`(신규, 문서
`e-a2a-poc-s3-design-crux`)가 org 내 활성 agent 전원의 Agent Card를 반환 + `?skill=` 필터.
⚠️ **S1/S2의 개별 member_id 엔드포인트와 달리 이건 org 전체 로스터 열거라 인증 필수**
(PO 판정 — 오늘 S20 IDOR 스윕과 동형 노출 클래스, `get_verified_org_id`+`get_current_user`로
기존 `list_team_members`와 동일하게 authed). 발견된 member_id로 기존 S2 `SendMessage`/`GetTask`
경로를 그대로 재사용(신규 위임 코드 없음).

**E-A2A-EXT — 첫 A2A extension(문서 `e-a2a-ext-approach-crux`)**: profile 타입,
`PROJECT_CONTEXT_EXTENSION_URI`. 클라가 `A2A-Extensions` 헤더로 이 URI를 선언하고
`Message.metadata`에 그 키로 구조화 payload를 실으면, `_handle_send_message`가 이를
`task_metadata["project_context"]`(GetTask로 조회 가능) + fakechat 전달 payload에 보존한다.
⚠️webhook 경로는 스코프 밖(공유 함수 `deliver_conversation_message_webhook`이 plain text만
받아 계약 확장은 과설계 — 코드 주석 참조). 헤더 미선언 시 이 로직 전체가 스킵돼 무회귀.

**완료신호 multi-webhook 오판 fix(2026-07-07, story 652c2842, 까심 크로스모델 QA root 확定)**:
`_handle_get_task`의 delivery 실패 판정이 `ConversationWebhookDelivery`를 "최신 1건만" 보고 있어
multi-webhook 멤버(채널 2개 이상)가 그중 하나만 실패해도 거짓 FAILED를 냈다(task bd4a6c0b 재현).
그 메시지의 전 delivery를 모아 **전량 실패일 때만** FAILED로 승격하도록 교정 — 하나라도
delivered면 이 판정에서는 실패 아님(응답 대기 지속, 타임아웃 백스톱은 그대로 유효).

**~300직군 카탈로그 트랙 S4(2026-07-07, 문서 role-template-crud-api-crux)**: `_build_agent_card`가
persona 존재 시 무조건 persona.slug/config.tool_allowlist 파생 단일 skill을 쓰던 것에서, persona가
`config.role_template_id`(recruit_agent() marker)를 갖고 그 role_template.skills(admin CRUD/벌크로
관리)가 채워져 있으면 **카드-빌드 시점에 그 실 skills를 직접 반영**하도록 확장 — persona 생성
당시 스냅샷이 아니라 카탈로그 갱신을 재-recruit 없이 그대로 따라간다. role_template.skills가
비어있으면(아직 구조화 미완료) 기존 persona 파생 단일 skill로 그레이스풀 폴백 — 무회귀(오늘
수작업으로 만든 8명의 persona는 role_template_id가 없어 이 폴백 그대로, 크래시 없음).
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_factory
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.a2a_task import A2ATask
from app.models.agent_deployment import AgentPersona
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
from app.models.event import Event
from app.models.gate import Gate
from app.models.role_template import RoleTemplate
from app.models.team import TeamMember
from app.repositories.team_member import TeamMemberRepository
from app.routers.agent_gateway import wake_agent
from app.routers.events import _agent_connections
from app.services.agent_onboarding_config import resolve_backend_direct_url
from app.services.a2a_task_lifecycle import (
    A2A_TASK_TIMEOUT_MINUTES,
    effective_deadline,
    fail_task_if_still_working,
)
from app.services.event_seq import assign_recipient_seq
from app.services.webhook_targeting import active_webhook_member_ids
from app.schemas.a2a import (
    AgentCapabilities,
    AgentCard,
    AgentExtension,
    AgentInterface,
    AgentSkill,
    Artifact,
    GetTaskParams,
    HTTPAuthSecurityScheme,
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcResponse,
    ListTasksParams,
    Message,
    Part,
    SecurityRequirement,
    SecurityScheme,
    SendMessageParams,
    Task,
    TaskStatus,
)
from app.services.conversation_webhook import deliver_conversation_message_webhook

router = APIRouter(prefix="/api/v2/a2a", tags=["a2a"])

_METHOD_NOT_FOUND = -32601
_INVALID_PARAMS = -32602
_TASK_NOT_FOUND = -32001  # A2A-specific error range(-32001~-32099)
_VERSION_NOT_SUPPORTED = -32009  # 스펙 §14.2.1: A2A-Version 헤더가 지원 범위 밖일 때

# E-A2A-PROTO P1(2026-07-06): 스펙 §14.2.1 — 클라이언트는 A2A-Version 헤더를 MUST 전송.
# 우리는 1.0만 지원(Card의 protocol_version과 동일 소스). ⚠️tradeoff(정직 문서화): 헤더
# 부재 시 하드 거부하면 헤더를 아직 안 보내는 기존 PoC/내부 dogfood 트래픽이 전부 깨진다 —
# PoC→Phase1 단계에선 **부재는 관대하게 허용**(스펙의 MUST는 클라 책무일 뿐 서버 강제는
# 아님)하고, **명시적으로 잘못된 Major**(우리가 지원 안 하는 값)만 거부한다. 트래픽이
# 실제로 헤더를 보내기 시작하면 이 관용을 좁히는 재검토가 필요하다.
A2A_PROTOCOL_VERSION = "1.0"

# E-A2A-EXT(2026-07-06, PO 크럭스 `e-a2a-ext-approach-crux`): 첫 A2A extension — profile 타입,
# 코어 RPC 계약은 안 바꾸고 Message.metadata에 이 URI를 키로 한 구조화 payload를 얹는다.
# opt-in만(A2A-Extensions 헤더에 이 URI를 선언한 요청에 한해 해석) — 미선언 시 완전 무회귀.
PROJECT_CONTEXT_EXTENSION_URI = "https://sprintable.ai/a2a-ext/project-context/v1"

# E-A2A-EXTERNAL(축4, 2026-07-06, 문서 `e-a2a-external-interop-crux`): Card.securitySchemes의
# 키 이름 — 실제 /rpc 인증 요건(Bearer)을 스펙 표준으로 정직 광고. 외부 파트너용 자격증명
# 발급 경로는 아직 없음(별도 crux 필요, 실 파트너 요청 대기) — 이 광고는 "우리가 뭘 요구하는지"
# 정직하게 알리는 것뿐, 발급 메커니즘 자체를 새로 만드는 게 아니다.
_SECURITY_SCHEME_KEY = "sprintableBearerAuth"


def _parse_active_extensions(request: Request) -> frozenset[str]:
    """A2A-Extensions 헤더(콤마구분 URI 목록) 파싱 — 스펙 §7 클라 활성화 선언."""
    header = request.headers.get("A2A-Extensions")
    if not header:
        return frozenset()
    return frozenset(uri.strip() for uri in header.split(",") if uri.strip())

_TERMINAL_STATES = {
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
}

# P1-S2(story 7b93eb10, PO 크럭스 승인) + S-A1(story 2a57dc0f): model-mediated 완료신호 부재의
# 백스톱 — CC가 이 시간 안에 task-thread 답신을 안 하면 FAILED로 전이한다(영구 WORKING 정체
# 방지). ⚠️ tradeoff(정직히 문서화, PO 지시): CC가 30분 넘게 조용히 오래 작업하는 정상 케이스도
# false-FAIL될 수 있다(interim ack 없는 model-mediated 구조의 근본 제약) — 실사용 데이터가
# 쌓이면 이 값을 튜닝한다. 상수 자체는 `a2a_task_lifecycle`(cron 스위퍼와 공유 SSOT) 소유 —
# 여기선 재-export만.


class _JsonRpcException(Exception):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message


def _caller_project_hint(auth: AuthContext) -> uuid.UUID | None:
    """S-A8(story 7d4ad784): file_locks.py `_caller_project_hint`(S17, 까심+codex+산티아고
    QA 통과)와 동일 패턴 — X-Project-Id 헤더/JWT app_metadata.project_id로 caller의 project
    컨텍스트를 best-effort로 얻는다(검증은 아니고 결정적 좁히기용)."""
    raw = auth.claims.get("app_metadata", {}).get("project_id")
    if not raw:
        return None
    try:
        return uuid.UUID(str(raw))
    except (ValueError, TypeError):
        return None


async def _get_agent_member(
    session: AsyncSession, member_id: uuid.UUID, org_id: uuid.UUID | None = None,
    auth: AuthContext | None = None,
) -> TeamMember:
    """P1-S2(story 7b93eb10, PO 크럭스 승인): `org_id`가 주어지면 caller org로 스코프한다 —
    `/rpc`는 이제 authed+org-scoped 호출이라 이 검증이 필수(이전엔 org_id 비교가 없어 caller
    org와 무관하게 아무 agent에게나 SendMessage 가능한 cross-org IDOR였다, S20과 동형).
    Card fetch(`get_agent_card`)는 P1-S1 판단대로 org_id 없이(unauth) 그대로 호출한다.

    S-A8(story 7d4ad784, hotfix): `team_members`는 뷰(members⋈project_access, 마이그 0110
    A안 — grant가 SSOT, 의도된 설계 — [[project_agent_multiproject_grant]])라 멀티프로젝트
    grant 에이전트는 project_access 개수만큼 행으로 fan-out한다. 예전 `scalar_one_or_none()`이
    PK 유일성을 가정해 다중행에서 `MultipleResultsFound`(→500 INTERNAL_ERROR)로 죽었다(prod
    산티아고 c7a8dd0e 실사례, 2개 project 소속). file_locks.py `_fetch_scoped_member`(S17)와
    동일 패턴으로 흡수: caller의 project 힌트(authed 호출)로 먼저 결정적으로 좁히고, 없거나
    미스매치면 project_id 오름차순 결정적 폴백. `get_agent_card`(unauth)는 `auth=None`이라
    바로 폴백 경로 — AgentCard 출력은 project-무관(identity/skills/security만)이라 어느 행을
    골라도 동일 결과."""
    conditions = [
        TeamMember.id == member_id, TeamMember.type == "agent", TeamMember.is_active.is_(True)
    ]
    if org_id is not None:
        conditions.append(TeamMember.org_id == org_id)
    base_query = select(TeamMember).where(*conditions)

    if auth is not None:
        project_hint = _caller_project_hint(auth)
        if project_hint is not None:
            hinted = (await session.execute(
                base_query.where(TeamMember.project_id == project_hint).limit(1)
            )).scalars().first()
            if hinted is not None:
                return hinted

    result = await session.execute(base_query.order_by(TeamMember.project_id).limit(1))
    member = result.scalars().first()
    if member is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return member


async def _build_agent_card(session: AsyncSession, member: TeamMember, base_url: str) -> AgentCard:
    """skills[]는 role_template 능력 반영 — SSOT는 role_templates(문서
    `e-a2a-poc-s1-design-crux` §A 판단).

    ~300직군 카탈로그 트랙 S4(문서 `role-template-crud-api-crux`): persona가 recruit_agent()로
    생성되어 `config.role_template_id`(admin CRUD/벌크로 관리되는 role_templates.skills 의
    marker)를 갖고 있으면, **그 role_template의 실 skills 를 카드-빌드 시점에 직접 조회**해
    반영한다 — persona 생성 시점에 스냅샷된 정적 값이 아니라 카탈로그가 갱신되면 재-recruit
    없이도 그대로 따라간다. role_template.skills 가 비어있으면(아직 카탈로그에 구조화 skills가
    채워지지 않은 role) 기존 persona-slug 파생 단일 skill로 폴백(무회귀 — 오늘(2026-07-07)
    수작업으로 만든 8명의 persona 는 role_template_id 가 없어 이 폴백 그대로 유지된다)."""
    persona_result = await session.execute(
        select(AgentPersona).where(
            AgentPersona.agent_id == member.id,
            AgentPersona.is_default.is_(True),
            AgentPersona.deleted_at.is_(None),
        )
    )
    persona = persona_result.scalar_one_or_none()

    role_template_skills: list[AgentSkill] | None = None
    if persona is not None and isinstance(persona.config, dict):
        role_template_id = persona.config.get("role_template_id")
        if role_template_id:
            role_template = (await session.execute(
                select(RoleTemplate).where(RoleTemplate.id == uuid.UUID(role_template_id))
            )).scalar_one_or_none()
            if role_template is not None and role_template.skills:
                role_template_skills = [AgentSkill(**s) for s in role_template.skills]

    if role_template_skills is not None:
        skills = role_template_skills
    elif persona is not None:
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
                protocol_version=A2A_PROTOCOL_VERSION,
                tenant=str(member.id),
            )
        ],
        version="0.1.0-poc",
        capabilities=AgentCapabilities(
            # S-A4(story 03034d86): SendStreamingMessage 구현됨 — 정직 광고로 전환.
            streaming=True, push_notifications=False, extended_agent_card=False,
            extensions=[
                AgentExtension(
                    uri=PROJECT_CONTEXT_EXTENSION_URI,
                    description="Sprintable 프로젝트/AC/정책 컨텍스트를 A2A task에 첨부(opt-in, A2A-Extensions 헤더로 활성화)",
                    required=False,
                ),
            ],
        ),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=skills,
        security_schemes={
            _SECURITY_SCHEME_KEY: SecurityScheme(
                http_auth_security_scheme=HTTPAuthSecurityScheme(
                    scheme="Bearer",
                    bearer_format="sk_live_ API key or JWT",
                    description="/rpc 호출은 그 에이전트의 org에 소속된 Sprintable 발급 자격증명이 필요(외부 파트너 발급 경로는 미구현 — E-A2A-EXTERNAL 후속)",
                ),
            ),
        },
        security_requirements=[SecurityRequirement(schemes={_SECURITY_SCHEME_KEY: []})],
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

    base_url = resolve_backend_direct_url()
    cards = [await _build_agent_card(session, agent, base_url) for agent in agents]

    if skill:
        cards = [c for c in cards if _skill_matches(c, skill)]

    return cards


@router.get("/members/{member_id}/agent-card.json")
async def get_agent_card(
    member_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> AgentCard:
    """E-SECURITY SEC-S2(story 48ff642a): authed+same-org로 승격 — 이전엔 unauth+org무관이라
    member_id만 알면 org 밖에서도 아무 agent 카드(이름·skills·URL) 조회 가능했다(멀티테넌트
    격리 위반). action(/rpc)은 이미 P1-S2로 authed+org-scoped라 대칭 정합.

    선생님 확認: A2A cross-org discovery(임대·마켓플레이스류) 자체는 버그 아닌 로드맵이었으나
    멀티테넌트 격리가 성숙하기 前까지는 org로 좁히는 게 현시점 기본 정책 — `_get_agent_member`의
    `org_id`가 이미 optional(None=무필터)이라 이 변경 자체가 영구 봉인이 아니라 "org_id를
    지금 넘긴다"는 호출부 선택일 뿐, 재개는 이 인자를 안 넘기는 것으로 되돌릴 수 있다(코드 구조상
    확장점 보존, 새 flag 불필요)."""
    member = await _get_agent_member(session, member_id, org_id)
    card = await _build_agent_card(session, member, resolve_backend_direct_url())
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
    ).model_dump(by_alias=True, mode="json", exclude_none=True)


def _first_text(message: Message) -> str:
    for part in message.parts:
        if part.text:
            return part.text
    return ""


async def _handle_send_message(
    session: AsyncSession, member: TeamMember, params: dict,
    active_extensions: frozenset[str] = frozenset(),
) -> dict:
    try:
        send_params = SendMessageParams.model_validate(params)
    except Exception as exc:  # noqa: BLE001 — JSON-RPC InvalidParamsError로 매핑
        raise _JsonRpcException(_INVALID_PARAMS, f"Invalid params: {exc}") from exc

    incoming = send_params.message
    text = _first_text(incoming)

    # E-A2A-EXT project-context(profile, opt-in): 클라가 A2A-Extensions 헤더로 이 URI를
    # 선언했고 Message.metadata에 그 키가 있으면 구조화 컨텍스트를 보존한다. 미선언 시
    # 이 블록 전체가 스킵돼 기존 동작과 완전히 동일(무회귀).
    project_context = None
    if PROJECT_CONTEXT_EXTENSION_URI in active_extensions and incoming.metadata:
        project_context = incoming.metadata.get(PROJECT_CONTEXT_EXTENSION_URI)

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

    # 완료 라운드트립 크럭스(story ebd5cf18, 문서 `a2a-task-completion-roundtrip-crux`, PO GO
    # 2026-07-08): 완료 신호(=이 메시지 스레드에 답신)는 실동작하는 메커니즘이나(실측 GREEN),
    # delegate 가 reply-target(root_message_id)을 전달 페이로드에서 알아낼 길이 없었다(webhook
    # 경로는 Discord 렌더러가 그 필드를 안 읽음·fakechat 클라 노출 여부도 레포 밖이라 불확定).
    # 채널-불가지 근본 fix: delegate 가 실제로 받는 content 자체에 완료 프로토콜을 박아넣는다 —
    # 두 전달 경로(webhook/fakechat)가 이 문자열을 공유하므로 매체와 무관하게 항상 도달한다.
    # `history`(원본 client 메시지, `incoming.model_dump()`)는 안 건드려 A2A 관찰가능성 무회귀.
    completion_hint = (
        "\n\n---\n[A2A] 이 task의 완료 신호는 이 메시지 스레드에 대한 답신입니다.\n"
        f"reply_thread_id: {root_message_id}\n"
        f"conversation_id: {conv_id}\n"
        "완료 시 sprintable_send_chat_message(thread_id=conversation_id, "
        "reply_thread_id=reply_thread_id, content=<결과>)로 회신하세요."
    )
    delivered_content = text + completion_hint

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
        content=delivered_content,
        thread_id=None,
        created_at=now,
    ))
    await session.flush()
    await session.commit()

    task_metadata: dict = {"delivery_channel": "webhook" if has_webhook else "fakechat_ws"}
    if active_extensions:
        task_metadata["activated_extensions"] = sorted(active_extensions)
    if project_context is not None:
        task_metadata["project_context"] = project_context

    if has_webhook:
        # ⚠️스코프 경계(E-A2A-EXT 첫 착수, 의도적): deliver_conversation_message_webhook은
        # 다른 conversation 경로들과 공유하는 함수라 content(plain text)만 받는다 — 구조화
        # project_context를 이 경로까지 실어보내려면 그 공유 함수의 계약 자체를 넓혀야 해서
        # 첫 extension 스코프를 넘어선다(과설계 회피). webhook 경로는 CC에 텍스트만 전달되고,
        # project_context는 task_metadata(GetTask로 조회 가능)에만 보존된다 — fakechat 경로만
        # CC 전달 payload에도 포함(아래).
        await deliver_conversation_message_webhook(
            message_id=root_message_id,
            conversation_id=conv_id,
            org_id=member_org_id,
            project_id=member_project_id,
            sender_id=None,
            thread_id=None,
            created_at=now,
            mentioned_ids=None,
            content=delivered_content,
            targets=None,
        )
    else:
        # fakechat 경로 — 헤드라인 fix(2026-07-06, PO 크럭스 `a2a-headline-sse-reroute-crux`):
        # 이전엔 ws_chat._broadcast(WS /ws/chat/{agent_id} room)로 push했으나, 실 CC-side fakechat
        # 플러그인(packages/fakechat/server.ts)이 2026-06-02(26f9cb76)부로 그 WS hub를 안 쓰고
        # /agent/stream SSE dial-out으로 전환됐음이 그라운딩으로 드러남 — 그 room의 유일한 실
        # 소비자는 브라우저 사람 UI뿐이라 무-webhook 에이전트에게 보낸 A2A task는 항상 실시간
        # 유실→타임아웃 FAILED였다. 이제 CC가 실제로 구독 중인 Event/agent_gateway SSE 파이프라인에
        # 편승한다: Event(event_type 자유 문자열 — /agent/stream이 필터 안 함) 생성→flush→
        # assign_recipient_seq(같은 트랜잭션, flush 後·commit 前 필수)→commit→wake_agent(즉시 push,
        # 미접속이어도 Event는 영속돼 재연결 backfill로 여전히 도달 — 최종 안전망은 기존
        # A2A_TASK_TIMEOUT_MINUTES 백스톱).
        event_payload = {
            "message_id": str(root_message_id),
            "conversation_id": str(conv_id),
            "content": delivered_content,
        }
        if project_context is not None:
            event_payload["project_context"] = project_context
        event = Event(
            project_id=member_project_id,
            org_id=member_org_id,
            event_type="a2a.task_message",
            recipient_id=member_id,
            recipient_type="agent",
            sender_id=None,
            payload=event_payload,
            status="pending",
        )
        session.add(event)
        await session.flush()
        recipient_seq = await assign_recipient_seq(session, event)
        await session.commit()
        # "미연결" 신호(P1-S2 C 유지) — 죽은 ws_chat._rooms 대신 agent_gateway의 실제 SSE 연결
        # 큐(_agent_connections)로 판정해야 "지금 CC가 진짜 붙어있나"를 뜻한다.
        task_metadata["connected_at_send"] = str(member_id) in _agent_connections
        wake_agent(str(member_id), recipient_seq)

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
        # S-A1(story 2a57dc0f): 생성 시점에 명시 기록 — cron 스위퍼가 폴링과 무관하게 판정.
        deadline_at=now + timedelta(minutes=A2A_TASK_TIMEOUT_MINUTES),
    ))
    await session.flush()
    await session.commit()

    task = (await session.execute(
        select(A2ATask).where(A2ATask.id == task_id)
    )).scalar_one()
    # 스펙(a2a.proto `rpc SendMessage(...) returns (SendMessageResponse)`) — result는 bare Task가
    # 아니라 oneof 래퍼(`{"task": ...}` | `{"message": ...}`). GetTask/ListTasks와 달리(그쪽은
    # 스펙상 bare Task/Task[] 리턴이 맞음) SendMessage만 이 래퍼가 필요 — 없으면 실 SDK 클라이언트
    # 파서가 깨진다(a2a-sdk 라이브 실측, story 52bb1975 후속).
    return {"task": _task_to_dict(task)}


async def _advance_task_state(session: AsyncSession, task: A2ATask, org_id: uuid.UUID) -> A2ATask:
    """GetTask의 반응형 상태-전이 판정 — S-A4(story 03034d86)에서 스트리밍 폴링 루프가 재사용
    할 수 있도록 JSON-RPC 래핑에서 분리했다(GetTask도 동일 함수 호출 — 판정 규칙 이원화 방지).

    HITL crux(story 7726a003, 문서 `a2a-hitl-input-auth-required-mapping-crux`, PO GO 승인
    2026-07-07, 옵션 B): reader만 배선 — writer(task_metadata.linked_gate_id 기록)는 S-A3
    (story 6d0454c3)이 닫았다. WORKING 에서만 판정(INPUT_REQUIRED/AUTH_REQUIRED 재진입 시
    재판정 없음 — 복귀는 transition_gate()의 전담 책임, 여기서 낙관적으로 되돌리지 않는다).

    S-A5(story c140977f): `linked_gate_reason=="auth"`로 명시 선언된 경우만
    TASK_STATE_AUTH_REQUIRED, 그 외(선언 없음 또는 다른 이유)는 기존과 동일 INPUT_REQUIRED —
    크럭스 판정 유지(auth-pending **자동 감지**는 실신호 0이라 배제, 명시 선언만 유효 신호)."""
    if task.state == "TASK_STATE_WORKING":
        linked_gate_id = (task.task_metadata or {}).get("linked_gate_id")
        if linked_gate_id is not None:
            gate = (await session.execute(
                select(Gate).where(Gate.id == uuid.UUID(linked_gate_id), Gate.org_id == org_id)
            )).scalar_one_or_none()
            if gate is not None and gate.status == "pending":
                linked_gate_reason = (task.task_metadata or {}).get("linked_gate_reason")
                task.state = (
                    "TASK_STATE_AUTH_REQUIRED" if linked_gate_reason == "auth"
                    else "TASK_STATE_INPUT_REQUIRED"
                )
                await session.flush()
                await session.commit()
                await session.refresh(task)
                return task

    if task.state == "TASK_STATE_WORKING" and task.root_message_id is not None:
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
            #
            # 까심 크로스모델 QA(story 652c2842) — "최신 1건"이 아니라 **그 메시지의 전 delivery**를
            # 봐야 한다: multi-webhook 멤버(웹훅 2개 이상)는 메시지당 delivery 행이 webhook_config
            # 개수만큼 생기고, 그중 하나만 우연히 실패해도 "최신"이 그 실패행이면 다른 채널로는
            # 실제 도달했음에도 거짓 FAILED가 났다(task bd4a6c0b 재현 케이스). 전량 실패일 때만
            # FAILED로 승격 — 하나라도 delivered면 이 판정에서는 실패 아님(응답 대기 지속).
            failure_reason: str | None = None

            deliveries = (await session.execute(
                select(ConversationWebhookDelivery)
                .where(ConversationWebhookDelivery.message_id == task.root_message_id)
                .order_by(ConversationWebhookDelivery.created_at.desc())
            )).scalars().all()
            if deliveries and all(d.status == "failed" for d in deliveries):
                latest = deliveries[0]
                failure_reason = (
                    f"webhook delivery failed on all {len(deliveries)} channel(s) after "
                    f"{latest.attempt_count} attempts: {latest.last_error or 'unknown error'}"
                )
            elif datetime.now(timezone.utc) > effective_deadline(task):
                failure_reason = (
                    f"timed out waiting for agent response after {A2A_TASK_TIMEOUT_MINUTES}m"
                )

            if failure_reason is not None:
                # S-A1(story 2a57dc0f): 스위퍼와 동일 SSOT + CAS(까심 QA HIGH C fix) — 이
                # 함수가 읽은 task는 이 시점엔 stale일 수 있다(사이에 스위퍼/AC2 훅이 먼저
                # 전이시켰을 수 있음). CAS UPDATE가 그 경합을 흡수하고, 결과와 무관하게
                # refresh로 DB의 진짜 현재 상태를 반영한다(이미 다른 경로가 이겼으면 그 결과
                # 그대로 반환 — stale WORKING 기준으로 덮어쓰지 않는다).
                await fail_task_if_still_working(session, task.id, failure_reason)
                await session.commit()
                await session.refresh(task)

    return task


async def _handle_get_task(
    session: AsyncSession, member: TeamMember, params: dict,
    active_extensions: frozenset[str] = frozenset(),  # noqa: ARG001 — 균일 dispatch 시그니처, 현재 미사용
) -> dict:
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

    task = await _advance_task_state(session, task, member.org_id)
    return _task_to_dict(task)


_DEFAULT_PAGE_SIZE = 50
_MAX_PAGE_SIZE = 100


async def _handle_list_tasks(
    session: AsyncSession, member: TeamMember, params: dict,
    active_extensions: frozenset[str] = frozenset(),  # noqa: ARG001 — 균일 dispatch 시그니처, 현재 미사용
) -> dict:
    """E-A2A-PROTO P1(story 미배정): ListTasksRequest 필수 필터만 구현(PoC) — tenant·
    status_timestamp_after·history_length·include_artifacts는 REQUIRED 아니라 생략.
    스코프는 GetTask와 동형으로 caller가 위임한 member 자신의 task만(`A2ATask.member_id`)."""
    try:
        list_params = ListTasksParams.model_validate(params)
    except Exception as exc:  # noqa: BLE001
        raise _JsonRpcException(_INVALID_PARAMS, f"Invalid params: {exc}") from exc

    page_size = list_params.page_size or _DEFAULT_PAGE_SIZE
    page_size = max(1, min(page_size, _MAX_PAGE_SIZE))
    offset = 0
    if list_params.page_token:
        try:
            offset = max(0, int(list_params.page_token))
        except ValueError as exc:
            raise _JsonRpcException(_INVALID_PARAMS, "Invalid pageToken") from exc

    conditions = [A2ATask.member_id == member.id]
    if list_params.context_id is not None:
        conditions.append(A2ATask.context_id == uuid.UUID(list_params.context_id))
    if list_params.status is not None:
        conditions.append(A2ATask.state == list_params.status)

    total_size = (await session.execute(
        select(func.count()).select_from(A2ATask).where(*conditions)
    )).scalar_one()

    result = await session.execute(
        select(A2ATask).where(*conditions).order_by(A2ATask.created_at.desc(), A2ATask.id.desc())
        .offset(offset).limit(page_size)
    )
    tasks = result.scalars().all()

    next_offset = offset + len(tasks)
    next_page_token = str(next_offset) if next_offset < total_size else ""

    return {
        "tasks": [_task_to_dict(t) for t in tasks],
        "nextPageToken": next_page_token,
        "pageSize": page_size,
        "totalSize": total_size,
    }


_METHODS = {
    "SendMessage": _handle_send_message,
    "GetTask": _handle_get_task,
    "ListTasks": _handle_list_tasks,
}

# S-A4(story 03034d86): 폴링 간격 — 기존 상태전이 로직(_advance_task_state)을 이 주기로
# 재호출해 변화를 감시한다(신규 브로커/큐 불요, GetTask 로직 그대로 재사용).
_STREAM_POLL_INTERVAL_SECONDS = 2.0


def _sse_frame(request_id: str | int | None, result: dict) -> str:
    """실 SDK(`JsonRpcTransport._send_stream_request`) 실측 계약 — 각 `data:` 라인이 완결된
    JSON-RPC 2.0 envelope이어야 `StreamResponse` oneof로 파싱된다(`json_format.ParseDict`
    직접 검증 완료: `task`/`statusUpdate`/`artifactUpdate` 카멜케이스 확認)."""
    envelope = {"jsonrpc": "2.0", "id": request_id, "result": result}
    return f"data: {json.dumps(envelope)}\n\n"


async def _stream_send_message(
    request: Request, request_id: str | int | None,
    session: AsyncSession, member: TeamMember, org_id: uuid.UUID, params: dict,
    active_extensions: frozenset[str],
) -> StreamingResponse:
    """S-A4 AC1: `SendStreamingMessage` — task 생성(기존 `_handle_send_message` 그대로 재사용)
    확인 프레임 → 상태 변화 폴링(기존 `_advance_task_state`, GetTask와 100% 동일 규칙) →
    터미널 도달 시 artifact + 최종 status 프레임 후 스트림 종료(커넥션 close = 실 SDK에게
    "끝" 신호, 별도 `final` 필드 불요 — 이 SDK 버전 스키마 실측 확認).

    커넥션 수명 동안 주입받은 `session`(request-scoped `get_db`)을 계속 쓰지 않는다 — 장수명
    SSE가 커넥션을 오래 점유하는 문제(기존 `/agent/stream` 주석과 동일 근거)를 피하려 task
    생성 직후 명시적으로 close하고, 폴링 루프는 매 tick마다 `async_session_factory()`로 짧게
    여닫는다(AsyncSession.close()는 멱등이라 FastAPI의 get_db teardown이 나중에 또 불러도 안전)."""
    send_result = await _handle_send_message(session, member, params, active_extensions)
    await session.close()  # 장수명 스트림 동안 request-scoped 커넥션 점유 방지(멱등 close).

    task_id = uuid.UUID(send_result["task"]["id"])
    member_id = member.id

    async def generate():
        yield _sse_frame(request_id, {"task": send_result["task"]})

        last_state: str | None = send_result["task"]["status"]["state"]
        while not await request.is_disconnected():
            async with async_session_factory() as db:
                result = await db.execute(
                    select(A2ATask).where(A2ATask.id == task_id, A2ATask.member_id == member_id)
                )
                task = result.scalar_one_or_none()
                if task is None:
                    return  # task 삭제 등 이상계 — 조용히 스트림 종료(방어적, 정상 경로 아님)

                task = await _advance_task_state(db, task, org_id)
                current_dict = _task_to_dict(task)

            if task.state != last_state:
                yield _sse_frame(request_id, {
                    "statusUpdate": {
                        "taskId": current_dict["id"],
                        "contextId": current_dict["contextId"],
                        "status": current_dict["status"],
                    },
                })
                last_state = task.state

            if task.state in _TERMINAL_STATES:
                for artifact in current_dict.get("artifacts", []):
                    yield _sse_frame(request_id, {
                        "artifactUpdate": {
                            "taskId": current_dict["id"],
                            "contextId": current_dict["contextId"],
                            "artifact": artifact,
                        },
                    })
                return  # 커넥션 close = 종료 신호(이 SDK 스키마엔 별도 final 필드 없음, 실측)

            await asyncio.sleep(_STREAM_POLL_INTERVAL_SECONDS)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.post("/members/{member_id}/rpc", response_model=None)
async def a2a_rpc(
    request: Request,
    member_id: uuid.UUID,
    body: JsonRpcRequest,
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JsonRpcResponse | StreamingResponse:
    """P1-S2: action-triggering 엔드포인트라 authed+org-scoped(PO 크럭스 — S1 PoC 리스크 노트
    봉인). Card fetch(GET .../agent-card.json)는 P1-S1 판단대로 unauth 유지, 여기만 인증."""
    version_header = request.headers.get("A2A-Version")
    if version_header:
        major = version_header.split(".", 1)[0]
        if major != A2A_PROTOCOL_VERSION.split(".", 1)[0]:
            return JsonRpcResponse(
                id=body.id,
                error=JsonRpcError(
                    code=_VERSION_NOT_SUPPORTED,
                    message=f"Unsupported A2A-Version: {version_header} (server supports {A2A_PROTOCOL_VERSION})",
                ),
            )

    member = await _get_agent_member(session, member_id, org_id, auth)
    active_extensions = _parse_active_extensions(request)

    # S-A4(story 03034d86): 유일하게 StreamingResponse를 반환하는 메소드 — 나머지 3개와
    # 응답 타입 자체가 달라(JsonRpcResponse 단일 vs SSE) 균일 _METHODS 디스패치에 안 넣고
    # 여기서 조기 분기한다.
    if body.method == "SendStreamingMessage":
        try:
            return await _stream_send_message(
                request, body.id, session, member, org_id, body.params or {}, active_extensions,
            )
        except _JsonRpcException as exc:
            return JsonRpcResponse(id=body.id, error=JsonRpcError(code=exc.code, message=exc.message))

    handler = _METHODS.get(body.method)
    if handler is None:
        return JsonRpcResponse(
            id=body.id,
            error=JsonRpcError(code=_METHOD_NOT_FOUND, message=f"Method not found: {body.method}"),
        )

    try:
        result = await handler(session, member, body.params or {}, active_extensions)
    except _JsonRpcException as exc:
        return JsonRpcResponse(id=body.id, error=JsonRpcError(code=exc.code, message=exc.message))

    return JsonRpcResponse(id=body.id, result=result)


_VALID_LINK_GATE_REASONS = frozenset({"auth"})


class LinkGateBody(BaseModel):
    gate_id: uuid.UUID
    # S-A5(story c140977f): reason="auth" 는 "외부 크리덴셜 필요"의 명시 선언 — reader가
    # TASK_STATE_AUTH_REQUIRED로 전이시키는 유일한 신호원(자동 감지는 크럭스가 배제한 죽은
    # 배선). 미지정(None) = 기존 S-A3 동작(INPUT_REQUIRED) 그대로, 무회귀.
    reason: str | None = None


@router.post("/tasks/{task_id}/link-gate")
async def link_gate_to_task(
    task_id: uuid.UUID,
    body: LinkGateBody,
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """E-A2A-완성 S-A3(story `6d0454c3`, 크럭스 `a2a-hitl-input-auth-required-mapping-crux`
    옵션 B — writer) + S-A5(story `c140977f`, auth 변형): delegate가 "이 gate가 이 A2A task를
    블록한다"를 **명시 선언**한다. reader(``_advance_task_state``의 ``linked_gate_id``/
    ``linked_gate_reason`` 체크)와 복귀 트리거(``gate_service.py::transition_gate`` 3번째
    분기)는 이 필드가 채워지길 그저 기다리고 있었을 뿐 — 이 엔드포인트가 그 유일한 writer다.

    6개 ``create_gate()`` 호출지점에 conversation_id/task_id를 관통시키는 침습 배관(크럭스
    옵션 A)은 의도적으로 배제 — delegate가 자기 MCP 세션에서 이미 알고 있는 두 id(task_id는
    SendMessage 응답에서, gate_id는 방금 자기가 만든 gate 응답에서)를 스스로 연결하는 경량
    선언만 추가한다.

    self-scope 게이트(``assert_caller_is_member`` 동형) — task.member_id 본인만 자기 task에
    링크 선언 가능(다른 에이전트의 task를 가로채 임의 gate로 블록시키는 것 방지)."""
    if body.reason is not None and body.reason not in _VALID_LINK_GATE_REASONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported reason: {body.reason!r} (supported: {sorted(_VALID_LINK_GATE_REASONS)})",
        )

    task = (await session.execute(
        select(A2ATask).where(A2ATask.id == task_id)
    )).scalar_one_or_none()
    if task is None:
        raise HTTPException(status_code=404, detail="A2A task not found")

    if str(task.member_id) != auth.user_id:
        raise HTTPException(status_code=403, detail="Cannot link a gate to another agent's task")

    if task.state != "TASK_STATE_WORKING":
        raise HTTPException(
            status_code=400,
            detail=f"Task must be WORKING to link a gate (current: {task.state})",
        )

    gate = (await session.execute(
        select(Gate).where(Gate.id == body.gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")

    task_metadata = {**(task.task_metadata or {}), "linked_gate_id": str(gate.id)}
    if body.reason is not None:
        task_metadata["linked_gate_reason"] = body.reason
    task.task_metadata = task_metadata
    await session.flush()
    await session.commit()

    return {"linked": True, "task_id": str(task.id), "gate_id": str(gate.id), "reason": body.reason}
