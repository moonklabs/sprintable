"""채팅 MCP 도구 (3개)."""
from __future__ import annotations

import logging
import re
from typing import Literal

from mcp.types import TextContent
from pydantic import Field, model_validator

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput
from .attachments import upload_attachments

logger = logging.getLogger(__name__)

# story 1995: `[title](entity:type:id) ` 토큰 구조를 변조하는 문자(`\ [ ] ( )`)를 escape.
# FE applyAsset()(chat-input.tsx ~L78-79)의 escape 로직 미러 — raw title에 `]`/`(`/`)`가 섞이면
# markdown-link 토큰 구조를 깨고 임의 링크를 위조할 수 있다(예: `x](https://phish)[y` →
# 렌더 시 phishing 링크로 탈바꿈). 개행은 토큰 한 줄 구조를 깨므로 공백으로 접는다.
_MENTION_TITLE_ESCAPE_RE = re.compile(r"[\\\[\]()]")
_MENTION_TITLE_NEWLINE_RE = re.compile(r"[\r\n]+")


def escape_mention_title(title: str) -> str:
    """agent-authored mention 토큰의 title을 escape — token-injection/forged-link 방지.

    FE `applyAsset()`(chat-input.tsx)와 동일 규칙을 Python으로 미러: `\\`, `[`, `]`, `(`, `)`를
    백슬래시로 escape하고, `\r`/`\n` 연속을 단일 공백으로 접는다. title이 caller 제공이든
    (agent가 임의 문자열 전달 가능) DB에서 fetch한 것이든(문서 제목에 임의 문자 가능) 동일하게
    적용해야 `[{title}](entity:doc:{id})` 토큰 구조가 깨지지 않는다.

    ⛔PO 지적(2026-07-28, #2585 리뷰): 이 함수가 여전히 「규칙이 둘인 자리」 하나를 남긴다 —
    title을 caller가 직접 지정하는 경로(`_resolve_mention_content`에서 `mention.title is not
    None`인 분기)는 백엔드 `build_reference_token`이 만들 토큰이 애초에 없다(그 문자열은 DB에
    없는 caller 전용 표시 문구이므로). 그래서 이 경로만은 어쩔 수 없이 로컬 escape를 계속 쓴다 —
    `_escape_title`(reference_token.py)과 규칙이 갈리면 다시 벌어질 자리로 표시해 둔다.
    """
    escaped = _MENTION_TITLE_ESCAPE_RE.sub(lambda m: "\\" + m.group(0), title)
    return _MENTION_TITLE_NEWLINE_RE.sub(" ", escaped)


# story #2283 후속(오르테가 라이브 실측, 2026-07-28): #2282가 만든 escape-aware 정규식은
# «escape된» `]`만 통과시키고 날것 `]`은 여전히 파서를 못 넘는다(설계상 유지 — greedy/lazy로
# 늘리면 토큰 경계가 모호해져 더 큰 사고를 부른다는 PO 판정). 그러니 "제목을 손으로 짜서
# 토큰 문자열을 만드는" 경로는 이 조직 명명 관례([TAG] 제목)에서 구조적으로 깨진다 — 정답은
# 손으로 안 짓고 **백엔드가 준 reference_token을 그대로 쓰는** 것(#2282 SSOT). doc만
# 지원하던 것을 story/epic까지 넓혀 «형제 비대칭»(FE만 안 깨지는 것)을 없앤다.
#
# ⛔story #2294(2026-07-28, 실제로 걸린 드리프트): task가 백엔드 ENTITY_RESOLVERS에 열렸는데
# 이 dict는 안 늘어 test_mention_entity_endpoints_match_backend_entity_resolvers가 develop
# HEAD에서 RED였다 — 서로 다른 두 PR이 각각은 옳은 변경이었는데 합쳐지며 이 축이 깨진
# "merge-order로만 드러나는" 드리프트였다(#2585는 #2294보다 먼저 작성돼 task를 몰랐다).
# ⛔B단계(2026-07-29): sprint·artifact·hypothesis도 같이 연다(GET /{id} 단건조회 엔드포인트가
# 실재해 title 미지정 mention의 auto-fetch가 가능함을 확認).
# ⛔C단계(story #2314, 2026-07-29): `evidence`도 연다 — GET /api/v2/evidence/{id}가 신설돼
# 그동안 「의도적 제외」였던 근거(단건조회 라우트 자체가 없음)가 사라졌다. evidence엔 title이
# 없어 reference_token은 ref를 대신 쓴다(evidence.py EvidenceResponse.reference_token 참조).
_MENTION_ENTITY_ENDPOINTS: dict[str, str] = {
    "doc": "/api/v2/docs/{id}",
    "story": "/api/v2/stories/{id}",
    "epic": "/api/v2/goals/{id}",
    "task": "/api/v2/tasks/{id}",
    "sprint": "/api/v2/sprints/{id}",
    "artifact": "/api/v2/visual-artifacts/{id}",
    "hypothesis": "/api/v2/hypotheses/{id}",
    "evidence": "/api/v2/evidence/{id}",
}


