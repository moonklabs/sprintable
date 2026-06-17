"""R2 S1: attachment_context.build_attachment_context — 분류/추출/cap/스코프(IDOR) (GCS·추출 mock)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

PROJ = "proj1"
CONV = "conv1"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _att(name, content_type="", url=None):
    return {
        "name": name,
        "content_type": content_type,
        "url": url if url is not None else f"chat/{PROJ}/{CONV}/{name}",
        "size": 1,
    }


async def _build(ac, attachments):
    return await ac.build_attachment_context(
        attachments, project_id=PROJ, conversation_id=CONV
    )


@pytest.mark.anyio
async def test_empty_returns_blank():
    from app.services import attachment_context as ac

    assert await _build(ac, None) == ""
    assert await _build(ac, []) == ""


@pytest.mark.anyio
async def test_image_meta_line_no_fetch(monkeypatch):
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    out = await _build(ac, [_att("chart.png", "image/png")])
    assert "이미지 첨부: chart.png" in out
    fetch.assert_not_awaited()


@pytest.mark.anyio
async def test_unsupported_format_line(monkeypatch):
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    out = await _build(ac, [_att("data.bin", "application/octet-stream")])
    assert "미지원 형식): data.bin" in out
    fetch.assert_not_awaited()


@pytest.mark.anyio
async def test_doc_extraction_injected(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b"x"))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="hello world"))
    out = await _build(ac, [_att("report.pdf", "application/pdf")])
    assert "--- 첨부 내용 ---" in out
    assert "[첨부: report.pdf]" in out
    assert "hello world" in out


# ── 보안(QA RC HIGH·object-scope IDOR) ───────────────────────────────────────


@pytest.mark.anyio
async def test_other_conversation_url_rejected_no_fetch(monkeypatch):
    """타 대화 객체 URL 첨부 → 스코프 밖 → fetch 안 함·거부 라인(IDOR 차단)."""
    from app.services import attachment_context as ac

    fetch = AsyncMock(return_value=b"secret")
    monkeypatch.setattr(ac, "_download_object", fetch)
    # 같은 project 지만 *다른 conversation* 객체를 첨부에 심음
    out = await _build(
        ac, [_att("leak.pdf", "application/pdf", url=f"chat/{PROJ}/OTHERCONV/leak.pdf")]
    )
    assert "접근 범위 밖): leak.pdf" in out
    assert "secret" not in out
    fetch.assert_not_awaited()  # 스코프 밖은 다운로드 자체를 안 함


@pytest.mark.anyio
async def test_external_url_rejected(monkeypatch):
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    out = await _build(
        ac, [{"name": "x.txt", "content_type": "text/plain", "url": "https://evil.com/x.txt"}]
    )
    assert "접근 범위 밖): x.txt" in out
    fetch.assert_not_awaited()


@pytest.mark.anyio
async def test_story_path_rejected(monkeypatch):
    """story 첨부 경로(chat 아님)도 이 대화 스코프 밖 → 거부."""
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    out = await _build(
        ac, [_att("s.pdf", "application/pdf", url=f"story/{PROJ}/story123/s.pdf")]
    )
    assert "접근 범위 밖): s.pdf" in out
    fetch.assert_not_awaited()


# ── cap (QA RC LOW: 마커·헤더 포함 총량) ──────────────────────────────────────


@pytest.mark.anyio
async def test_per_attachment_cap_truncates(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b"x"))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="a" * 9000))
    out = await _build(ac, [_att("big.txt", "text/plain")])
    assert ac._TRUNC_MARK in out
    body = out.split("[첨부: big.txt]\n", 1)[1]
    assert len(body) <= ac._PER_ATTACHMENT_CAP  # 마커 포함 cap 이내


@pytest.mark.anyio
async def test_total_cap_includes_markers_and_stops(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b"x"))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="a" * 8000))
    atts = [_att(f"d{i}.txt", "text/plain") for i in range(5)]
    out = await _build(ac, atts)
    assert len(out) <= ac._TOTAL_CAP  # 헤더·마커·구분자 포함 총량 엄수
    assert "d4.txt" not in out  # 총량 한도로 후속 첨부 생략(누적 중단)


@pytest.mark.anyio
async def test_first_line_overflow_bounded(monkeypatch):
    """QA RC LOW: 첫 첨부(blocks 빈) 라인이 24k 초과해도 총량 ≤ cap (blocks 가드 제거 검증).
    긴 파일명 이미지 라인(미fetch)으로 첫 라인만으로 초과 유발."""
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock())
    huge_name = "x" * (ac._TOTAL_CAP + 5000) + ".png"
    out = await _build(ac, [_att(huge_name, "image/png")])
    assert len(out) <= ac._TOTAL_CAP  # 첫 라인도 한도 엄수


@pytest.mark.anyio
async def test_fetch_failure_guidance(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(side_effect=RuntimeError("gcs down")))
    out = await _build(ac, [_att("report.pdf", "application/pdf")])
    assert "추출 실패): report.pdf" in out


@pytest.mark.anyio
async def test_empty_text_guidance(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b""))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="   "))
    out = await _build(ac, [_att("empty.txt", "text/plain")])
    assert "추출 텍스트 없음" in out
