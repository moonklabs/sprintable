"""story #3143(9a5abc24, Chat ②층·P1·BE) — 서버 집행 커맨드 카탈로그+집행기.

doc `chat-action-messages-round1-draft`(v6) §"서버 집행 커맨드" 확定분 — 결정적 엔티티
조작(3종: /done·/assign·/priority)만 서버가 `command_classifier.classify_command()` 결과를
직접 집행한다. 새 파서·새 권한 층 발명 0:

- 판정: 기존 `classify_command()`(S3) 결과의 ``name``이 이 모듈의 ``CATALOG``에 정확히
  일치할 때만 진입(미명중은 호출자가 기존 경로 그대로 진행 — 회귀 0).
- 권한: 발신자의 **기존 API 권한 그대로** — `app.routers.stories`의 `update_story_status`/
  `update_story` 엔드포인트 함수를 in-process로 그대로 호출한다(재구현 0, 새 권한 판정
  없음). HTTP 요청 컨텍스트가 없는 자리에서 엔드포인트를 부르는 관용구는
  `app.routers.events.publish_preset_event`가 이미 쓰는 패턴과 동형 — 자체
  ``BackgroundTasks()``를 만들어 호출 직후 수동 실행한다.
- 발신자→합성 AuthContext 매핑: `has_project_access`(project_auth.py)의 human 분기가
  ``TeamMember.id == user_id OR TeamMember.user_id == user_id`` 양쪽을 다 받아주므로,
  human 발신자는 raw `users.id`(ResolvedMember.user_id/TeamMember.user_id)를, agent
  발신자는 자기 team_member.id를 그대로 `auth.user_id`에 실으면 실제 JWT/API-key 인증
  경로와 동일한 권한 판정이 그대로 재현된다.
- 결과 회신: `message_kind="result"` + 자연어 본문(story #5c29454b 3존 카드 레일 —
  ``deriveVerdictTone``의 성공/실패 어휘(완료/승인 vs 반려/FAIL)와 ``extractNextAction``의
  「다음: ...」 구분자를 그대로 태운다. **새 JSON 스키마를 만들지 않는다** — 그 레일은
  순수 텍스트 렌더 변환이라 서버는 잘 쓰인 평문만 내보내면 된다).
- 감사: 성공/실패(권한거부·미존재·모호·인자오류) 전 건을 `ChatCommandAuditLog`에 기록.
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from typing import Awaitable, Callable

from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext
from app.models.chat_command_audit_log import ChatCommandAuditLog
from app.models.conversation import Conversation, ConversationMessage
from app.models.pm import Story
from app.models.team import TeamMember
from app.services.command_classifier import CommandCandidate

logger = logging.getLogger(__name__)

VALID_PRIORITIES = ("critical", "high", "medium", "low")

# args 맨 앞이 entity mention 토큰(`[라벨](entity:story:uuid)`)이면 그대로 통째로 매치 —
# mention_parser.py의 `_CHAT_TOKEN_RE`와 동일 모양(그 정규식은 모듈 private이라 새로 못
# 불러온다 — 토큰 문법 자체가 이 코드베이스 전역 SSOT라 재정의는 이 상수 하나뿐, 매치
# 실패 시엔 아래 bare-number 분기로 자연 폴백한다).
_STORY_MENTION_PREFIX_RE = re.compile(
    r"^\[(?:[^\]\\]|\\.)*\]\(entity:story:([0-9a-fA-F-]{36})\)\s*(.*)$", re.DOTALL,
)


def _split_first_arg(args: str) -> tuple[str, str]:
    """args 맨 앞 토큰(story 참조)과 나머지를 가른다. entity mention 토큰은 내부에 공백이
    있어도 통째로 하나의 토큰 — 단순 whitespace split이면 라벨 중간에서 잘린다."""
    m = _STORY_MENTION_PREFIX_RE.match(args)
    if m:
        return f"[](entity:story:{m.group(1)})", m.group(2).strip()
    parts = args.split(maxsplit=1)
    if not parts:
        return "", ""
    return parts[0], parts[1].strip() if len(parts) > 1 else ""


async def _resolve_story_id(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, ref: str,
) -> uuid.UUID | None:
    """story 참조 토큰(bare 번호 또는 entity mention)을 story.id로 해소. 형식 자체가
    해석 불가면 None(invalid_args) — 존재/프로젝트 소속 여부는 호출자가 실행 시점에
    (update_story*의 기존 404) 판정하므로 여기서 별도 존재 검증을 하지 않는다."""
    m = re.match(r"^\[\]\(entity:story:([0-9a-fA-F-]{36})\)$", ref)
    if m:
        return uuid.UUID(m.group(1))
    bare = ref.lstrip("#")
    if not bare.isdigit():
        return None
    story_number = int(bare)
    row = (await db.execute(
        select(Story.id).where(
            Story.org_id == org_id, Story.project_id == project_id,
            Story.story_number == story_number,
        )
    )).scalar_one_or_none()
    return row


@dataclass
class MemberMatch:
    member: TeamMember | None
    candidates: list[TeamMember]


async def _resolve_member_by_query(
    db: AsyncSession, *, project_id: uuid.UUID, query: str,
) -> MemberMatch:
    """정확명(대소문자 무시) 우선, 없으면 유일 prefix. 0건/모호(2건 이상)는 candidates로
    구분(len(candidates)==0 → 대상 없음, >=2 → 모호)."""
    q = query.strip().lower()
    if not q:
        return MemberMatch(None, [])
    rows = list((await db.execute(
        select(TeamMember).where(TeamMember.project_id == project_id, TeamMember.is_active.is_(True))
    )).scalars().all())
    exact = [m for m in rows if m.name.lower() == q]
    if len(exact) == 1:
        return MemberMatch(exact[0], [])
    if len(exact) > 1:
        return MemberMatch(None, exact)
    prefix = [m for m in rows if m.name.lower().startswith(q)]
    if len(prefix) == 1:
        return MemberMatch(prefix[0], [])
    return MemberMatch(None, prefix)


def _synthetic_auth_for_sender(sender, org_id: uuid.UUID) -> AuthContext:
    """발신자 신원 → 합성 AuthContext. `require_project_access`/`has_project_access`가
    human 축을 ``TeamMember.id == user_id OR TeamMember.user_id == user_id`` 양쪽으로
    받아주므로(project_auth.py `_project_access_predicate`), human은 raw users.id를,
    agent는 자기 team_member.id를 그대로 실으면 실제 인증 경로와 동일 권한이 재현된다."""
    sender_type = getattr(sender, "type", None)
    if sender_type == "agent":
        return AuthContext(
            user_id=str(sender.id), email=None,
            claims={"app_metadata": {"api_key_id": "chat-server-command"}}, org_id=str(org_id),
        )
    user_id = getattr(sender, "user_id", None) or sender.id
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))


def _denial_reason(exc: HTTPException) -> str:
    detail = exc.detail
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("code") or detail)
    return str(detail)


async def _call_endpoint_in_process(
    fn: Callable[..., Awaitable], /, **kwargs,
) -> tuple[object | None, HTTPException | None]:
    """HTTP 요청 컨텍스트 밖에서 엔드포인트 함수를 그대로 부른다 — BackgroundTasks() 자체
    생성+수동 실행 관용구는 `app.routers.events.publish_preset_event`와 동형(재발명 0)."""
    background_tasks = BackgroundTasks()
    try:
        result = await fn(background_tasks=background_tasks, **kwargs)
    except HTTPException as exc:
        return None, exc
    await background_tasks()
    return result, None


@dataclass
class CommandOutcome:
    outcome: str  # executed | denied | not_found | ambiguous | invalid_args
    reply_content: str
    target_type: str | None = None
    target_id: uuid.UUID | None = None
    before_value: str | None = None
    after_value: str | None = None
    reason: str | None = None
    # story #3143 PO 리뷰 델타 2회차(2026-08-27, 미르코 FE 정독 적출) — ambiguous outcome
    # 전용. reply_content의 comma-join 문장만으론 FE가 후보 행(클릭→입력창 채움)을 만들려면
    # 문장 파싱을 해야 해 server_command 식별자를 세운 취지와 모순됐다. 멤버 이름 문자열
    # 배열만(id는 재조회 없이 이름→서버 재검증이 이미 /assign 재호출 경로라 불필요 — 이
    # 필드는 "무엇을 다시 물어봤는지"만 보여준다).
    candidates: list[str] | None = None


async def _execute_done(
    db: AsyncSession, *, org_id: uuid.UUID, auth: AuthContext, candidate: CommandCandidate,
    project_id: uuid.UUID,
) -> CommandOutcome:
    ref, _rest = _split_first_arg(candidate.args)
    if not ref:
        return CommandOutcome("invalid_args", "'/done' 사용법: `/done <스토리#>`", reason="missing_story_ref")
    story_id = await _resolve_story_id(db, org_id=org_id, project_id=project_id, ref=ref)
    if story_id is None:
        return CommandOutcome("invalid_args", f"'/done' 실패 — 스토리 참조를 해석할 수 없습니다: `{ref}`", reason="unparseable_story_ref")

    before = (await db.execute(select(Story.status).where(Story.id == story_id))).scalar_one_or_none()

    from app.repositories.story import StoryRepository
    from app.routers.stories import StoryStatusUpdate, update_story_status

    resp, exc = await _call_endpoint_in_process(
        update_story_status, id=story_id, body=StoryStatusUpdate(status="done"),
        repo=StoryRepository(db, org_id), db=db, auth=auth,
    )
    if exc is not None:
        outcome = "not_found" if exc.status_code == 404 else "denied"
        return CommandOutcome(outcome, f"'/done' 실패 — {_denial_reason(exc)}", target_type="story", target_id=story_id, before_value=before, reason=_denial_reason(exc))
    return CommandOutcome(
        "executed", f"'/done' 완료 — 스토리가 done으로 전이됐습니다.\n다음: 결과를 확인하세요.",
        target_type="story", target_id=story_id, before_value=before, after_value="done",
    )


async def _execute_priority(
    db: AsyncSession, *, org_id: uuid.UUID, auth: AuthContext, candidate: CommandCandidate,
    project_id: uuid.UUID,
) -> CommandOutcome:
    ref, rest = _split_first_arg(candidate.args)
    if not ref or not rest:
        return CommandOutcome("invalid_args", "'/priority' 사용법: `/priority <스토리#> <critical|high|medium|low>`", reason="missing_args")
    level = rest.split(maxsplit=1)[0].strip().lower()
    if level not in VALID_PRIORITIES:
        return CommandOutcome("invalid_args", f"'/priority' 실패 — 알 수 없는 우선순위: `{level}` (critical/high/medium/low 중 하나)", reason="invalid_priority_level")
    story_id = await _resolve_story_id(db, org_id=org_id, project_id=project_id, ref=ref)
    if story_id is None:
        return CommandOutcome("invalid_args", f"'/priority' 실패 — 스토리 참조를 해석할 수 없습니다: `{ref}`", reason="unparseable_story_ref")

    before = (await db.execute(select(Story.priority).where(Story.id == story_id))).scalar_one_or_none()

    from app.repositories.story import StoryRepository
    from app.routers.stories import StoryUpdate, update_story

    resp, exc = await _call_endpoint_in_process(
        update_story, id=story_id, body=StoryUpdate(priority=level),
        repo=StoryRepository(db, org_id), db=db, auth=auth,
    )
    if exc is not None:
        outcome = "not_found" if exc.status_code == 404 else "denied"
        return CommandOutcome(outcome, f"'/priority' 실패 — {_denial_reason(exc)}", target_type="story", target_id=story_id, before_value=before, reason=_denial_reason(exc))
    return CommandOutcome(
        "executed", f"'/priority' 완료 — 우선순위가 {before}에서 {level}로 변경됐습니다.\n다음: 결과를 확인하세요.",
        target_type="story", target_id=story_id, before_value=before, after_value=level,
    )


async def _execute_assign(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, auth: AuthContext, candidate: CommandCandidate,
) -> CommandOutcome:
    ref, rest = _split_first_arg(candidate.args)
    if not ref or not rest:
        return CommandOutcome("invalid_args", "'/assign' 사용법: `/assign <스토리#> <멤버명>`", reason="missing_args")
    story_id = await _resolve_story_id(db, org_id=org_id, project_id=project_id, ref=ref)
    if story_id is None:
        return CommandOutcome("invalid_args", f"'/assign' 실패 — 스토리 참조를 해석할 수 없습니다: `{ref}`", reason="unparseable_story_ref")

    match = await _resolve_member_by_query(db, project_id=project_id, query=rest)
    if match.member is None:
        if match.candidates:
            candidate_names = [m.name for m in match.candidates]
            names = ", ".join(candidate_names)
            return CommandOutcome("ambiguous", f"'/assign' 실패 — 「{rest}」에 일치하는 멤버가 여럿입니다: {names} (정확한 이름을 입력하세요)", target_type="story", target_id=story_id, reason="ambiguous_member", candidates=candidate_names)
        return CommandOutcome("not_found", f"'/assign' 실패 — 「{rest}」에 일치하는 멤버를 찾을 수 없습니다.", target_type="story", target_id=story_id, reason="member_not_found")

    before = (await db.execute(select(Story.assignee_id).where(Story.id == story_id))).scalar_one_or_none()

    from app.repositories.story import StoryRepository
    from app.routers.stories import StoryUpdate, update_story

    resp, exc = await _call_endpoint_in_process(
        update_story, id=story_id, body=StoryUpdate(assignee_ids=[match.member.id]),
        repo=StoryRepository(db, org_id), db=db, auth=auth,
    )
    if exc is not None:
        outcome = "not_found" if exc.status_code == 404 else "denied"
        return CommandOutcome(outcome, f"'/assign' 실패 — {_denial_reason(exc)}", target_type="story", target_id=story_id, before_value=str(before) if before else None, reason=_denial_reason(exc))
    return CommandOutcome(
        "executed", f"'/assign' 완료 — {match.member.name}에게 배정됐습니다.\n다음: 결과를 확인하세요.",
        target_type="story", target_id=story_id, before_value=str(before) if before else None, after_value=str(match.member.id),
    )


CATALOG: dict[str, Callable] = {"done": _execute_done, "assign": _execute_assign, "priority": _execute_priority}


async def try_execute_server_command(
    db: AsyncSession, *, org_id: uuid.UUID, conv: Conversation, msg: ConversationMessage, sender,
) -> bool:
    """카탈로그 명중이면 집행+감사+결과카드까지 전부 처리하고 True. 미명중(카탈로그 밖
    커맨드·비-커맨드 메시지)이면 아무것도 안 하고 False — 호출자는 기존 경로(capability
    gate·에이전트-매개)를 그대로 진행한다(회귀 0). `_command_capability_gate`와 동형으로
    이 함수 자신이 `classify_command()`를 부른다(판정은 이 모듈이 새로 안 하고 그대로
    재사용 — 호출부가 후보를 이중 스레딩할 필요 없음)."""
    from app.services.command_classifier import classify_command

    candidate = classify_command(msg.content)
    if candidate is None or candidate.name not in CATALOG or not conv.project_id:
        return False

    auth = _synthetic_auth_for_sender(sender, org_id)
    handler = CATALOG[candidate.name]
    try:
        if candidate.name == "assign":
            result = await handler(db, org_id=org_id, project_id=conv.project_id, auth=auth, candidate=candidate)
        else:
            result = await handler(db, org_id=org_id, auth=auth, candidate=candidate, project_id=conv.project_id)
    except Exception:  # noqa: BLE001 — 집행 실패가 메시지 전송 자체를 막으면 안 된다(best-effort 회신).
        logger.warning("서버 집행 커맨드 처리 중 예외 command=%s message=%s", candidate.name, msg.id, exc_info=True)
        result = CommandOutcome("denied", f"'/{candidate.name}' 처리 중 오류가 발생했습니다.", reason="internal_error")

    db.add(ChatCommandAuditLog(
        org_id=org_id, project_id=conv.project_id, conversation_id=conv.id, message_id=msg.id,
        actor_id=sender.id, actor_type=getattr(sender, "type", "human") or "human",
        command=candidate.name, raw_args=candidate.args,
        target_type=result.target_type, target_id=result.target_id, outcome=result.outcome,
        before_value=result.before_value, after_value=result.after_value, reason=result.reason,
    ))

    try:
        from app.routers.conversations import _dispatch_conversation_event
        from app.services.member_resolver import lookup_members_by_ids

        sender_resolved = (await lookup_members_by_ids({sender.id}, db)).get(sender.id)
        _server_command_meta: dict = {"command": candidate.name, "outcome": result.outcome}
        if result.candidates:
            # PO 리뷰 델타 2회차 — ambiguous일 때만. FE가 reply_content의 comma-join
            # 문장을 파싱하지 않고 이 배열로 클릭형 후보 행을 바로 그린다.
            _server_command_meta["candidates"] = result.candidates
        reply = ConversationMessage(
            conversation_id=conv.id, sender_id=sender.id, content=result.reply_content,
            mentioned_ids=[sender.id],
            msg_metadata={
                "activation": {"kind": "result", "audience": [str(sender.id)], "expects_response": False},
                # story #3143 PO 리뷰 델타 — FE(#92f00dc4, 유나 규격 ⚡배지+4상태)가 이
                # 카드를 텍스트 휴리스틱 없이 판별하는 기계 식별자. approval_target/event와
                # 동일 additive namespace 선례(conversations.py::_server_command_payload가
                # payload top-level로 노출).
                "server_command": _server_command_meta,
            },
        )
        db.add(reply)
        await db.flush()
        if sender_resolved is not None:
            await _dispatch_conversation_event(db, conv, reply, org_id, sender_resolved)
    except Exception:  # noqa: BLE001 — 회신 배달 실패가 집행 자체(이미 위에서 끝남)를 되돌리지 않는다.
        logger.warning("서버 집행 커맨드 결과 카드 배달 실패(비차단) command=%s message=%s", candidate.name, msg.id, exc_info=True)

    return True