class MentionRef(SprintableInput):
    """agent 발신 채팅 메시지에 첨부할 entity mention — story 1995(doc 링크 안 됨 근본수정) +
    story #2283/#2294 후속(2026-07-28~29, doc→doc/story/epic/task/sprint/artifact/
    hypothesis 확장) + story #2314(2026-07-29, evidence 확장 — GET /{id} 단건조회 신설로
    「의도적 제외」 근거가 사라져 걷었다).

    type은 스키마 레벨에서 이 목록만 허용(Literal). MCP 서버는 백엔드 `app.*`를 import 하지
    않고 HTTP로만 통신하는 별도 프로세스라(api_client.py 참조) 이 목록을 백엔드
    `reference_registry.ENTITY_RESOLVERS`에서 런타임에 **파생시킬 수 없다** — 두 프로세스가
    같은 값을 손으로 맞춰 유지하는 수밖에 없는 자리다. 대신
    `test_mention_entity_endpoints_match_backend_entity_resolvers`가 **테스트로** 그 동일성을
    고정한다 — 백엔드 registry가 더 늘면 이 테스트가 빨개져서 여기(이 Literal +
    `_MENTION_ENTITY_ENDPOINTS`)도 늘리도록 강제한다.

    ⛔가드가 걸렸을 때 나올 수 있는 세 가지 반응 — 목록을 넓힌다 / 테스트를 고친다(또는
    느슨하게 한다) / 무시한다 — 중 첫 번째만 옳다. GET /{id}가 아예 없는 타입만 예외로, 이유와
    함께 명시 등재한다(조용히 빼지 않는다) — 지금은 그런 타입이 없다.
    """

    type: Literal["doc", "story", "epic", "task", "sprint", "artifact", "hypothesis", "evidence"]
    id: str
    title: str | None = None


