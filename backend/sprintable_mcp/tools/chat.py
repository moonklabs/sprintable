"""채팅 MCP 도구 (3개)."""
from __future__ import annotations

import logging
import re
from typing import Literal

from mcp.types import TextContent

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
_MENTION_ENTITY_ENDPOINTS: dict[str, str] = {
    "doc": "/api/v2/docs/{id}",
    "story": "/api/v2/stories/{id}",
    "epic": "/api/v2/goals/{id}",
}


class MentionRef(SprintableInput):
    """agent 발신 채팅 메시지에 첨부할 entity mention — story 1995(doc 링크 안 됨 근본수정) +
    story #2283 후속(2026-07-28, doc→doc/story/epic 확장).

    type은 스키마 레벨에서 doc/story/epic만 허용(Literal). MCP 서버는 백엔드 `app.*`를 import
    하지 않고 HTTP로만 통신하는 별도 프로세스라(api_client.py 참조) 이 목록을 백엔드
    `reference_registry.ENTITY_RESOLVERS`에서 런타임에 **파생시킬 수 없다** — 두 프로세스가
    같은 값을 손으로 맞춰 유지하는 수밖에 없는 자리다. 대신
    `test_mention_entity_endpoints_match_backend_entity_resolvers`가 **테스트로** 그 동일성을
    고정한다 — 백엔드 registry가 늘면 이 테스트가 빨개져서 여기(이 Literal +
    `_MENTION_ENTITY_ENDPOINTS`)도 늘리도록 강제한다.

    ⛔실제로 story #2294(target_type에 `task` 개설)에서 이 테스트가 바로 빨개질 것이다 — 그때
    답은 **이 테스트를 고치거나 느슨하게 하는 것이 아니라, 여기 Literal과
    `_MENTION_ENTITY_ENDPOINTS`에 `task` 항목을 추가하는 것**이다(가드가 걸렸을 때 나올 수
    있는 세 가지 반응 — 목록을 넓힌다 / 테스트를 고친다 / 무시한다 — 중 첫 번째만 옳다는 것을
    미리 적어 둔다).
    """

    type: Literal["doc", "story", "epic"]
    id: str
    title: str | None = None


class SendChatInput(SprintableInput):
    thread_id: str
    content: str
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


class CreateConversationInput(SprintableInput):
    participant_ids: list[str]
    title: str | None = None


class ListChatMessagesInput(SprintableInput):
    thread_id: str
    limit: int | None = None
    before: str | None = None


class GetChatMessageInput(SprintableInput):
    thread_id: str  # conversation_id — send/list_chat_message와 동일 네이밍 관례
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
    """conversation thread에 채팅 메시지 발송."""
    uploaded_urls: list[str] = []
    try:
        content = await _resolve_mention_content(args) if args.mentions else args.content
        payload: dict = {"content": content}
        if args.reply_thread_id:
            payload["thread_id"] = args.reply_thread_id
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
            f"/api/v2/conversations/{args.thread_id}/attachments", args.attachments,
        )
        uploaded_urls = [a["url"] for a in attachments if isinstance(a, dict) and a.get("url")]
        if attachments:
            payload["attachments"] = attachments
        return ok(await client.post(f"/api/v2/conversations/{args.thread_id}/messages", json=payload))
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
    """conversation thread 메시지 목록 조회."""
    params: dict = {}
    if args.limit is not None:
        params["limit"] = str(args.limit)
    if args.before:
        params["before"] = args.before
    try:
        return ok(await client.get(f"/api/v2/conversations/{args.thread_id}/messages", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_chat_message(args: GetChatMessageInput) -> list[TextContent]:
    """메시지 단건 원문 조회 — 웹훅 payload가 잘렸을 때 message_id로 즉시 원문 픽업."""
    try:
        return ok(await client.get(f"/api/v2/conversations/{args.thread_id}/messages/{args.message_id}"))
    except Exception as exc:
        return err(str(exc))
