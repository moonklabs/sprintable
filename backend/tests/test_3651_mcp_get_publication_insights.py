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
    *, due_at: str, status: str = "captured", normalized: dict | None = None, channel: str = "facebook_sandbox",
) -> dict:
    return {
        "id": f"snap-{due_at}", "channel": channel, "due_at": due_at, "captured_at": due_at,
        "status": status, "normalized": normalized, "source": "facebook_sandbox", "error_code": None,
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
        _snapshot(due_at="2026-09-08T00:00:00Z", normalized={"impressions": 100, "clicks": 10, "spend": None}),
        _snapshot(due_at="2026-09-14T00:00:00Z", normalized={"impressions": 250, "clicks": 40, "spend": None}),
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
        _snapshot(due_at="2026-09-08T00:00:00Z", normalized={"impressions": 100}),
        _snapshot(due_at="2026-09-14T00:00:00Z", status="pending", normalized=None),
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
        _snapshot(due_at="2026-09-08T00:00:00Z", normalized={"spend": None, "conversions": 5}),
        _snapshot(due_at="2026-09-14T00:00:00Z", normalized={"spend": None, "conversions": 12}),
    ]
    monkeypatch.setattr(channel_posts.client, "get", _RecordingGet([snapshots]))
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(
        channel_posts.GetPublicationInsightsInput(publication_id="pub-1"),
    )
    body = jsonlib.loads(result[0].text)

    assert body["delta_1d_to_7d"]["spend"] is None
    assert body["delta_1d_to_7d"]["conversions"] == 7


async def test_draft_id_without_publication_surfaces_be_error_as_text(monkeypatch):
    """다른 org의 draft_id(또는 존재하지 않는 draft_id)를 주면 draft 상세 조회 자체가
    BE에서 404로 거부된다 — SprintableApiError를 삼키지 않고 그대로 err()로 낸다(3651
    AC1 「다른 org publication → 404/403」의 실제 발생 지점: publication_id 직접 조회는
    org WHERE절 불일치가 빈 목록으로 떨어지는 기존 설계라, 거부는 draft_id 경로에서 난다)."""
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
    snapshots = [_snapshot(due_at="2026-09-08T00:00:00Z", normalized={"impressions": 5})]
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


async def test_neither_id_given_rejected_before_any_http_call(monkeypatch):
    from sprintable_mcp.tools import channel_posts

    recorder = _RecordingGet([])
    monkeypatch.setattr(channel_posts.client, "get", recorder)
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-1"))

    result = await channel_posts.get_publication_insights(channel_posts.GetPublicationInsightsInput())
    assert result[0].text.startswith("Error:")
    assert recorder.calls == []