class ConversationScopedInput(SprintableInput):
    """story #2427 — send/list/get_chat_message 셋이 요청은 `thread_id`로 받으면서 실제로는
    conversation_id를 뜻했다(URL 경로로 씀). 그런데 이 셋의 «응답」은 백엔드
    `_msg_payload()`(app/routers/conversations.py)가 매번 `conversation_id`·`thread_id`
    필드를 «둘 다» 싣는다 — 응답의 thread_id는 진짜 회신 스레드(nullable, 보통 null)라
    요청의 thread_id(=conversation)와 다른 것을 가리킨다. 같은 이름이 요청·응답에서
    다른 뜻이면, 응답을 보고 그 값을 그대로 다시 넣는 자연스러운 다음 행동이 조용히
    틀린 값을 보내게 된다 — 그게 이 결함의 정의였다(PO 판정, 2026-08-02).

    처방: 요청 쪽 정식 이름을 `conversation_id`로 맞춘다(응답이 이미 그 이름으로 준다).
    `thread_id`는 «폐기 예정 별칭»으로 한동안 받는다 — extra="forbid"(story #2412)와는
    안 부딪힌다(둘 다 «선언된» 필드라 미선언 인자를 막는 축과 다른 축이다). 둘 다 왔는데
    값이 다르면 거부한다 — 조용히 하나를 고르면 이 판이 없애려는 병이 그대로 되살아난다.

    ⛔걷을 조건 — 다음 판에서 실사용 로그(agent 호출)를 세어 `thread_id`(옛 이름) 사용이
    0에 수렴하면 이 필드와 아래 검증을 뺀다. #2792에서 react-hooks lint disable에 붙인
    것과 같은 형태(면제/별칭은 «언제 없앨 수 있는가»가 없으면 영원히 남는다).

    ⛔PO 지적(2026-08-02, #2799 리뷰) — 「걷을 조건」이 적혀만 있으면 그 조건이 «충족됐는지»를
    아무도 못 잰다(호출자는 코드가 아니라 에이전트들의 습관이라 grep으로 못 센다). `thread_id`
    로 들어오면 매번 경고 로그 한 줄을 남긴다 — 이 로그가 그 카운터다. Cloud Logging에서
    `logger="sprintable_mcp.tools.chat"` + "deprecated thread_id alias"로 검색해 최근 N일간
    발화 빈도를 센다. 0에 수렴하면(또는 특정 소수 소비처로만 좁혀지면) 그때 별칭을 걷는다.
    """

    conversation_id: str | None = None
    thread_id: str | None = None  # 폐기 예정 별칭 — conversation_id를 쓰세요

    @model_validator(mode="after")
    def _resolve_conversation_id(self) -> "ConversationScopedInput":
        if self.conversation_id and self.thread_id and self.conversation_id != self.thread_id:
            raise ValueError(
                "conversation_id와 thread_id가 둘 다 주어졌는데 값이 다릅니다 — "
                "thread_id는 conversation_id의 폐기 예정 별칭입니다(응답의 thread_id와는 "
                "다른 뜻이니 혼동하지 마세요). 하나만 쓰거나 같은 값을 주세요."
            )
        if self.thread_id and not self.conversation_id:
            logger.warning(
                "%s: deprecated thread_id alias used instead of conversation_id "
                "(story #2427 — usage counter for when to remove the alias)",
                self.__class__.__name__,
            )
        resolved = self.conversation_id or self.thread_id
        if not resolved:
            raise ValueError(
                "conversation_id가 필요합니다 — thread_id는 폐기 예정 별칭이니 "
                "conversation_id를 쓰세요."
            )
        self.conversation_id = resolved
        return self


