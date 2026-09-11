"""story #3651(Phase2·MCP·소형, 페드루 PO 確定 2026-09-07) — sprintable_get_publication_
insights 도구. 블루프린트 §7 Phase 2 AC 「1일·7일 성과를 비교해 후속 스토리를 만든다」의
에이전트 몫 — REST `/publications/{publication_id}/insights`(insight_snapshots.py:34)를
그대로 래핑하고, due_at 오름차순으로 offset_label(1d|7d)을 매겨 둘 사이 키별 델타를 낸다.

test_3614_mcp_withdraw_channel_post_draft.py의 monkeypatch 관례(client.get/post 교체 +
client.org_id property override)를 그대로 재사용(새 mock 패턴 발명 0)."""
from __future__ import annotations

import json as jsonlib
import sys

import pytest

sys.path.insert(0, ".")

pytestmark = pytest.mark.anyio


def _snapshot(
    *, due_at: str, offset_label: str | None, status: str = "captured", normalized: dict | None = None,
    channel: str = "facebook_sandbox",
) -> dict:
    """카디르 CHANGES(PR#4003) — offset_label은 이제 서버(insight_snapshots.py 라우터)
    가 정본을 매겨 보낸다. 이 MCP 계층은 더 이상 인덱스로 라벨링하지 않으므로, 이
    fixture가 서버 응답을 흉내 낼 때 명시적으로 값을 실어야 한다(암묵적 "첫째=1d"
    가정 재도입 금지 — 그게 이 버그의 원인이었다)."""
    return {
        "id": f"snap-{due_at}", "channel": channel, "due_at": due_at, "captured_at": due_at,
        "status": status, "normalized": normalized, "source": "facebook_sandbox", "error_code": None,
        "offset_label": offset_label,
    }


class _RecordingGet:
    """호출 순서대로 미리 등록한 응답을 반환(draft 조회 → insights 조회 2단 호출 검증용).
    단일 응답만 필요하면 responses=[그 값 하나]로."""

    def __init__(self, responses: list):
        self._responses = list(responses)
        self.calls: list[str] = []

    async def __call__(self, path: str, **_kwargs):
        self.calls.append(path)
        return self._responses.pop(0)


async def test_positive_delta_both_captured(monkeypatch):
    """양성 — 1일·7일 둘 다 captured면 키별 v7-v1 델타가 나온다(3651 AC1)."""
    from sprintable_mcp.tools import channel_posts

    snapshots = [
        _snapshot(due_at="2026-09-08T00:00:00Z", offset_label="1d", normalized={"impressions": 100, "clicks": 10, "spend": None}),
        _snapshot(due_at="2026-09-14T00:00:00Z", offset_label="7d", normalized={"impressions": 250, "clicks": 40, "spend": None}),
    ]
    recorder = _RecordingGet([snapshots])
    monkeypatch.setattr(channel_posts.client, "get", recorder)
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(publication_id="pub-1"),
    )
    body = jsonlib.loads(result[0].text)

    assert recorder.calls == ["/api/v2/organizations/org-1/publications/pub-1/insights"]
    assert body["snapshots"][0]["offset_label"] == "1d"
    assert body["snapshots"][1]["offset_label"] == "7d"
    assert body["delta_1d_to_7d"] == {"impressions": 150, "clicks": 30, "spend": None}
    assert body["delta_unavailable_reason"] is None


async def test_7d_pending_yields_null_delta_with_reason(monkeypatch):
    """7일이 아직 안 도래(pending)하면 델타는 null+사유(3651 AC1)."""
    from sprintable_mcp.tools import channel_posts

    snapshots = [
        _snapshot(due_at="2026-09-08T00:00:00Z", offset_label="1d", normalized={"impressions": 100}),
        _snapshot(due_at="2026-09-14T00:00:00Z", offset_label="7d", status="pending", normalized=None),
    ]
    monkeypatch.setattr(channel_posts.client, "get", _RecordingGet([snapshots]))
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(publication_id="pub-1"),
    )
    body = jsonlib.loads(result[0].text)

    assert body["delta_1d_to_7d"] is None
    assert "7일" in body["delta_unavailable_reason"]
    assert "pending" in body["delta_unavailable_reason"]


