"""story #3614(Phase2·BE+FE+MCP, 페드루 PO 確定 2026-09-07) — 채널 글 초안 「폐기」
(withdraw). 「변경 요청 뒤 재상신」만 있던 작성자(에이전트 포함)의 유일한 다음 행동에
「폐기」를 더한다 — 에이전트가 변경 요청을 받아들일 수 없을 때 스스로 닫는 길.

이 도메인(채널 포스트 초안)의 첫 MCP 도구다 — org-scoped URL(`/organizations/{org_id}/...`)
을 직접 조립하는 최초 사례(기존 도구는 전부 flat 엔드포인트+body auto-inject 관례,
tools/decisions.py 등 참고). `client.org_id`는 매 요청 헤더에 실리는 인증과 별개로
경로 조립에도 직접 쓸 수 있다(SprintableClient.request 참고, URL은 그대로 f-string)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class WithdrawChannelPostDraftInput(SprintableInput):
    draft_id: str


async def withdraw_channel_post_draft(args: WithdrawChannelPostDraftInput) -> list[TextContent]:
    """채널 글 초안을 폐기(withdraw)한다 — 작성자(에이전트 포함) 또는 org owner/admin만
    가능(BE 403 CHANNEL_POST_WITHDRAW_FORBIDDEN). 열린(pending) external_publish 게이트가
    있으면 사유 「작성자가 폐기」로 rejected 종결한다. 이미 발행된 초안은 409
    CHANNEL_POST_DRAFT_ALREADY_PUBLISHED(발행 취소는 별도 unpublish 경로). 이미 폐기된
    초안을 다시 호출해도 안전(멱등, 재클릭 방어). 응답에 종결 상태(status)와 게이트
    id·상태(gate_id/gate_status, 게이트가 없었으면 둘 다 null)가 실린다."""
    try:
        result = await client.post(
            f"/api/v2/organizations/{client.org_id}/channel-posts/drafts/{args.draft_id}/withdraw",
        )
        return ok(result)
    except Exception as exc:
        return err(str(exc))
