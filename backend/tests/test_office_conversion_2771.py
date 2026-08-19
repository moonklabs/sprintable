"""office_conversion 순수 로직 단위 테스트 (#2771 §7). DB/네트워크 불요."""
from __future__ import annotations

import uuid

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
