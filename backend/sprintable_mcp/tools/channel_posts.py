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


# story #3651(Phase2·MCP·소형, 페드루 PO 確定 2026-09-07) — 블루프린트 v3 §7 Phase 2 AC
# 「1일·7일 성과를 비교해 후속 스토리를 만든다」의 에이전트 몫. 원장(story #3497/#3571)·
# REST 조회(insight_snapshots.py:34, `/publications/{publication_id}/insights`)는 이미
# 완비돼 있었으나 hosted MCP엔 insight류 도구가 0(휴먼 표면=insights-board만 있고 에이전트
# 표면이 없던 자리) — 「만들어졌는데 쓰는 자리 없음」 클래스. 후속 스토리 생성 자체는
# 새로 안 짓는다 — 기존 sprintable_add_story를 그대로 쓴다(이 도구는 «비교할 재료»만 준다).
class GetPublicationInsightsInput(SprintableInput):
    # 원한다면(권장) publication_id를 직접, 모르면 draft_id로 최신 발행을 찾아 준다 —
    # 최저 지능 에이전트가 초안 id만 알아도 되게 하는 편의 축(선택, 스토리 처방③).
    publication_id: str | None = None
    draft_id: str | None = None


# story #3497 서비스(insight_snapshots.py)의 NORMALIZED_KEYS와 같은 계약(정규화 7키+
# GA4 유입 3키)을 이 MCP 프로세스는 직접 import 못 한다(별도 패키지, REST 경계 너머) —
# 여기서 키 목록을 재선언하지 않고 응답에 실제로 있는 키의 합집합으로 델타를 낸다(BE가
# 키를 늘려도 이 축이 안 깨진다, 새 계약 문서 동기화 불요).
def _label_snapshots_and_compute_delta(
    snapshots: list[dict],
) -> tuple[list[dict], dict[str, int | None] | None, str | None]:
    """due_at 오름차순 정렬 뒤 offset_label(1d|7d)을 매기고, 둘 다 captured일 때만
    키별 v7−v1 델타를 낸다. 페드루 決定(3321 원칙) — 0과 null(미제공)을 섞지 않는다:
    두 값 중 하나라도 None이면 그 키의 델타는 None(0으로 대체하지 않는다)."""
    sorted_snapshots = sorted(snapshots, key=lambda s: s["due_at"])
    labeled = [
        {**snap, "offset_label": "1d" if idx == 0 else "7d"}
        for idx, snap in enumerate(sorted_snapshots)
    ]
    snapshot_1d = next((s for s in labeled if s["offset_label"] == "1d"), None)
    snapshot_7d = next((s for s in labeled if s["offset_label"] == "7d"), None)
    if snapshot_1d is None or snapshot_7d is None:
        return labeled, None, "스냅샷이 2건 미만 — 1일·7일 두 스냅샷이 모두 등록돼야 델타를 계산합니다."
    if snapshot_1d["status"] != "captured":
        return labeled, None, f"1일 스냅샷 미도달(status={snapshot_1d['status']})"
    if snapshot_7d["status"] != "captured":
        return labeled, None, f"7일 스냅샷 미도달(status={snapshot_7d['status']})"

    normalized_1d = snapshot_1d.get("normalized") or {}
    normalized_7d = snapshot_7d.get("normalized") or {}
    delta: dict[str, int | None] = {}
    for key in sorted(set(normalized_1d) | set(normalized_7d)):
        v1, v7 = normalized_1d.get(key), normalized_7d.get(key)
        delta[key] = (v7 - v1) if isinstance(v1, int) and isinstance(v7, int) else None
    return labeled, delta, None


async def get_publication_insights(args: GetPublicationInsightsInput) -> list[TextContent]:
    """발행물의 1일·7일 인사이트 스냅샷 목록과 둘 사이 키별 델타를 준다 — 에이전트가
    「어제 낸 글 성과가 어땠는지」를 스스로 읽고 후속 스토리를 판단할 재료(스토리는
    이 도구가 대신 안 만든다 — sprintable_add_story를 쓸 것).

    publication_id를 모르면 draft_id로 그 초안의 「마지막 발행」 publication_id를 찾아
    대신 조회한다(초안이 발행된 적 없으면 그 사실을 알린다). delta_1d_to_7d는 두
    스냅샷 모두 status=captured일 때만 채워진다 — 7일이 아직 안 왔거나(pending) 수집이
    실패했으면(failed) null+delta_unavailable_reason으로 사유를 알린다. 각 키는 두
    스냅샷 모두 값이 있을 때만 계산되고, 한쪽이라도 미제공(null)이면 그 키도 null —
    0(선언했고 실제로 0)과 null(그 채널이 그 지표를 아예 선언 안 함)을 섞지 않는다."""
    try:
        publication_id = args.publication_id
        if not publication_id:
            if not args.draft_id:
                return err("publication_id 또는 draft_id 중 하나는 필요합니다.")
            draft = await client.get(
                f"/api/v2/organizations/{client.org_id}/channel-posts/drafts/{args.draft_id}",
            )
            publication_id = draft.get("publication_id")
            if not publication_id:
                return err(
                    "이 초안은 아직 발행된 적이 없습니다(publication_id 없음) — "
                    "발행 후 다시 조회해 주세요.",
                )

        snapshots = await client.get(
            f"/api/v2/organizations/{client.org_id}/publications/{publication_id}/insights",
        )
        labeled, delta, reason = _label_snapshots_and_compute_delta(snapshots)
        return ok({
            "publication_id": publication_id,
            "snapshots": labeled,
            "delta_1d_to_7d": delta,
            "delta_unavailable_reason": reason,
        })
    except Exception as exc:
        return err(str(exc))
