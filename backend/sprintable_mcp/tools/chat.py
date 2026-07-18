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
    """
    escaped = _MENTION_TITLE_ESCAPE_RE.sub(lambda m: "\\" + m.group(0), title)
    return _MENTION_TITLE_NEWLINE_RE.sub(" ", escaped)


class MentionRef(SprintableInput):
    """agent 발신 채팅 메시지에 첨부할 entity mention — story 1995(doc 링크 안 됨 근본수정).

    type은 스키마 레벨에서 "doc"만 허용(Literal) — MCP tool-call 검증 단계에서 그 외 값은
    핸들러 코드 진입 전에 거부된다(AC1).
    """

    type: Literal["doc"]
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
    """story 1995: mentions → `[title](entity:doc:id) ` 토큰을 합성해 content에 붙인다.

    title 미지정 mention은 GET /api/v2/docs/{id}로 canonical title을 조회(AC3) — 404/기타 에러는
    그대로 propagate(호출자 send_chat_message의 try/except가 잡아 err()로 노출·메시지 POST 자체를
    막는다 — broken 토큰이 실린 반쪽 메시지가 저장되는 걸 방지).

    join 컨벤션: 각 토큰은 FE applyEntity()/applyAsset() 관례와 동일하게 trailing space를 포함
    (`[title](entity:doc:id) `) — 여러 mention은 토큰을 그대로 이어붙이고(토큰마다 이미 뒤 공백이
    있어 추가 구분자 불필요), 원 content가 비어있지 않으면 content와 토큰 블록 사이에 공백 하나를
    삽입한다. 예: content="see this" + mentions=[{title:"My Doc", id:"<uuid>"}] →
    "see this [My Doc](entity:doc:<uuid>) ".
    """
    tokens: list[str] = []
    for mention in args.mentions or []:
        title = mention.title
        if title is None:
            doc = await client.get(f"/api/v2/docs/{mention.id}")
            title = (doc.get("title") or "") if isinstance(doc, dict) else ""
        tokens.append(f"[{escape_mention_title(title)}](entity:doc:{mention.id}) ")
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
