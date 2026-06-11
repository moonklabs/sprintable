"""E1-S5: MCP hypothesis 6도구 테스트 (블루프린트 §4).

도구는 v2 API의 얇은 래퍼 — body/params 구성·compact 반환·toolset group/path 매핑 검증.
권한(agent=proposed 강제·active=휴먼) 자체는 백엔드 API가 SSOT(S2/S3에서 검증).
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.tools import hypotheses as h


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(**methods):
    c = MagicMock()
    c.project_id = "proj-1"
    for name, ret in methods.items():
        setattr(c, name, AsyncMock(return_value=ret))
    return c


# ── compact / list ─────────────────────────────────────────────────────────────

def test_compact_excludes_long_fields_and_flattens_metric():
    full = {
        "id": "h1", "status": "active", "statement": "s",
        "metric_definition": {"metric": "signups", "target": 100, "direction": "up", "source": "manual"},
        "measure_after": "2026-07-01T00:00:00Z", "epic_ids": ["e1"], "story_ids": ["s1"],
        "outcome_result": {"big": "x"}, "source_snapshot": {"y": "z"}, "human_accounting": {},
    }
    c = h._compact(full)
    assert c == {
        "id": "h1", "status": "active", "statement": "s",
        "metric": "signups", "target": 100, "direction": "up",
        "measure_after": "2026-07-01T00:00:00Z", "epic_ids": ["e1"], "story_ids": ["s1"],
    }
    assert "outcome_result" not in c and "source_snapshot" not in c


async def test_list_passes_filters_and_compacts():
    rows = [{"id": "h1", "status": "active", "statement": "s",
             "metric_definition": {"metric": "m", "target": 1, "direction": "up"},
             "measure_after": "2026-07-01", "epic_ids": [], "story_ids": [], "outcome_result": {"x": 1}}]
    client = _client(get=rows)
    args = h.ListHypothesesInput(epic_id="e1", status=h.HypothesisStatus.active, limit=50)
    with patch.object(h, "client", client):
        out = await h.list_hypotheses(args)
    params = client.get.call_args.kwargs["params"]
    assert params == {"project_id": "proj-1", "epic_id": "e1", "status": "active", "limit": 50}
    data = json.loads(out[0].text)
    assert data[0]["metric"] == "m" and "outcome_result" not in data[0]


# ── create: project_id 주입·status 미전송(서버가 proposed 강제) ──────────────────

async def test_create_builds_body_without_status():
    client = _client(post={"id": "h1", "status": "proposed"})
    args = h.CreateHypothesisInput(
        statement="가설", metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
        measure_after="2026-07-01T00:00:00Z", epic_ids=["e1"], owner_member_id="o1",
    )
    with patch.object(h, "client", client):
        await h.create_hypothesis(args)
    path, kwargs = client.post.call_args.args[0], client.post.call_args.kwargs
    body = kwargs["json"]
    assert path == "/api/v2/hypotheses"
    assert body["project_id"] == "proj-1" and body["statement"] == "가설"
    assert body["epic_ids"] == ["e1"] and body["owner_member_id"] == "o1"
    assert "status" not in body  # 서버가 agent 호출을 proposed로 강제


async def test_create_omits_unset_optionals():
    client = _client(post={"id": "h1"})
    args = h.CreateHypothesisInput(
        statement="s", metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
        measure_after="2026-07-01",
    )
    with patch.object(h, "client", client):
        await h.create_hypothesis(args)
    body = client.post.call_args.kwargs["json"]
    assert set(body) == {"project_id", "statement", "metric_definition", "measure_after"}


# ── update: 제공 필드만 / confirm: transition ─────────────────────────────────

async def test_update_sends_only_provided():
    client = _client(patch={"id": "h1"})
    args = h.UpdateHypothesisInput(hypothesis_id="h1", statement="revised")
    with patch.object(h, "client", client):
        await h.update_hypothesis(args)
    assert client.patch.call_args.args[0] == "/api/v2/hypotheses/h1"
    assert client.patch.call_args.kwargs["json"] == {"statement": "revised"}


async def test_link_body():
    client = _client(post={"id": "h1"})
    args = h.LinkHypothesisInput(hypothesis_id="h1", epic_ids=["e1"], link_type="primary")
    with patch.object(h, "client", client):
        await h.link_hypothesis(args)
    assert client.post.call_args.args[0] == "/api/v2/hypotheses/h1/links"
    assert client.post.call_args.kwargs["json"] == {"epic_ids": ["e1"], "link_type": "primary"}


async def test_confirm_posts_transition_with_status_and_note():
    client = _client(post={"id": "h1", "status": "killed"})
    args = h.ConfirmHypothesisInput(hypothesis_id="h1", status=h.HypothesisConfirmStatus.killed, note="drop")
    with patch.object(h, "client", client):
        await h.confirm_hypothesis(args)
    assert client.post.call_args.args[0] == "/api/v2/hypotheses/h1/transition"
    assert client.post.call_args.kwargs["json"] == {"status": "killed", "note": "drop"}


# ── get: source_snapshot truncate ──────────────────────────────────────────────

async def test_get_truncates_large_source_snapshot():
    big = {"blob": "x" * 5000}
    client = _client(get={"id": "h1", "source_snapshot": big})
    with patch.object(h, "client", client):
        out = await h.get_hypothesis(h.GetHypothesisInput(hypothesis_id="h1"))
    data = json.loads(out[0].text)
    assert "_truncated" in data["source_snapshot"]
    assert len(data["source_snapshot"]["_truncated"]) == 1024


# ── toolset group / path 매핑 (양쪽 동일) ──────────────────────────────────────

def test_toolset_group_and_path_mapping():
    from app.services.mcp_toolset import path_to_tool_group
    from app.services.mcp_toolset import tool_group as ssot
    from sprintable_mcp.toolset import tool_group as vendored
    for tool in ("sprintable_list_hypotheses", "sprintable_create_hypothesis",
                 "sprintable_confirm_hypothesis"):
        assert vendored(tool) == "hypotheses"
        assert ssot(tool) == "hypotheses"
    assert path_to_tool_group("/api/v2/hypotheses") == "hypotheses"
    assert path_to_tool_group("/api/v2/hypotheses/abc/transition") == "hypotheses"
    # 충돌 없음 — epics 여전히 정상
    assert ssot("sprintable_list_epics") == "epics"
