"""S7-2: E-MCP-PYTHON 에픽 최종 DoD 검증.

9 Phase, 총 31 스토리 완주 조건 자동 검증.

AC1: Python MCP 88개 도구 전량 계약 테스트 PASS
AC2: SSE 실시간 이벤트 수신 정상 (poll_events 도구 존재)
AC3: TS MCP 코드 레포에서 완전 제거 확인
AC4: .mcp.json 전 에이전트 Python 경로 확인
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).parent.parent.parent  # /Users/yoonjae/sprintable
BACKEND_ROOT = Path(__file__).parent.parent       # /Users/yoonjae/sprintable/backend
NEOCLAW_ROOT = Path.home() / ".neoclaw-nwachukwu"


# ─── AC1: Python MCP 88개 도구 계약 테스트 ──────────────────────────────────

def test_contract_tests_pass():
    """test_contract.py 전량 PASS — 도구 스키마 계약 검증."""
    result = subprocess.run(
        [str(BACKEND_ROOT / ".venv/bin/pytest"), "tests/mcp/test_contract.py", "-q", "--tb=no"],
        cwd=str(BACKEND_ROOT),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"계약 테스트 실패:\n{result.stdout}\n{result.stderr}"


def _get_registered_tool_names() -> set[str]:
    import os
    os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
    os.environ.setdefault("AGENT_API_KEY", "sk_test")
    from sprintable_mcp.server import mcp
    return set(mcp._tool_manager._tools.keys())


def test_tool_count_is_88():
    """server.py 등록 도구 수 ≥ 88 (ping 포함)."""
    tool_names = _get_registered_tool_names()
    assert len(tool_names) >= 88, f"도구 수 {len(tool_names)} < 88"


def test_poll_events_tool_registered():
    """AC2: poll_events 도구 등록 확인 — SSE 실시간 이벤트 수신 경로."""
    tool_names = _get_registered_tool_names()
    assert any("poll_event" in t for t in tool_names), (
        "poll_events 도구 미등록 — SSE 수신 경로 없음"
    )


# ─── AC3: TS MCP 코드 완전 제거 확인 ────────────────────────────────────────

def test_ts_mcp_package_directory_removed():
    """ee/packages/mcp-server-saas/ 디렉토리 부재."""
    ts_mcp_dir = REPO_ROOT / "ee" / "packages" / "mcp-server-saas"
    assert not ts_mcp_dir.exists(), f"TS MCP 디렉토리 잔존: {ts_mcp_dir}"


def test_ts_mcp_packages_dir_removed():
    """packages/mcp-server/ 디렉토리 부재 (Phase 4에서 제거됨)."""
    old_ts_mcp = REPO_ROOT / "packages" / "mcp-server"
    assert not old_ts_mcp.exists(), f"구 TS MCP 디렉토리 잔존: {old_ts_mcp}"


def test_ts_mcp_tsconfig_alias_removed():
    """apps/web/tsconfig.json에서 mcp-server-saas path alias 제거."""
    tsconfig = REPO_ROOT / "apps" / "web" / "tsconfig.json"
    if tsconfig.exists():
        content = tsconfig.read_text()
        assert "mcp-server-saas" not in content, "tsconfig.json에 mcp-server-saas alias 잔존"


def test_dockerfile_ts_mcp_copy_removed():
    """Dockerfile에서 mcp-server-saas COPY 라인 제거."""
    dockerfile = REPO_ROOT / "Dockerfile"
    if dockerfile.exists():
        content = dockerfile.read_text()
        assert "mcp-server-saas" not in content, "Dockerfile에 mcp-server-saas COPY 잔존"


@pytest.mark.skipif(
    sys.platform not in ("linux", "darwin"),
    reason="ps aux는 Unix only",
)
def test_ts_mcp_process_absent():
    """실행 중인 TS MCP 프로세스 전무."""
    result = subprocess.run(["ps", "aux"], capture_output=True, text=True, check=True)
    ts_procs = [l for l in result.stdout.splitlines() if "mcp-server/dist" in l]
    assert len(ts_procs) == 0, f"TS MCP 프로세스 잔존:\n" + "\n".join(ts_procs)


# ─── AC4: .mcp.json 전 에이전트 Python 경로 확인 ─────────────────────────────

def _check_mcp_json(path: Path) -> dict:
    """mcp.json 파일 파싱 후 sprintable 서버 설정 반환."""
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    return data.get("mcpServers", {})


AGENT_MCP_PATHS = [
    Path.home() / ".neoclaw-nwachukwu/state/actors/nwachukwu/workspace/.mcp.json",
    Path.home() / ".neoclaw-ortega/state/actors/ortega/workspace/.mcp.json",
    Path.home() / ".neoclaw-mirko/state/actors/mirko/workspace/.mcp.json",
    Path.home() / ".neoclaw-damrong/state/actors/damrong/workspace/.mcp.json",
]


@pytest.mark.parametrize("mcp_path", [p for p in AGENT_MCP_PATHS if p.exists()])
def test_agent_mcp_json_uses_python(mcp_path: Path):
    """각 에이전트 .mcp.json의 sprintable 서버가 Python MCP를 사용함."""
    servers = _check_mcp_json(mcp_path)
    sprintable_servers = {
        k: v for k, v in servers.items()
        if "sprintable" in k.lower() or "sprintable_mcp" in str(v.get("args", []))
    }
    assert len(sprintable_servers) >= 1, f"{mcp_path}: sprintable 서버 미설정"
    for name, cfg in sprintable_servers.items():
        cmd = cfg.get("command", "")
        args = cfg.get("args", [])
        assert cmd in ("uv", "python", "python3") or "python" in str(args), (
            f"{mcp_path} [{name}]: Python MCP 경로 아님 — command={cmd}, args={args}"
        )
        assert "mcp-server/dist" not in str(args), (
            f"{mcp_path} [{name}]: TS MCP 경로 잔존"
        )


def test_own_mcp_json_python_path():
    """은와추쿠군 .mcp.json — sprintable_mcp Python 경로 확인."""
    path = Path.home() / ".neoclaw-nwachukwu/state/actors/nwachukwu/workspace/.mcp.json"
    servers = _check_mcp_json(path)
    sprintable = {k: v for k, v in servers.items() if "sprintable" in k.lower()}
    assert sprintable, f".mcp.json에 sprintable 서버 없음: {path}"
    for name, cfg in sprintable.items():
        args = cfg.get("args", [])
        assert "sprintable_mcp" in str(args), f"sprintable_mcp 경로 없음: {cfg}"