class SendChatInput(ConversationScopedInput):
    # story #2629(2026-08-14, 발견 표면 보조축): 「#24」류 맨 스토리 번호는 서버가 발신
    # 시점에 자동으로 entity 임베드 카드로 승격한다(문법을 몰라도 됨) — 이 설명은 그
    # 사실을 알리는 것이지, 아래 escape 규칙을 «가르치려는» 게 아니다(플랫폼이 흡수하는
    # 축과 발견 표면 축은 별개 — 안 배워도 되지만, 알면 entity 토큰(`[제목](entity:type:id)`)
    # 문법을 mentions 필드로 직접 구성할 수도 있다는 것도 알려 준다).
    content: str = Field(
        description=(
            "메시지 본문. 「#24」처럼 맨 스토리 번호만 써도(코드블록/인라인코드 제외) "
            "서버가 발신 시점에 자동으로 entity 임베드 카드로 승격한다 — 문법을 몰라도 됨. "
            "doc/epic 등 다른 엔티티나 커스텀 표시 문구가 필요하면 `mentions` 필드로 "
            "`[제목](entity:type:id)` 토큰을 직접 구성할 수도 있다."
        ),
    )
    reply_thread_id: str | None = None
    message_type: str | None = None
    review_type: str | None = None
    metadata: dict | None = None
    # [{content_base64, name, content_type}, ...] — 스샷/작은 문서(최대 5개·파일당 2MiB·총 6MiB).
    attachments: list[dict] | None = None
    # story 1995: agent가 human의 `#` 트리거 doc mention(chat-input.tsx applyEntity())과 동형인
    # `[title](entity:doc:id) ` 토큰을 content에 합성 — human 경로가 만드는 토큰을 agent 경로도
    # 만들 수 있게 해 doc backlink/link가 agent 발신 메시지에서도 동작하게 한다.
    mentions: list[MentionRef] | None = None
    # story #2618: 위 `mentions`(entity-참조)와 별개 — 팀원 @멘션(구조화, UUID). REST
    # `SendMessageRequest.mentioned_ids`(app/routers/conversations.py)에 그대로 전달한다.
    # FE 피커(chat-input.tsx)가 이미 채워 보내는 필드인데 MCP 스키마에만 없었다(#3000 그라운딩
    # ⑦ 발견) — channel_router.py mentions-레벨 알림게이팅·전용 conversation.mention 알림/푸시·
    # DM 비참가자 멘션 시 group 자동 포크·체인뎁스 초과 시 human_intervention 타깃 한정, 4개
    # 소비처가 실제로 갈리므로(#2636 (b)안류 죽은 파라미터 아님) 배선만으로 실효과가 난다.
    # 이름→ID 해석은 기존 `sprintable_list_team_members`(id+name 노출)로 이미 가능. 텍스트
    # `@handle` 파싱 경로는 story #2646(2026-08-14)로 은퇴 — 팀원 멘션은 이 필드가 유일 경로.
    mentioned_ids: list[str] | None = None


class CreateConversationInput(SprintableInput):
    participant_ids: list[str]
    title: str | None = None


class ListChatMessagesInput(ConversationScopedInput):
    limit: int | None = None
    before: str | None = None


class GetChatMessageInput(ConversationScopedInput):
    message_id: str


