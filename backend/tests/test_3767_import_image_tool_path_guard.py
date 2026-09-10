"""story #3767 — `sprintable_create_artifact` 도구 설명·`AGENTS.md`가 한때 존재하지 않는
백엔드 경로(`$SPRINTABLE_API_URL/api/visual-artifacts/import-image`, v2 없음·multipart)를
에이전트에게 가리켜 문서대로 하면 404였다(실제 에이전트-키 도달 가능 경로는 `/api/v2/...`
JSON base64 원콜뿐 — 그 자체가 이미 artifact를 만들어 완결되고, 별도 "업로드만 하고 url을
돌려주는" 입구가 백엔드엔 없다).

이 가드는 그 정확한 문자열(env var 접두 `$SPRINTABLE_API_URL` + v2 없는 경로)이 에이전트가
읽는 두 문서 표면에 다시 안 들어오게 한다 — FE 브라우저 코드(`/api/visual-artifacts/
import-image`, 세션 쿠키 인증, v2 없는 게 정답)는 대상이 아니다(다른 계약, 다른 경로 층)."""
from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_STALE_PATTERN = "$SPRINTABLE_API_URL/api/visual-artifacts/import-image"

_AGENT_FACING_DOCS = [
    _REPO_ROOT / "AGENTS.md",
    _REPO_ROOT / "backend/sprintable_mcp/server.py",
]


def test_no_stale_non_v2_import_image_path_in_agent_facing_docs():
    hits = []
    for path in _AGENT_FACING_DOCS:
        assert path.exists(), f"expected doc missing: {path}"
        text = path.read_text(encoding="utf-8")
        if _STALE_PATTERN in text:
            hits.append(str(path.relative_to(_REPO_ROOT)))
    assert hits == [], (
        f"옛(v2 없는) 에이전트용 이미지 임포트 경로 문자열이 아직 남아 있음: {hits} — "
        "실 경로는 /api/v2/visual-artifacts/import-image(JSON base64 원콜)뿐이다."
    )


def test_server_py_tool_description_points_agents_at_v2_endpoint():
    text = (_REPO_ROOT / "backend/sprintable_mcp/server.py").read_text(encoding="utf-8")
    assert "/api/v2/visual-artifacts/import-image" in text, (
        "sprintable_create_artifact 도구 설명이 이미지 임포트의 실 경로(v2)를 안내해야 한다."
    )
