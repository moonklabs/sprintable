"""story #2711 — image artifact props.src가 raw 무서명 GCS url이라 렌더가 403 나던 결함.

축:
- AC1: 우리 버킷 raw url은 응답 직전 signed_read_url로 교체된다.
- AC2(ⓐ): 「우리 버킷 host」 판정 함수 하나로 좁혀, 외부 url은 절대 서명 시도하지 않는다.
- AC3(ⓑ): 왕복 오염 가드 — 서명 쿼리가 붙은 url이 들어와도 저장 시점엔 항상 raw로 되돌린다.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services.artifact_image_url import (
    _BUCKET,
    _canonicalize_props,
    _our_bucket_object_path,
    _sign_image_props,
    sign_image_srcs_in_nodes,
)

_RAW = f"https://storage.googleapis.com/{_BUCKET}/org/o1/project/p1/canvas-import/abc-shot.png"
_SIGNED = _RAW + "?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef"
_EXTERNAL = "https://example.com/some-other-image.png"


# ── ⓐ 버킷-host 판정 (단일 함수) ────────────────────────────────────────────

def test_our_bucket_object_path_extracts_path_from_raw_url():
    assert _our_bucket_object_path(_RAW) == "org/o1/project/p1/canvas-import/abc-shot.png"


def test_our_bucket_object_path_strips_signed_query():
    """서명 쿼리스트링이 붙어 있어도(왕복으로 되돌아온 값) 같은 object_path를 뽑는다."""
    assert _our_bucket_object_path(_SIGNED) == "org/o1/project/p1/canvas-import/abc-shot.png"


def test_our_bucket_object_path_returns_none_for_external_url():
    assert _our_bucket_object_path(_EXTERNAL) is None


def test_our_bucket_object_path_returns_none_for_empty():
    assert _our_bucket_object_path("") is None
    assert _our_bucket_object_path(None) is None  # type: ignore[arg-type]


# ── ⓑ 왕복 오염 가드 — write 경로(_canonicalize_props) ──────────────────────

def test_canonicalize_props_strips_signed_query_back_to_raw():
    props = {"src": _SIGNED}
    result = _canonicalize_props(props)
    assert result["src"] == _RAW
    assert "X-Goog-Signature" not in result["src"]


def test_canonicalize_props_passes_through_external_url_unchanged():
    props = {"src": _EXTERNAL}
    result = _canonicalize_props(props)
    assert result["src"] == _EXTERNAL


def test_canonicalize_props_passes_through_props_without_src():
    props = {"html": "<div>hi</div>"}
    result = _canonicalize_props(props)
    assert result == props


def test_canonicalize_props_handles_none():
    assert _canonicalize_props(None) is None


def test_canonicalize_props_mutation_kill_disabled_guard_leaves_signature():
    """⭐뮤테이션킬 — 가드가 없으면(no-op) 서명 쿼리가 그대로 남는다는 것을 대조로 확認,
    이 테스트 자체는 실제 가드가 켜져 있을 때 정상 통과해야 한다(음성 대조 아님·본 동작 확認)."""
    props = {"src": _SIGNED}
    result = _canonicalize_props(props)
    assert "?" not in result["src"], "서명 쿼리스트링이 저장 경로까지 살아남음 — 왕복 오염 가드 작동 안 함"


# ── AC1 — read 경로(_sign_image_props/sign_image_srcs_in_nodes) ─────────────

@pytest.mark.anyio
async def test_sign_image_props_replaces_our_bucket_raw_url():
    with patch("app.services.storage.get_storage_provider") as mock_get_provider:
        mock_provider = AsyncMock()
        mock_provider.signed_read_url = AsyncMock(return_value="https://signed.example/fresh?sig=x")
        mock_get_provider.return_value = mock_provider

        result = await _sign_image_props({"src": _RAW})

        assert result["src"] == "https://signed.example/fresh?sig=x"
        mock_provider.signed_read_url.assert_called_once()
        call_args = mock_provider.signed_read_url.call_args
        assert call_args.args[0] == _BUCKET
        assert call_args.args[1] == "org/o1/project/p1/canvas-import/abc-shot.png"


@pytest.mark.anyio
async def test_sign_image_props_never_signs_external_url():
    """⭐ⓐ 핵심 — 외부 url은 signed_read_url 자체를 호출하지 않는다(오서명 방지)."""
    with patch("app.services.storage.get_storage_provider") as mock_get_provider:
        mock_provider = AsyncMock()
        mock_provider.signed_read_url = AsyncMock(return_value="should-not-be-called")
        mock_get_provider.return_value = mock_provider

        result = await _sign_image_props({"src": _EXTERNAL})

        assert result["src"] == _EXTERNAL
        mock_provider.signed_read_url.assert_not_called()


@pytest.mark.anyio
async def test_sign_image_props_best_effort_on_signing_failure():
    """서명 발급 실패(None) 시 raw url이라도 그대로 남긴다(export 경로와 동형 best-effort)."""
    with patch("app.services.storage.get_storage_provider") as mock_get_provider:
        mock_provider = AsyncMock()
        mock_provider.signed_read_url = AsyncMock(return_value=None)
        mock_get_provider.return_value = mock_provider

        result = await _sign_image_props({"src": _RAW})

        assert result["src"] == _RAW


@pytest.mark.anyio
async def test_sign_image_srcs_in_nodes_mutates_in_place():
    class _FakeNode:
        def __init__(self, props):
            self.props = props

    nodes = [_FakeNode({"src": _RAW}), _FakeNode({"html": "<div/>"}), _FakeNode(None)]

    with patch("app.services.storage.get_storage_provider") as mock_get_provider:
        mock_provider = AsyncMock()
        mock_provider.signed_read_url = AsyncMock(return_value="https://signed.example/x")
        mock_get_provider.return_value = mock_provider

        await sign_image_srcs_in_nodes(nodes)

        assert nodes[0].props["src"] == "https://signed.example/x"
        assert nodes[1].props == {"html": "<div/>"}
        assert nodes[2].props is None