async def _resolve_mention_content(args: SendChatInput) -> str:
    """story 1995 + #2283 후속: mentions → `[title](entity:<type>:id) ` 토큰을 합성해 content에
    붙인다.

    ⛔title 미지정 mention은 GET(_MENTION_ENTITY_ENDPOINTS)으로 엔티티를 조회하고, 그 응답의
    `reference_token` 필드(#2282 SSOT — DocResponse/StoryResponse/GoalResponse가
    @computed_field로 매 직렬화마다 서버가 escape까지 끝내 만든 것)를 **그대로** 쓴다 — title을
    가져와 여기서 다시 escape하지 않는다. 로컬 escape 로직(`escape_mention_title`)과 백엔드
    `build_reference_token`의 escape 규칙이 각각 따로 존재하면(오늘 하루 반복 걸린 twin-system
    클래스) 한쪽만 고쳐질 때 다시 벌어진다 — 서버가 이미 만든 토큰을 재사용하면 그 위험 자체가
    없다. 응답에 `reference_token`이 없으면(구버전 백엔드 등 방어적 폴백) title로 로컬 조립하고
    경고 로그를 남긴다. 404/기타 에러는 그대로 propagate(호출자 send_chat_message의 try/except가
    잡아 err()로 노출·메시지 POST 자체를 막는다 — broken 토큰이 실린 반쪽 메시지가 저장되는 걸
    방지).

    title **지정** mention(캐릭터가 표시 문구를 커스텀하고 싶을 때)은 백엔드에 해당 문자열의
    토큰이 없으므로 로컬 escape로 직접 짓는다 — 이 경로만 `escape_mention_title`을 쓴다.

    join 컨벤션: 각 토큰은 FE applyEntity()/applyAsset() 관례와 동일하게 trailing space를 포함
    (`[title](entity:doc:id) `) — 여러 mention은 토큰을 그대로 이어붙이고(토큰마다 이미 뒤 공백이
    있어 추가 구분자 불필요), 원 content가 비어있지 않으면 content와 토큰 블록 사이에 공백 하나를
    삽입한다. 예: content="see this" + mentions=[{title:"My Doc", id:"<uuid>"}] →
    "see this [My Doc](entity:doc:<uuid>) ".
    """
    tokens: list[str] = []
    for mention in args.mentions or []:
        if mention.title is not None:
            tokens.append(f"[{escape_mention_title(mention.title)}](entity:{mention.type}:{mention.id}) ")
            continue
        endpoint = _MENTION_ENTITY_ENDPOINTS[mention.type].format(id=mention.id)
        entity = await client.get(endpoint)
        token = (entity.get("reference_token") if isinstance(entity, dict) else None) or None
        if token is None:
            # ⛔PO 지적(2026-07-28, #2585 리뷰): "경고만"으로는 이 폴백이 실제로 얼마나
            # 타는지 아무도 모른다 — 그러면 twin-rule(로컬 escape vs 서버 build_reference_token)
            # 이 살아 있는데 살아 있는 줄 모르는 상태가 된다. 이 경고 로그 자체가 그 카운터다 —
            # Cloud Logging에서 logger="sprintable_mcp.tools.chat" + "missing reference_token"
            # 문자열로 검색해 발화 빈도를 센다. 만료 날짜를 미리 정하지 않은 이유: MCP와 백엔드가
            # 같은 배포 유닛(둘 다 backend/ 하위)이라 정상 상태에선 skew가 없어야 하지만, Cloud
            # Run 리비전 교체 중 짧은 창(구 리비전 파드가 아직 트래픽을 받는 순간)엔 실제로 있을
            # 수 있다 — 그게 "일회성"인지 "배포마다 반복"인지 아직 실측이 없다. 카운트가 0에
            # 수렴하면(또는 배포 롤아웃 창에서만 튀는 패턴이 확인되면) 그때 폴백을 걷는다.
            title = (entity.get("title") or "") if isinstance(entity, dict) else ""
            token = f"[{escape_mention_title(title)}](entity:{mention.type}:{mention.id})"
            logger.warning(
                "send_chat_message: %s %s GET response missing reference_token — built locally "
                "as fallback (possible backend/mcp version skew)",
                mention.type, mention.id,
            )
        tokens.append(f"{token} ")
    token_block = "".join(tokens)
    return f"{args.content} {token_block}" if args.content else token_block


