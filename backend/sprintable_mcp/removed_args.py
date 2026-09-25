"""story #4329 — 도구에서 뺀 인자를 다시 보낸 호출에게 «왜 안 되는지 · 대신 무엇을»을 알려 주는 문구.

MCP 도구는 모르는 인자를 거절한다(story #2412 `_lock_down_extra_args` · 127개 전부). 4329에서 뺀 인자는 원래 백엔드가 받지 않아 조용히
버려지던 값이라, 거절 문구가 이유와 대안을 말해야 에이전트가 오류만 보고 스스로 고친다(PO 요청). `_reject_unknown`이 이 표를 읽는다.
"""
from __future__ import annotations

_CHAT_METADATA = (
    "서버가 저장하지 않아(받는 필드가 없어 버려지던 값) 이제 받지 않아요. 메시지 성격은 `message_kind`"
    "(request · handoff · result · ack)로 싣고, 이 인자는 빼고 다시 부르세요."
)

REMOVED_ARGS: dict[str, dict[str, str]] = {
    "sprintable_vote_retro_item": {
        "voter_id": "투표자는 부른 에이전트 자신으로 서버가 정해요(대리 투표 없음). voter_id를 빼고 다시 부르세요.",
    },
    "sprintable_send_chat_message": {
        "message_type": _CHAT_METADATA,
        "review_type": _CHAT_METADATA,
        "metadata": _CHAT_METADATA,
    },
}


def removed_arg_hints(tool_name: str, unknown: list[str]) -> str:
    """거절 문구 뒤에 붙일 안내 — 뺀 인자에만. 없으면 빈 문자열."""
    hints = REMOVED_ARGS.get(tool_name, {})
    return "".join(f" · `{name}`: {hints[name]}" for name in unknown if name in hints)
