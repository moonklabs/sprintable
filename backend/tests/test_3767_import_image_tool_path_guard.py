"""story #3767 — `sprintable_create_artifact`/`sprintable_import_image_artifact` 도구
설명·`AGENTS.md`가 한때 존재하지 않는 백엔드 경로(`$SPRINTABLE_API_URL/api/visual-
artifacts/import-image`, v2 없음·multipart)나 존재하지 않는 흐름("create_artifact의
2단계 curl 플로우")을 에이전트에게 가리켰다 — 실제 에이전트-키 도달 가능 경로는
`/api/v2/...` JSON base64 원콜뿐이고, 그 자체가 이미 artifact를 만들어 완결되며, 별도
"업로드만 하고 url을 돌려주는" 입구가 백엔드엔 없다.

카디르 QA(#4119, 2026-09-10) — 최초판 가드가 `server.py` 파일 전체 텍스트에서 v2 문자열을
찾아, 그 문자열이 엉뚱한(예: 다른 도구의) 설명에 있어도 통과했다(뮤테이션으로 실측: 대상
설명에서 지우고 무관 주석에만 남겨도 GREEN이었음 — 자가 다른 것을 잼). 이 가드는 `_TOOL_DEFS`를
실제로 import해 **정확히 그 두 도구의 설명 문자열 안**만 본다."""
from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
os.environ.setdefault("AGENT_API_KEY", "sk_test")

from sprintable_mcp.server import _TOOL_DEFS  # noqa: E402

_TOOL_DESCRIPTIONS = {name: desc for name, desc, *_ in _TOOL_DEFS}

_REPO_ROOT = Path(__file__).resolve().parents[2]
_STALE_PATH_PATTERN = "$SPRINTABLE_API_URL/api/visual-artifacts/import-image"
_STALE_TWO_STEP_PATTERN = "create_artifact의 2단계 curl"

_AGENT_FACING_DOCS = [
    _REPO_ROOT / "AGENTS.md",
    _REPO_ROOT / "backend/sprintable_mcp/server.py",
]


def test_no_stale_non_v2_import_image_path_in_agent_facing_docs():
    hits = []
    for path in _AGENT_FACING_DOCS:
        assert path.exists(), f"expected doc missing: {path}"
        text = path.read_text(encoding="utf-8")
        if _STALE_PATH_PATTERN in text:
            hits.append(str(path.relative_to(_REPO_ROOT)))
    assert hits == [], (
        f"옛(v2 없는) 에이전트용 이미지 임포트 경로 문자열이 아직 남아 있음: {hits} — "
        "실 경로는 /api/v2/visual-artifacts/import-image(JSON base64 원콜)뿐이다."
    )


# ⭐되돌리면 RED — 카디르 QA #4119: 이 함수가 정확히 sprintable_create_artifact 설명
# «안»을 보는지(파일 전체가 아니라)를 고정한다. 그 설명에서 v2 문자열을 지우면(다른 곳엔
# 남겨도) 반드시 RED여야 한다.
def test_create_artifact_description_points_agents_at_v2_endpoint():
    desc = _TOOL_DESCRIPTIONS["sprintable_create_artifact"]
    assert "/api/v2/visual-artifacts/import-image" in desc, (
        "sprintable_create_artifact 도구 설명 자체가 이미지 임포트의 실 경로(v2)를 안내해야 한다."
    )


# ⭐되돌리면 RED — 카디르 QA #4119 두 번째 지적: sprintable_import_image_artifact 자신의
# 설명이 "create_artifact의 2단계 curl 플로우"를 다시 언급하면(존재하지 않는 흐름) RED.
def test_import_image_artifact_description_does_not_reference_nonexistent_two_step_flow():
    desc = _TOOL_DESCRIPTIONS["sprintable_import_image_artifact"]
    assert _STALE_TWO_STEP_PATTERN not in desc, (
        "sprintable_import_image_artifact 설명이 create_artifact 쪽의 «2단계 curl 플로우»를 "
        "다시 언급함 — 그런 흐름은 없다(별도 업로드-전용 백엔드 입구 자체가 없음, story #3767)."
    )


def test_create_artifact_description_does_not_reference_nonexistent_two_step_flow():
    desc = _TOOL_DESCRIPTIONS["sprintable_create_artifact"]
    assert _STALE_TWO_STEP_PATTERN not in desc
