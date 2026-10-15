"""story #3614(Phase2·BE+FE+MCP, 페드루 PO 確定 2026-09-07) — 채널 글 초안 「폐기」
(withdraw). 「변경 요청 뒤 재상신」만 있던 작성자(에이전트 포함)의 유일한 다음 행동에
「폐기」를 더한다 — 에이전트가 변경 요청을 받아들일 수 없을 때 스스로 닫는 길.

이 도메인(채널 포스트 초안)의 첫 MCP 도구다 — org-scoped URL(`/organizations/{org_id}/...`)
을 직접 조립하는 최초 사례(기존 도구는 전부 flat 엔드포인트+body auto-inject 관례,
tools/decisions.py 등 참고). `client.org_id`는 매 요청 헤더에 실리는 인증과 별개로
경로 조립에도 직접 쓸 수 있다(SprintableClient.request 참고, URL은 그대로 f-string)."""
from __future__ import annotations

from urllib.parse import quote

from mcp.types import TextContent

from ..api_client import as_list, client
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
        return err(exc)


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
def _is_numeric(v: object) -> bool:
    """bool은 int의 서브클래스라(`isinstance(True, int) is True`) 명시로 뺀다 — 정규화
    값에 boolean이 올 계약은 없지만, 있다면 델타로 계산되면 안 되는 종류다."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _label_snapshots_and_compute_delta(
    snapshots: list[dict],
) -> tuple[dict[str, int | float | None] | None, str | None, int]:
    """서버(insight_snapshots.py 라우터)가 이미 매긴 offset_label(1d|7d|null)을 그대로
    읽는다 — 둘 다 captured일 때만 키별 v7−v1 델타를 낸다. 페드루 決定(3321 원칙) —
    0과 null(미제공)을 섞지 않는다: 두 값 중 하나라도 None이면 그 키의 델타는 None
    (0으로 대체하지 않는다). 값은 int뿐 아니라 float도 허용(spend·GA4 유입 파생값
    등 실수로 올 수 있는 지표가 조용히 null 처리되면 «제공된 값»을 «미제공」으로
    오판하는 것이라 — 페드루 CHANGES 2026-09-07, PR#4003).

    카디르 발견(PR#4003, 2026-09-07) — 예전엔 이 함수가 직접 「idx0=1d·나머지=7d」로
    라벨을 매겼는데, hosted_site 재발행이 같은 publication_id를 유지한 채 published_at
    을 갱신하고 새 due_at 2행을 더 열어(UNIQUE는 «새» due_at을 안 막는다) 4건 이상이
    흔했다 — 옛 사이클의 잔존 스냅샷이 "7d"로 오라벨돼 에러 없이 틀린 델타가 나갔다.
    처방(근본) — 인덱스 라벨링을 버리고 서버가 「due_at−«지금» published_at」으로
    낸 정본 라벨만 읽는다(insights_board.py와 같은 헬퍼 `label_snapshot_offset`).
    null 라벨(옛 사이클 잔존)은 델타 계산에서 빼고 개수만 3번째 반환값(superseded_
    snapshots)으로 알린다 — 지어내지 않고 사실 그대로("이 발행 뒤로 안 쓰는 스냅샷이
    n건 더 있었다").

    story #3660(2026-09-07) — 서버가 이제 옛 사이클의 pending/in_progress 행을
    status="superseded"로 회수한다(insight_snapshots.py::schedule_insight_snapshots).
    이 카운트는 그 값 ∪ offset_label이 null인 행(옛 사이클이지만 이미 captured/
    failed/unsupported로 종결돼 status는 안 바뀐 행)의 합집합 — 한 스냅샷이 둘 다
    해당해도 리스트 컴프리헨션이 한 번만 세므로 중복 0."""
    superseded = [
        s for s in snapshots
        if s.get("status") == "superseded" or s.get("offset_label") is None
    ]
    snapshot_1d = next((s for s in snapshots if s.get("offset_label") == "1d"), None)
    snapshot_7d = next((s for s in snapshots if s.get("offset_label") == "7d"), None)
    if snapshot_1d is None or snapshot_7d is None:
        return None, "스냅샷이 2건 미만 — 1일·7일 두 스냅샷이 모두 등록돼야 델타를 계산합니다.", len(superseded)
    if snapshot_1d["status"] != "captured":
        return None, f"1일 스냅샷 미도달(status={snapshot_1d['status']})", len(superseded)
    if snapshot_7d["status"] != "captured":
        return None, f"7일 스냅샷 미도달(status={snapshot_7d['status']})", len(superseded)

    normalized_1d = snapshot_1d.get("normalized") or {}
    normalized_7d = snapshot_7d.get("normalized") or {}
    delta: dict[str, int | float | None] = {}
    for key in sorted(set(normalized_1d) | set(normalized_7d)):
        v1, v7 = normalized_1d.get(key), normalized_7d.get(key)
        delta[key] = (v7 - v1) if _is_numeric(v1) and _is_numeric(v7) else None
    return delta, None, len(superseded)


async def get_publication_insights(args: GetPublicationInsightsInput) -> list[TextContent]:
    """발행물의 1일·7일 인사이트 스냅샷 목록과 둘 사이 키별 델타를 준다 — 에이전트가
    「어제 낸 글 성과가 어땠는지」를 스스로 읽고 후속 스토리를 판단할 재료(스토리는
    이 도구가 대신 안 만든다 — sprintable_add_story를 쓸 것).

    publication_id를 모르면 draft_id로 그 초안의 「마지막 발행」 publication_id를 찾아
    대신 조회한다(초안이 발행된 적 없으면 그 사실을 알린다). delta_1d_to_7d는 두
    스냅샷 모두 status=captured일 때만 채워진다 — 7일이 아직 안 왔거나(pending) 수집이
    실패했으면(failed) null+delta_unavailable_reason으로 사유를 알린다. 각 키는 두
    스냅샷 모두 값이 있을 때만 계산되고, 한쪽이라도 미제공(null)이면 그 키도 null —
    0(선언했고 실제로 0)과 null(그 채널이 그 지표를 아예 선언 안 함)을 섞지 않는다.

    각 스냅샷의 offset_label(1d|7d|null)은 서버가 매긴 정본 — null은 재발행 등으로
    옛 발행 사이클에 속한 잔존 스냅샷(카디르 발견, PR#4003)이라 델타 계산에서 빠지고,
    그 개수가 superseded_snapshots에 실린다(0이면 잔존 없음)."""
    try:
        publication_id = args.publication_id
        if not publication_id:
            if not args.draft_id:
                return err("publication_id 또는 draft_id 중 하나는 필요합니다.")
            draft = await client.get(
                f"/api/v2/organizations/{client.org_id}/channel-posts/drafts/{args.draft_id}",
            )
            # story #4441 (Qadir 4860 2nd line) — an empty answer proves nothing about the draft: never «not published yet»
            if draft is None:
                return err("초안 응답이 비어 있어 발행 여부를 알 수 없습니다 — 잠시 뒤 다시 조회해 주세요.")
            publication_id = draft.get("publication_id")
            if not publication_id:
                return err(
                    "이 초안은 아직 발행된 적이 없습니다(publication_id 없음) — "
                    "발행 후 다시 조회해 주세요.",
                )

        snapshots = as_list(await client.get(
            f"/api/v2/organizations/{client.org_id}/publications/{publication_id}/insights",
        ))
        delta, reason, superseded_count = _label_snapshots_and_compute_delta(snapshots)
        return ok({
            "publication_id": publication_id,
            "snapshots": snapshots,
            "delta_1d_to_7d": delta,
            "delta_unavailable_reason": reason,
            "superseded_snapshots": superseded_count,
        })
    except Exception as exc:
        return err(exc)


# story #4581(E-DESKTOP-2 · 1선, 페드루 PO 判定 2026-10-06 08:59Z) — 런처의 sprintable-channel
# 플러그인에만 있던 채널 글 도구를 호스티드 MCP로 올린다. 데스크톱 앱 세션은 이 서버를
# `sprintable-desktop`으로 대리해 쓰므로(브리지), 여기 올리면 앱으로 옮긴 에이전트도 같은
# 도구를 갖고 런처 쪽도 한 출처가 된다. 판정 로직은 0 — 플러그인(0.9.20 connectors/
# channel-posts.ts · channel-connection-status.ts)이 부르던 같은 REST를 같은 body로 부르고,
# 거절(조직 · 권한 · 연결 상태 · 길이 · 게이트)은 BE가 낸 그대로 err()로 돌려준다.
# 영상은 「올림 주소 → 바이트 PUT → 확인」 두 단계만(호스티드 프로세스는 에이전트의 로컬
# 파일을 못 읽는다 — 플러그인의 원격 런타임용 두 단계 도구와 같은 모양).


class CreateChannelPostDraftInput(SprintableInput):
    work_item_id: str
    connection_id: str
    text: str
    link_url: str | None = None
    hook_key: str | None = None


async def create_channel_post_draft(args: CreateChannelPostDraftInput) -> list[TextContent]:
    """작업(work item) 하나에 붙는 채널 글 초안을 만들거나(첫 호출) 새 버전으로 고친다(다시 부름)."""
    try:
        result = await client.post(
            f"/api/v2/organizations/{client.org_id}/channel-posts/drafts",
            json={"work_item_id": args.work_item_id, "connection_id": args.connection_id, "text": args.text,
                  "link_url": args.link_url, "hook_key": args.hook_key},
        )
        return ok(result)
    except Exception as exc:
        return err(exc)


class SubmitChannelPostDraftInput(SprintableInput):
    draft_id: str
    version_id: str | None = None


async def submit_channel_post_draft(args: SubmitChannelPostDraftInput) -> list[TextContent]:
    """초안 버전(생략=최신)을 external_publish 게이트에 올려 사람 승인을 받는다 — 발행은 승인 뒤 서버가 한다."""
    try:
        result = await client.post(
            f"/api/v2/organizations/{client.org_id}/channel-posts/drafts/{args.draft_id}/submit",
            json={"version_id": args.version_id},
        )
        return ok(result)
    except Exception as exc:
        return err(exc)


class GetChannelPostPublicationInput(SprintableInput):
    draft_id: str


async def get_channel_post_publication(args: GetChannelPostPublicationInput) -> list[TextContent]:
    """채널 글 초안 하나 — 상태 · 발행 결과(퍼머링크 등)를 서버가 준 그대로."""
    try:
        result = await client.get(f"/api/v2/organizations/{client.org_id}/channel-posts/drafts/{args.draft_id}")
        return ok(result)
    except Exception as exc:
        return err(exc)


class ListChannelConnectionsInput(SprintableInput):
    pass


async def list_channel_connections(args: ListChannelConnectionsInput) -> list[TextContent]:
    """이 조직의 채널 연결 중 에이전트가 쓸 수 있는 것(id · 채널 · 계정 이름 · 상태) — 자격 값은 없다."""
    try:
        result = await client.get(f"/api/v2/organizations/{client.org_id}/channel-connections/agent-visible")
        return ok(as_list(result))
    except Exception as exc:
        return err(exc)


class GetMyChannelConnectionStatusInput(SprintableInput):
    work_item_type: str
    work_item_id: str


async def get_my_channel_connection_status(args: GetMyChannelConnectionStatusInput) -> list[TextContent]:
    """작업이 지금 선 레시피 단계에 묶인 채널 연결의 상태(needs_reauth 등) — 발행 전에 한 번."""
    try:
        result = await client.get(
            f"/api/v2/events/work-items/{quote(args.work_item_type, safe='')}/{quote(args.work_item_id, safe='')}/channel-connection",
        )
        return ok(result)
    except Exception as exc:
        return err(exc)


class AttachChannelPostImageInput(SprintableInput):
    draft_id: str
    image_base64: str
    content_type: str


async def attach_channel_post_image(args: AttachChannelPostImageInput) -> list[TextContent]:
    """초안에 이미지 하나(base64)를 붙인다 — 새 초안 버전이 생긴다."""
    try:
        result = await client.post(
            f"/api/v2/organizations/{client.org_id}/channel-posts/drafts/{args.draft_id}/assets/import-image",
            json={"image_base64": args.image_base64, "content_type": args.content_type},
        )
        return ok(result)
    except Exception as exc:
        return err(exc)


class GetChannelPostVideoUploadUrlInput(SprintableInput):
    draft_id: str
    content_type: str


async def get_channel_post_video_upload_url(args: GetChannelPostVideoUploadUrlInput) -> list[TextContent]:
    """영상 1/2단계 — 서명된 올림 주소를 받는다(그 주소로 바이트를 PUT한 뒤 confirm)."""
    try:
        result = await client.post(
            f"/api/v2/organizations/{client.org_id}/channel-posts/drafts/{args.draft_id}/assets/video/upload-url",
            json={"content_type": args.content_type},
        )
        return ok(result)
    except Exception as exc:
        return err(exc)


class ConfirmChannelPostVideoInput(SprintableInput):
    draft_id: str
    object_path: str


async def confirm_channel_post_video(args: ConfirmChannelPostVideoInput) -> list[TextContent]:
    """영상 2/2단계 — 올린 객체를 초안에 붙인다(새 초안 버전)."""
    try:
        result = await client.post(
            f"/api/v2/organizations/{client.org_id}/channel-posts/drafts/{args.draft_id}/assets/video/confirm",
            json={"object_path": args.object_path},
        )
        return ok(result)
    except Exception as exc:
        return err(exc)
