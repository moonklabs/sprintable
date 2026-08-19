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


def _mock_gotenberg_stream(status_code: int, chunks: list[bytes]):
    """client.stream()+aiter_bytes() 청크 스트림 mock(카디르군 재QA, 2026-08-19 — 버퍼링
    client.post() 대신 실제 스트리밍 경로를 그대로 연습). 소비된 청크 수를 센다 — 상한/매직
    위반 시 **나머지 청크를 안 읽고 조기 중단**하는지 테스트가 직접 확인할 수 있게."""
    consumed = {"n": 0}

    async def _aiter_bytes():
        for c in chunks:
            consumed["n"] += 1
            yield c

    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    mock_resp.aiter_bytes = _aiter_bytes

    mock_stream_cm = AsyncMock()
    mock_stream_cm.__aenter__.return_value = mock_resp

    mock_client = AsyncMock()
    mock_client.__aenter__.return_value.stream = MagicMock(return_value=mock_stream_cm)
    return mock_client, consumed


async def test_call_gotenberg_accepts_valid_pdf_magic(monkeypatch):
    """정상 케이스 — %PDF- 매직으로 시작하는 200 응답(여러 청크로 분할)은 그대로 통과."""
    monkeypatch.setattr(office_conversion, "_GOTENBERG_URL", "https://example.internal")
    monkeypatch.setattr(office_conversion, "_id_token_header", lambda: {})
    mock_client, consumed = _mock_gotenberg_stream(200, [b"%PDF-1.4 ", b"real ", b"pdf bytes"])
    with patch("httpx.AsyncClient", return_value=mock_client):
        result = await office_conversion._call_gotenberg("x.pptx", b"data")
    assert result == b"%PDF-1.4 real pdf bytes"
    assert consumed["n"] == 3  # 정상 케이스는 끝까지 읽는다


async def test_call_gotenberg_rejects_non_pdf_body_even_on_200(monkeypatch):
    """⭐QA catch(카디르군) 회귀 방지 — 200이어도 %PDF- 매직이 없으면(에러 페이지류 오탐)
    ConversionFailed로 거부해 캐시 오염을 막는다. 스트리밍 조기중단(2026-08-19 라운드 2) —
    매직이 판정 가능한 첫 청크에서 바로 거부, 나머지 청크는 안 읽는다."""
    monkeypatch.setattr(office_conversion, "_GOTENBERG_URL", "https://example.internal")
    monkeypatch.setattr(office_conversion, "_id_token_header", lambda: {})

    mock_client, consumed = _mock_gotenberg_stream(
        200, [b"<html>err", b"or page - should never be consumed"]
    )
    with patch("httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(office_conversion.ConversionFailed):
            await office_conversion._call_gotenberg("x.pptx", b"data")
    assert consumed["n"] == 1  # 조기 중단 — 2번째 청크는 안 읽음

    # 완전히 빈 스트림(청크 0개)도 마찬가지로 거부.
    mock_client_empty, _ = _mock_gotenberg_stream(200, [])
    with patch("httpx.AsyncClient", return_value=mock_client_empty):
        with pytest.raises(office_conversion.ConversionFailed):
            await office_conversion._call_gotenberg("x.pptx", b"data")


async def test_call_gotenberg_rejects_oversized_response(monkeypatch):
    """⭐QA catch(카디르군) 회귀 방지 — %PDF- 매직은 통과해도 상한 초과 응답은 거부한다.
    스트리밍 조기중단(2026-08-19 라운드 2) — 상한을 넘기는 청크에서 바로 거부, 그 뒤 청크는
    안 읽는다(무제한 메모리 적재를 실제로 막는지 소비 청크 수로 직접 검증)."""
    monkeypatch.setattr(office_conversion, "_GOTENBERG_URL", "https://example.internal")
    monkeypatch.setattr(office_conversion, "_id_token_header", lambda: {})
    monkeypatch.setattr(office_conversion, "_MAX_CONVERTED_PDF_BYTES", 10)

    mock_client, consumed = _mock_gotenberg_stream(
        200,
        [b"%PDF-", b"1234567890ABCDEF", b"SHOULD_NOT_BE_CONSUMED"],  # 누적 5→22(cap=10 초과)→미소비
    )
    with patch("httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(office_conversion.ConversionFailed):
            await office_conversion._call_gotenberg("x.pptx", b"data")
    assert consumed["n"] == 2  # 3번째 청크는 상한 초과 판정 前에 도달 안 함

    # cap 이내면 통과(경계값 아래 정상 케이스도 회귀로 고정).
    mock_client_ok, _ = _mock_gotenberg_stream(200, [b"%PDF-"])
    with patch("httpx.AsyncClient", return_value=mock_client_ok):
        result = await office_conversion._call_gotenberg("x.pptx", b"data")
    assert result == b"%PDF-"
