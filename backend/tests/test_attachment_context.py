"""R2 S1: attachment_context.build_attachment_context — 분류/추출/cap/안내 (GCS·추출 mock)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _att(name, content_type="", url=None):
    return {"name": name, "content_type": content_type, "url": url or f"chat/p/c/{name}", "size": 1}


@pytest.mark.anyio
async def test_empty_returns_blank():
    from app.services import attachment_context as ac

    assert await ac.build_attachment_context(None) == ""
    assert await ac.build_attachment_context([]) == ""


@pytest.mark.anyio
async def test_image_meta_line_no_fetch(monkeypatch):
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    out = await ac.build_attachment_context([_att("chart.png", "image/png")])
    assert "이미지 첨부: chart.png" in out
    fetch.assert_not_awaited()  # 이미지는 v1 fetch 안 함


@pytest.mark.anyio
async def test_unsupported_format_line(monkeypatch):
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    out = await ac.build_attachment_context([_att("data.bin", "application/octet-stream")])
    assert "미지원 형식): data.bin" in out
    fetch.assert_not_awaited()


@pytest.mark.anyio
async def test_doc_extraction_injected(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b"x"))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="hello world"))
    out = await ac.build_attachment_context([_att("report.pdf", "application/pdf")])
    assert "--- 첨부 내용 ---" in out
    assert "[첨부: report.pdf]" in out
    assert "hello world" in out


@pytest.mark.anyio
async def test_per_attachment_cap_truncates(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b"x"))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="a" * 9000))
    out = await ac.build_attachment_context([_att("big.txt", "text/plain")])
    assert ac._TRUNC_MARK in out
    # 본문은 per-attachment cap(8000) 이하 + 표시
    body = out.split("[첨부: big.txt]\n", 1)[1]
    assert len(body) <= ac._PER_ATTACHMENT_CAP + len(ac._TRUNC_MARK)


@pytest.mark.anyio
async def test_total_cap_stops(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b"x"))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="a" * 8000))
    atts = [_att(f"d{i}.txt", "text/plain") for i in range(4)]
    out = await ac.build_attachment_context(atts)
    assert "총량 한도 도달" in out
    assert "d3.txt" not in out  # 총량 도달로 4번째 생략


@pytest.mark.anyio
async def test_fetch_failure_guidance(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(side_effect=RuntimeError("gcs down")))
    out = await ac.build_attachment_context([_att("report.pdf", "application/pdf")])
    assert "추출 실패): report.pdf" in out


@pytest.mark.anyio
async def test_empty_text_guidance(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b""))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="   "))
    out = await ac.build_attachment_context([_att("empty.txt", "text/plain")])
    assert "추출 텍스트 없음" in out


@pytest.mark.anyio
async def test_external_url_unreadable(monkeypatch):
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    out = await ac.build_attachment_context(
        [{"name": "x.txt", "content_type": "text/plain", "url": "https://evil.com/x.txt"}]
    )
    assert "읽기 불가 경로): x.txt" in out
    fetch.assert_not_awaited()
