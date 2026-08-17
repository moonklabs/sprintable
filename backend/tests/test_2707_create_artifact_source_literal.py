"""story #2707 부수④ — CreateArtifactInput.source를 Literal["created","imported"]로 고정.

배경: 이전엔 source: str | None이라 커스텀 문자열을 넣으면 MCP 레벨에선 통과하고 BE
POST /api/v2/visual-artifacts에서야 422가 났다(호출 前엔 유효값을 알기 어려움). Literal로
스키마 자체에 유효값을 못박아 잘못된 값이 네트워크 호출 前에 pydantic ValidationError로
걸러지는지 고정한다.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from sprintable_mcp.tools.visual_artifacts import CreateArtifactInput


def test_source_accepts_created():
    args = CreateArtifactInput(title="t", source="created")
    assert args.source == "created"


def test_source_accepts_imported():
    args = CreateArtifactInput(title="t", source="imported")
    assert args.source == "imported"


def test_source_defaults_to_none_when_omitted():
    args = CreateArtifactInput(title="t")
    assert args.source is None


def test_source_rejects_invalid_value_before_network_call():
    with pytest.raises(ValidationError):
        CreateArtifactInput(title="t", source="draft")
