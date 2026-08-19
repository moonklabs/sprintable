"""office_conversion 순수 로직 단위 테스트 (#2771 §7). DB/네트워크 불요."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import office_conversion


def test_is_convertible_pptx_only():
    assert office_conversion.is_convertible("deck.pptx", None) is True
    assert office_conversion.is_convertible("DECK.PPTX", None) is True  # 대소문자 무관
    # docx는 별도 트랙(클라이언트 렌더) — 이 파이프 범위 밖.
    assert office_conversion.is_convertible("doc.docx", None) is False
    assert office_conversion.is_convertible("image.png", "image/png") is False
    assert office_conversion.is_convertible("noext", None) is False


def test_converted_object_path_deterministic():
    org = uuid.UUID("11111111-1111-1111-1111-111111111111")
    proj = uuid.UUID("22222222-2222-2222-2222-222222222222")
    source = uuid.UUID("33333333-3333-3333-3333-333333333333")

    p1 = office_conversion.converted_object_path(org, proj, source)
    p2 = office_conversion.converted_object_path(org, proj, source)
    assert p1 == p2  # 결정적 — 캐시 키로 쓰려면 재호출해도 동일해야 함
    assert p1 == f"converted/{org}/{proj}/{source}.pdf"


def test_converted_object_path_org_level_no_project():
    org = uuid.UUID("11111111-1111-1111-1111-111111111111")
    source = uuid.UUID("33333333-3333-3333-3333-333333333333")
    p = office_conversion.converted_object_path(org, None, source)
    assert p == f"converted/{org}/org/{source}.pdf"


def test_pdf_name_replaces_extension():
    assert office_conversion._pdf_name("quarterly deck.pptx") == "quarterly deck.pdf"
    assert office_conversion._pdf_name("noext") == "noext.pdf"


async def test_call_gotenberg_unavailable_when_url_unset(monkeypatch):
    monkeypatch.setattr(office_conversion, "_GOTENBERG_URL", "")
    try:
        await office_conversion._call_gotenberg("x.pptx", b"data")
    except office_conversion.ConversionUnavailable:
        pass
    else:
        raise AssertionError("expected ConversionUnavailable")


def _mock_gotenberg_response(status_code: int, content: bytes):
    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    mock_resp.content = content
    mock_client = AsyncMock()
    mock_client.__aenter__.return_value.post = AsyncMock(return_value=mock_resp)
    return mock_client


async def test_call_gotenberg_accepts_valid_pdf_magic(monkeypatch):
    """정상 케이스 — %PDF- 매직으로 시작하는 200 응답은 그대로 통과."""
    monkeypatch.setattr(office_conversion, "_GOTENBERG_URL", "https://example.internal")
    monkeypatch.setattr(office_conversion, "_id_token_header", lambda: {})
    mock_client = _mock_gotenberg_response(200, b"%PDF-1.4 real pdf bytes")
    with patch("httpx.AsyncClient", return_value=mock_client):
        result = await office_conversion._call_gotenberg("x.pptx", b"data")
    assert result == b"%PDF-1.4 real pdf bytes"


async def test_call_gotenberg_rejects_non_pdf_body_even_on_200(monkeypatch):
    """⭐QA catch(카디르군, 2026-08-19) 회귀 방지 — 200이어도 %PDF- 매직이 없으면(에러 페이지류
    오탐) ConversionFailed로 거부해 캐시 오염을 막는다."""
    monkeypatch.setattr(office_conversion, "_GOTENBERG_URL", "https://example.internal")
    monkeypatch.setattr(office_conversion, "_id_token_header", lambda: {})

    mock_client = _mock_gotenberg_response(200, b"<html>error page</html>")
    with patch("httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(office_conversion.ConversionFailed):
            await office_conversion._call_gotenberg("x.pptx", b"data")

    # 빈 body도 마찬가지로 거부.
    mock_client_empty = _mock_gotenberg_response(200, b"")
    with patch("httpx.AsyncClient", return_value=mock_client_empty):
        with pytest.raises(office_conversion.ConversionFailed):
            await office_conversion._call_gotenberg("x.pptx", b"data")


async def test_call_gotenberg_rejects_oversized_response(monkeypatch):
    """⭐QA catch(카디르군, 2026-08-19) 회귀 방지 — %PDF- 매직은 통과해도 상한(200MB) 초과 응답은
    거부한다(무제한 메모리 적재+캐시 방지). 실제로 200MB를 만들지 않고 cap을 낮춰 검증."""
    monkeypatch.setattr(office_conversion, "_GOTENBERG_URL", "https://example.internal")
    monkeypatch.setattr(office_conversion, "_id_token_header", lambda: {})
    monkeypatch.setattr(office_conversion, "_MAX_CONVERTED_PDF_BYTES", 10)

    mock_client = _mock_gotenberg_response(200, b"%PDF-1.4 " + b"x" * 20)  # 매직은 유효, 크기만 초과
    with patch("httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(office_conversion.ConversionFailed):
            await office_conversion._call_gotenberg("x.pptx", b"data")

    # cap 이내면 통과(경계값 아래 정상 케이스도 회귀로 고정).
    mock_client_ok = _mock_gotenberg_response(200, b"%PDF-")
    with patch("httpx.AsyncClient", return_value=mock_client_ok):
        result = await office_conversion._call_gotenberg("x.pptx", b"data")
    assert result == b"%PDF-"