async def send_chat_message(args: SendChatInput) -> list[TextContent]:
    """conversation thread에 채팅 메시지 발송.

    응답의 thread_id는 «회신 스레드» ID입니다(대화 ID가 아닙니다 — 대화 ID는
    conversation_id입니다). 회신이 아닌 메시지는 보통 null입니다.
    """
    uploaded_urls: list[str] = []
    try:
        content = await _resolve_mention_content(args) if args.mentions else args.content
        payload: dict = {"content": content}
        if args.reply_thread_id:
            payload["thread_id"] = args.reply_thread_id
        if args.mentioned_ids:
            payload["mentioned_ids"] = args.mentioned_ids
        meta: dict = {}
        if args.metadata:
            meta.update(args.metadata)
        if args.message_type:
            meta["message_type"] = args.message_type
        if args.review_type:
            meta["review_type"] = args.review_type
        if meta:
            payload["metadata"] = meta
        attachments = await upload_attachments(
            f"/api/v2/conversations/{args.conversation_id}/attachments", args.attachments,
        )
        uploaded_urls = [a["url"] for a in attachments if isinstance(a, dict) and a.get("url")]
        if attachments:
            payload["attachments"] = attachments
        # ⛔story #2294 ③ 후속(오르테가 라이브 실측, 2026-07-29): 백엔드 응답은
        # `{"data": {...메시지}, "references": {...}?, "command_gate": {...}?}` 모양인데,
        # 일반 unwrap 경로(SprintableApiClient.request의 기본 동작)가 sibling 키를 전부
        # 버리고 data만 반환했다 — references{stored,dropped} 사이드밴드가 CI green·배포
        # SHA 일치에도 MCP 호출부에는 한 번도 안 닿던 정확한 원인(같은 이유로 command_gate도
        # 처음부터 MCP 경로에서 안 보였다 — 이번에 같이 드러난 기존 버그). unwrap=False로
        # 원본을 받아 여기서 명시적으로 재구성한다 — 기존 MCP 호출부가 기대하는 평탄한
        # 메시지 필드 모양은 그대로 유지하면서 sibling 키만 얹는다(회귀 0: sibling이 없는
        # 평문 메시지는 이전과 byte-identical).
        raw = await client.post_full(f"/api/v2/conversations/{args.conversation_id}/messages", json=payload)
        result: dict = dict(raw.get("data") or {}) if isinstance(raw, dict) else raw
        if isinstance(raw, dict):
            for sibling_key in ("references", "command_gate", "forked", "forked_conversation_id"):
                if sibling_key in raw:
                    result[sibling_key] = raw[sibling_key]
        return ok(result)
    except Exception as exc:
        if uploaded_urls:
            # 업로드는 성공했으나 메시지 생성이 실패한 경우 — asset registry 는 SAVE-time(메시지
            # 저장 트랜잭션)에만 동기화되므로 이 객체들은 미등록 orphan blob 으로 남는다(무해·
            # data-loss 아님). 운영 가시성을 위해 로그만 남김(best-effort cleanup 대상 아님 —
            # storage 자체 GC/grace cron 이 있다면 그쪽이 담당).
            logger.warning(
                "send_chat_message: message create failed after %d attachment upload(s) — "
                "orphaned object(s): %s", len(uploaded_urls), uploaded_urls,
            )
        return err(str(exc))


async def create_conversation(args: CreateConversationInput) -> list[TextContent]:
    """새 conversation thread 생성."""
    try:
        body: dict = {
            "type": "group",
            "participant_ids": args.participant_ids,
            "project_id": client.require_project_id(),  # E-MCP-OPT ff6cb90d: 무인자+ambiguous 명시 에러.
        }
        if args.title:
            body["title"] = args.title
        conv = await client.post("/api/v2/conversations", json=body)
        conv_id = conv.get("id") if isinstance(conv, dict) else None
        return ok({"conversation_id": conv_id, **(conv if isinstance(conv, dict) else {})})
    except Exception as exc:
        return err(str(exc))


async def list_chat_messages(args: ListChatMessagesInput) -> list[TextContent]:
    """conversation thread 메시지 목록 조회.

    각 메시지의 thread_id는 «회신 스레드» ID입니다(대화 ID가 아닙니다 — 대화 ID는
    conversation_id입니다). 회신이 아닌 메시지는 보통 null입니다.
    """
    params: dict = {}
    if args.limit is not None:
        params["limit"] = str(args.limit)
    if args.before:
        params["before"] = args.before
    try:
        return ok(await client.get(f"/api/v2/conversations/{args.conversation_id}/messages", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_chat_message(args: GetChatMessageInput) -> list[TextContent]:
    """메시지 단건 원문 조회 — 웹훅 payload가 잘렸을 때 message_id로 즉시 원문 픽업.

    응답의 thread_id는 «회신 스레드» ID입니다(대화 ID가 아닙니다 — 대화 ID는
    conversation_id입니다). 회신이 아닌 메시지는 보통 null입니다.
    """
    try:
        return ok(await client.get(f"/api/v2/conversations/{args.conversation_id}/messages/{args.message_id}"))
    except Exception as exc:
        return err(str(exc))