async def test_unprovided_metric_stays_null_not_zero(monkeypatch):
    """미제공(null) 지표는 델타도 null — 0으로 기록하지 않는다(3321 원칙, 3651 AC1 「미제공
    null 유지」). 뮤테이션 대상: 0으로 오기록하면 이 테스트가 RED가 돼야 한다."""
    from sprintable_mcp.tools import channel_posts

    snapshots = [
        _snapshot(due_at="2026-09-08T00:00:00Z", offset_label="1d", normalized={"spend": None, "conversions": 5}),
        _snapshot(due_at="2026-09-14T00:00:00Z", offset_label="7d", normalized={"spend": None, "conversions": 12}),
    ]
    monkeypatch.setattr(channel_posts.client, "get", _RecordingGet([snapshots]))
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(publication_id="pub-1"),
    )
    body = jsonlib.loads(result[0].text)

    assert body["delta_1d_to_7d"]["spend"] is None
    assert body["delta_1d_to_7d"]["conversions"] == 7


async def test_float_metrics_get_real_delta_not_null(monkeypatch):
    """페드루 CHANGES(2026-09-07, PR#4003) — 정규화 값이 float으로 와도(spend·GA4 유입
    파생값 등) «제공된 값」으로 취급해 실수 델타를 낸다. 이전 버전은 isinstance(v, int)만
    허용해 float 쌍이 조용히 null이 됐다(제공된 값을 미제공으로 오판). 한쪽만 float이고
    한쪽이 null이면(진짜 미제공) 여전히 null."""
    from sprintable_mcp.tools import channel_posts

    snapshots = [
        _snapshot(due_at="2026-09-08T00:00:00Z", offset_label="1d", normalized={"spend": 12.5, "ctr": None}),
        _snapshot(due_at="2026-09-14T00:00:00Z", offset_label="7d", normalized={"spend": 30.25, "ctr": 0.042}),
    ]
    monkeypatch.setattr(channel_posts.client, "get", _RecordingGet([snapshots]))
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(publication_id="pub-1"),
    )
    body = jsonlib.loads(result[0].text)

    assert body["delta_1d_to_7d"]["spend"] == pytest.approx(17.75)
    assert body["delta_1d_to_7d"]["ctr"] is None  # 1일값이 null(미제공)이라 여전히 null


async def test_direct_publication_id_cross_org_surfaces_404_not_fake_reason(monkeypatch):
    """story #3796(페드루 PO 確定 2026-09-10, 유나 실측) — 3651 원래 설계는 publication_id
    직접 조회 경로에서 org WHERE절 불일치를 빈 목록으로 떨어뜨려(아래
    test_draft_id_without_publication_surfaces_be_error_as_text의 예전 docstring이 그
    갭을 그대로 명시했었다), 이 계층이 그 빈 목록을 "스냅샷이 2건 미만…"이라는 거짓
    delta_unavailable_reason으로 번역해 냈다(데이터는 안 새지만 "기다리면 된다"로
    읽히는 오도 — 진실은 "네 org 것이 아니다"). BE(insight_snapshots.py 라우터)가
    이제 이 경우 404를 낸다 — SprintableApiError를 삼키지 않고 그대로 err()로 전파돼야
    한다(거짓 사유 조합 0)."""
    from sprintable_mcp.tools import channel_posts
    from sprintable_mcp.api_client import SprintableApiError

    async def _raise(path: str, **_kwargs):
        raise SprintableApiError(404, "이 조직에 없는 발행물입니다", None)

    monkeypatch.setattr(channel_posts.client, "get", _raise)
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(publication_id="pub-foreign-org"),
    )
    assert result[0].text.startswith("Error:")
    assert "이 조직에 없는 발행물" in result[0].text
    assert "delta_unavailable_reason" not in result[0].text
    assert "스냅샷이 2건 미만" not in result[0].text


async def test_draft_id_without_publication_surfaces_be_error_as_text(monkeypatch):
    """다른 org의 draft_id(또는 존재하지 않는 draft_id)를 주면 draft 상세 조회 자체가
    BE에서 404로 거부된다 — SprintableApiError를 삼키지 않고 그대로 err()로 낸다(draft_id
    편의 축 자신의 org 경계 — publication_id 직접 조회 축의 경계 정정은 위
    test_direct_publication_id_cross_org_surfaces_404_not_fake_reason·story #3796)."""
    from sprintable_mcp.tools import channel_posts
    from sprintable_mcp.api_client import SprintableApiError

    async def _raise(path: str, **_kwargs):
        raise SprintableApiError(404, "draft를 찾을 수 없습니다: draft-foreign", None)

    monkeypatch.setattr(channel_posts.client, "get", _raise)
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(draft_id="draft-foreign"),
    )
    assert result[0].text.startswith("Error:")
    assert "찾을 수 없습니다" in result[0].text


