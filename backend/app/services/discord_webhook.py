"""Discord webhook 페이로드 변환 공용 헬퍼 (c60dd33c).

Discord incoming webhook 은 ``{content|embeds}`` 형식이 필수다. Sprintable raw envelope
(``{event, data}`` 또는 conversation payload)를 그대로 POST 하면 **400 Bad Request** 로 거절된다.
채팅 경로(conversation_webhook)와 generic 이벤트 경로(webhook_dispatch.fire_webhooks)가 같은
변환 로직을 쓰도록 단일 진실원으로 추출 — 중복 0.

라우팅/retry/status 는 이 모듈의 책임이 아니다(payload normalize 전용).
"""
from __future__ import annotations

import os

_DISCORD_URL_PATTERNS = ("discord.com/api/webhooks", "discordapp.com/api/webhooks")


def is_discord_url(url: str) -> bool:
    return any(pat in url for pat in _DISCORD_URL_PATTERNS)


def to_discord_message_payload(payload: dict) -> dict:
    """conversation.message_created payload → Discord content 포맷.

    (conversation_webhook._to_discord_payload 에서 이전 — 채팅 전달 거동 byte-동형 유지.)
    """
    content_text = (payload.get("content") or "")[:500]
    conversation_id = payload.get("conversation_id", "")
    # 정합 버그 fix(story ebd5cf18 크럭스 부수 발견, PO 승인): 예전엔 payload["thread_id"]를
    # "message_id"로 오라벨했다 — 루트 메시지는 thread_id가 항상 None(자기 자신이 스레드
    # 시작점)이라 정작 회신-대상 식별이 가장 필요한 순간(새 task 도착)에 표시가 사라졌다.
    # 이 메시지 자신의 id(payload["message_id"])를 보여줘야 수신자가 그걸로 스레드 답신 가능.
    message_id = payload.get("message_id") or ""

    discord_content = "📩 **새 메시지**"
    if content_text:
        discord_content += f"\n{content_text}"
    if conversation_id:
        discord_content += f"\n\nconversation_id: {conversation_id}"
    if message_id:
        discord_content += f"\nmessage_id: {message_id}"

    result: dict = {"content": discord_content}
    app_url = os.environ.get("NEXT_PUBLIC_APP_URL", "")
    if app_url and conversation_id:
        result["embeds"] = [{"title": "대화 보기", "url": f"{app_url}/conversations/{conversation_id}"}]
    return result


def to_discord_event_payload(event: str, data: dict) -> dict:
    """generic 이벤트 envelope(``{event, data}``) → Discord content 포맷.

    fire_webhooks 가 story/activity·file_conflict 등 모든 이벤트를 Discord 로 보낼 때 사용.
    핵심 필드(제목·상태전이·actor)가 있으면 사람-친화 렌더, 없으면 event 명만으로도 유효
    payload(=204). 항상 최소 ``{content}`` 를 보장해 400 을 차단한다.
    """
    content = f"🔔 **{event}**"

    title = data.get("story_title") or data.get("title")
    if title:
        content += f"\n{title}"

    old_status = data.get("old_status")
    new_status = data.get("new_status") or data.get("status")
    if old_status and new_status:
        content += f"\n{old_status} → {new_status}"
    elif new_status:
        content += f"\n상태: {new_status}"

    actor_name = data.get("actor_name")
    if actor_name:
        content += f"\nby {actor_name}"

    reason = data.get("reason")
    if reason:
        content += f"\n{reason}"

    result: dict = {"content": content[:2000]}  # Discord content 한도 2000자

    app_url = os.environ.get("NEXT_PUBLIC_APP_URL", "")
    story_id = data.get("story_id")
    project_id = data.get("project_id")
    if app_url and story_id and project_id:
        result["embeds"] = [{
            "title": "스토리 보기",
            "url": f"{app_url}/projects/{project_id}/stories/{story_id}",
        }]
    return result
