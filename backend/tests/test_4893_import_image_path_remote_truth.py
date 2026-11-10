"""story 4893 — the hosted MCP server is REMOTE: it looks for `image_path` on its own disk. The tool said «if the file is local, use image_path (the server reads it)»,
which led every Mac-app agent into «not a regular file». The Mac app's host now reads the file and sends `image_base64` (a separate change in the desktop repo); what this
server owes the agent is the truth: the refusal text says WHY (the server is remote and looked on ITS disk) and what to do, and the tool descriptions no longer promise that
the server reads the agent's file."""
from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
os.environ.setdefault("AGENT_API_KEY", "sk_test")

from sprintable_mcp.server import _TOOL_DEFS  # noqa: E402
from sprintable_mcp.tools import visual_artifacts as va  # noqa: E402

_DESC = {name: desc for name, desc, *_ in _TOOL_DEFS}


@pytest.mark.anyio
async def test_a_path_the_server_cannot_see_is_refused_with_the_reason_and_the_other_ways(tmp_path):
    client = MagicMock()
    client.post = AsyncMock()
    args = va.ImportImageArtifactInput(title="Shot", image_path=str(tmp_path / "on-the-agents-mac.png"))
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)
    text = out[0].text
    assert text.startswith("Error:")
    assert "일반 파일" in text, "the old wording stays (existing callers · tests)"
    assert "원격" in text and "이 서버의 디스크" in text, "it says the server looked on ITS disk"
    assert "맥 앱" in text and "image_base64" in text and "/api/v2/visual-artifacts/import-image" in text, "and what to do instead"
    client.post.assert_not_called()


def test_the_import_tool_description_no_longer_promises_that_the_server_reads_the_agents_file():
    desc = _DESC["sprintable_import_image_artifact"]
    assert "서버가 직접 읽어" not in desc, "the false promise"
    assert "맥 앱" in desc and "원격" in desc, "who may use image_path, and why the others cannot"
    assert "image_base64" in desc


def test_the_create_artifact_description_points_image_path_at_the_mac_app_only():
    desc = _DESC["sprintable_create_artifact"]
    assert "파일이 로컬에 있으면 그 도구의 image_path" not in desc
    assert "맥 앱으로 붙은 에이전트는 그 도구의 image_path" in desc


def test_the_input_docstring_does_not_call_this_server_a_local_process():
    assert "에이전트 머신의 로컬 프로세스, api_client.py로 HTTP만" not in (va.ImportImageArtifactInput.__doc__ or "")


_REPO = Path(__file__).resolve().parents[2]


def test_agents_md_no_longer_says_the_server_reads_the_agents_file():
    text = (_REPO / "AGENTS.md").read_text(encoding="utf-8")
    assert "the server reads the bytes directly" not in text, "the false promise"
    assert "whenever the agent has filesystem access" not in text
    bullet = text[text.index("sprintable_import_image_artifact` with `image_path`") - 200 : text.index("sprintable_import_image_artifact` with `image_path`") + 700]
    assert "Mac app" in bullet and "remote" in bullet and "ITS OWN disk" in bullet


def test_the_tool_function_docstring_names_who_may_use_image_path():
    doc = va.import_image_artifact.__doc__ or ""
    assert "맥 앱" in doc and "파일시스템 없는 에이전트용" not in doc


def test_the_description_covers_the_case_of_an_old_app_that_does_not_convert_yet():
    """the server may be deployed before every app: the description must stay true then too"""
    desc = _DESC["sprintable_import_image_artifact"]
    assert "낡은 앱" in desc and "거절" in desc