async def test_draft_id_resolves_publication_id_then_fetches_insights(monkeypatch):
    """draft_id만 주면 초안 상세에서 publication_id를 읽어 그 값으로 insights를 다시
    조회한다(3651 처방③ — draft_id 편의 축). 2단 호출 순서를 직접 검증."""
    from sprintable_mcp.tools import channel_posts

    draft = {"id": "draft-1", "publication_id": "pub-9"}
    snapshots = [_snapshot(due_at="2026-09-08T00:00:00Z", offset_label="1d", normalized={"impressions": 5})]
    recorder = _RecordingGet([draft, snapshots])
    monkeypatch.setattr(channel_posts.client, "get", recorder)
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(draft_id="draft-1"),
    )
    body = jsonlib.loads(result[0].text)

    assert recorder.calls == [
        "/api/v2/organizations/org-1/channel-posts/drafts/draft-1",
        "/api/v2/organizations/org-1/publications/pub-9/insights",
    ]
    assert body["publication_id"] == "pub-9"


async def test_draft_never_published_reports_no_publication(monkeypatch):
    """publication_id가 null인 초안(발행된 적 없음)은 insights를 조회하지 않고 그 사실을
    알린다(불필요 호출 0)."""
    from sprintable_mcp.tools import channel_posts

    recorder = _RecordingGet([{"id": "draft-1", "publication_id": None}])
    monkeypatch.setattr(channel_posts.client, "get", recorder)
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(draft_id="draft-1"),
    )
    assert result[0].text.startswith("Error:")
    assert "발행된 적이 없습니다" in result[0].text
    assert len(recorder.calls) == 1  # insights 조회는 안 나감


async def test_republish_superseded_snapshots_excluded_from_delta(monkeypatch):
    """카디르 발견(PR#4003, 2026-09-07) — hosted_site 재발행은 같은 publication_id를
    유지한 채 published_at을 갱신하고 새 due_at 2행을 더 연다(UNIQUE(publication_id,
    due_at)는 «새» due_at을 안 막는다). 4건(최초 1d/7d + 재발행 1d/7d) 표본에서 옛
    인덱스 라벨링("idx0=1d·나머지=7d")은 최초 사이클의 due_at 순번을 오라벨했다 —
    이제 서버가 매긴 offset_label을 그대로 읽으므로, null 라벨(최초 사이클 잔존
    2건)은 델타에서 빠지고 재발행 짝(1d/7d)만으로 델타가 나며 superseded_snapshots
    =2로 알려야 한다."""
    from sprintable_mcp.tools import channel_posts

    snapshots = [
        # 최초 발행 사이클 — 재발행으로 due_at이 더 이상 «지금» published_at의
        # +1일/+7일 어느 쪽도 아니게 된 잔존 스냅샷(서버가 null로 라벨).
        _snapshot(due_at="2026-09-01T00:00:00Z", offset_label=None, normalized={"impressions": 10}),
        _snapshot(due_at="2026-09-07T00:00:00Z", offset_label=None, normalized={"impressions": 20}),
        # 재발행 사이클 — 이 둘만 «지금» published_at 기준 유효한 1d/7d.
        _snapshot(due_at="2026-09-08T00:00:00Z", offset_label="1d", normalized={"impressions": 100}),
        _snapshot(due_at="2026-09-14T00:00:00Z", offset_label="7d", normalized={"impressions": 250}),
    ]
    monkeypatch.setattr(channel_posts.client, "get", _RecordingGet([snapshots]))
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(publication_id="pub-1"),
    )
    body = jsonlib.loads(result[0].text)

    assert body["delta_1d_to_7d"] == {"impressions": 150}  # 250-100(재발행 짝), 20-10(최초)이 아니다
    assert body["delta_unavailable_reason"] is None
    assert body["superseded_snapshots"] == 2


async def test_neither_id_given_rejected_before_any_http_call(monkeypatch):
    from sprintable_mcp.tools import channel_posts

    recorder = _RecordingGet([])
    monkeypatch.setattr(channel_posts.client, "get", recorder)
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(channel_posts.GetPublicationInsightsInput())
    assert result[0].text.startswith("Error:")
    assert recorder.calls == []
