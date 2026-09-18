"""story #3719 — MCP `emit_event`/`update_run_status`가 `last_error_code`를 실제 HTTP
payload에 실어 보내는지 pin(test_2389_mcp_update_field_wiring.py와 동형 패턴).

BE `UpdateAgentRun`엔 이미 `last_error_code`가 있었는데 `update_run_status`(tools/agent_runs.py)가
PATCH body 조립 시 순회하는 필드 목록에서 빠져 있어 «스키마엔 있는데 도구가 안 보내는» 갭이었다
(3707의 반대편 — 3707은 스키마 자체가 없었다). `CreateAgentRun`엔 필드 자체가 없어 `emit_event`
경로도 막혀 있었다.
"""
from __future__ import annotations

import sys

import pytest

sys.path.insert(0, ".")

pytestmark = pytest.mark.anyio


class _RecordingCall:
    """client.post/patch를 흉내내며 마지막 호출의 path/json을 기록한다."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, path: str, *, json: dict | None = None):
        self.calls.append((path, json or {}))
        return {"id": "irrelevant", **(json or {})}

    @property
    def last_json(self) -> dict:
        return self.calls[-1][1]


async def test_update_run_status_wires_last_error_code_into_patch_payload(monkeypatch):
    from sprintable_mcp.tools import agent_runs

    recorder = _RecordingCall()
    monkeypatch.setattr(agent_runs.client, "patch", recorder)

    args = agent_runs.UpdateRunStatusInput(run_id="r1", status="failed", last_error_code="E_TIMEOUT")
    await agent_runs.update_run_status(args)

    assert recorder.last_json.get("last_error_code") == "E_TIMEOUT", (
        "last_error_code가 UpdateRunStatusInput엔 선언돼 있지만 update_run_status()의 PATCH "
        "payload엔 실리지 않았다 — 스키마 선언과 handler 배선(body 조립 for-loop)이 따로 논다."
    )


async def test_update_run_status_omits_last_error_code_when_not_provided(monkeypatch):
    """미지정이면 payload에 아예 안 실려야(None 명시 전송으로 백엔드 값을 지우는 사고 방지)."""
    from sprintable_mcp.tools import agent_runs

    recorder = _RecordingCall()
    monkeypatch.setattr(agent_runs.client, "patch", recorder)

    args = agent_runs.UpdateRunStatusInput(run_id="r1", status="completed")
    await agent_runs.update_run_status(args)

    assert "last_error_code" not in recorder.last_json


async def test_emit_event_wires_last_error_code_into_post_payload(monkeypatch):
    from sprintable_mcp.tools import agent_runs

    recorder = _RecordingCall()
    monkeypatch.setattr(agent_runs.client, "post", recorder)
    monkeypatch.setattr(agent_runs.client, "require_project_id", lambda: "p1")

    args = agent_runs.EmitEventInput(agent_id="a1", trigger="manual", status="failed", last_error_code="E_TIMEOUT")
    await agent_runs.emit_event(args)

    assert recorder.last_json.get("last_error_code") == "E_TIMEOUT", (
        "last_error_code가 EmitEventInput엔 선언돼 있지만 emit_event()의 POST payload엔 안 실렸다."
    )


async def test_emit_event_omits_last_error_code_when_not_provided(monkeypatch):
    from sprintable_mcp.tools import agent_runs

    recorder = _RecordingCall()
    monkeypatch.setattr(agent_runs.client, "post", recorder)
    monkeypatch.setattr(agent_runs.client, "require_project_id", lambda: "p1")

    args = agent_runs.EmitEventInput(agent_id="a1", trigger="manual")
    await agent_runs.emit_event(args)

    assert "last_error_code" not in recorder.last_json


async def test_update_run_status_still_wires_error_message_no_regression(monkeypatch):
    """story #3707 회귀 감시 — 같은 for-loop에 필드를 추가하며 기존 error_message 순서를 깨지
    않았는지."""
    from sprintable_mcp.tools import agent_runs

    recorder = _RecordingCall()
    monkeypatch.setattr(agent_runs.client, "patch", recorder)

    args = agent_runs.UpdateRunStatusInput(run_id="r1", status="failed", error_message="boom")
    await agent_runs.update_run_status(args)

    assert recorder.last_json.get("error_message") == "boom"
