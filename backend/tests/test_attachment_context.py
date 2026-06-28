"""attachment_context.build_attachment_context — 분류/추출/cap/스코프(IDOR) + 이미지 서명 URL(f3ccb40c).

반환 = (text, images). 문서=GCS fetch+추출, 이미지=단기 V4 서명 URL(백엔드 vision 안 함·scope IDOR 게이트).
"""
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
    """(text, images) 튜플 반환."""
    return await ac.build_attachment_context(
        attachments, project_id=PROJ, conversation_id=CONV
    )


async def _text(ac, attachments):
    text, _images = await _build(ac, attachments)
    return text


@pytest.mark.anyio
async def test_empty_returns_blank():
    from app.services import attachment_context as ac

    assert await _build(ac, None) == ("", [])
    assert await _build(ac, []) == ("", [])


# ── 이미지(f3ccb40c): scope 통과 → 서명 URL 마크다운 + 구조화 images ──────────────
@pytest.mark.anyio
async def test_image_emits_signed_url_markdown_and_struct(monkeypatch):
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    monkeypatch.setattr(ac, "_signed_read_url", AsyncMock(return_value="https://signed/url?sig=abc"))

    text, images = await _build(ac, [_att("chart.png", "image/png")])

    # content: 마크다운 이미지 링크(멀티모달 에이전트 fetch+view)
    assert "![chart.png](https://signed/url?sig=abc)" in text
    assert "이미지 분석은 준비 중" not in text  # 옛 placeholder 제거
    # 구조화 images 필드
    assert images == [{"url": "https://signed/url?sig=abc", "name": "chart.png", "mime": "image/png"}]
    fetch.assert_not_awaited()  # 이미지는 백엔드 다운로드/vision 안 함


@pytest.mark.anyio
async def test_image_out_of_scope_rejected_no_sign(monkeypatch):
    """타 대화 이미지 객체 → scope 밖 → 서명 안 함·거부 라인·images 비움(IDOR 차단)."""
    from app.services import attachment_context as ac

    sign = AsyncMock(return_value="https://should/not/be/called")
    monkeypatch.setattr(ac, "_signed_read_url", sign)

    text, images = await _build(
        ac, [_att("leak.png", "image/png", url=f"chat/{PROJ}/OTHERCONV/leak.png")]
    )
    assert "접근 범위 밖): leak.png" in text
    assert images == []
    sign.assert_not_awaited()  # scope 밖은 서명 자체를 안 함


@pytest.mark.anyio
async def test_image_sign_failure_guidance(monkeypatch):
    """서명 URL 생성 실패(None) → 안내 라인·images 비움(전달 무중단)."""
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_signed_read_url", AsyncMock(return_value=None))
    text, images = await _build(ac, [_att("x.png", "image/png")])
    assert "URL 생성 실패" in text
    assert images == []


@pytest.mark.anyio
async def test_unsupported_format_line(monkeypatch):
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    out = await _text(ac, [_att("data.bin", "application/octet-stream")])
    assert "미지원 형식): data.bin" in out
    fetch.assert_not_awaited()


@pytest.mark.anyio
async def test_doc_extraction_injected(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b"x"))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="hello world"))
    out = await _text(ac, [_att("report.pdf", "application/pdf")])
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
    out = await _text(
        ac, [_att("leak.pdf", "application/pdf", url=f"chat/{PROJ}/OTHERCONV/leak.pdf")]
    )
    assert "접근 범위 밖): leak.pdf" in out
    assert "secret" not in out
    fetch.assert_not_awaited()


@pytest.mark.anyio
async def test_external_url_rejected(monkeypatch):
    from app.services import attachment_context as ac

    fetch = AsyncMock()
    monkeypatch.setattr(ac, "_download_object", fetch)
    out = await _text(
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
    out = await _text(
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
    out = await _text(ac, [_att("big.txt", "text/plain")])
    assert ac._TRUNC_MARK in out
    body = out.split("[첨부: big.txt]\n", 1)[1]
    assert len(body) <= ac._PER_ATTACHMENT_CAP  # 마커 포함 cap 이내


@pytest.mark.anyio
async def test_total_cap_includes_markers_and_stops(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b"x"))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="a" * 8000))
    atts = [_att(f"d{i}.txt", "text/plain") for i in range(5)]
    out = await _text(ac, atts)
    assert len(out) <= ac._TOTAL_CAP  # 헤더·마커·구분자 포함 총량 엄수
    assert "d4.txt" not in out  # 총량 한도로 후속 첨부 생략(누적 중단)


@pytest.mark.anyio
async def test_first_line_overflow_bounded(monkeypatch):
    """QA RC LOW: 첫 첨부(blocks 빈) 라인이 24k 초과해도 총량 ≤ cap (blocks 가드 제거 검증).
    긴 파일명 이미지 마크다운 라인으로 첫 라인만으로 초과 유발."""
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_signed_read_url", AsyncMock(return_value="https://s/u"))
    huge_name = "x" * (ac._TOTAL_CAP + 5000) + ".png"
    out = await _text(ac, [_att(huge_name, "image/png")])
    assert len(out) <= ac._TOTAL_CAP  # 첫 라인도 한도 엄수


@pytest.mark.anyio
async def test_fetch_failure_guidance(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(side_effect=RuntimeError("gcs down")))
    out = await _text(ac, [_att("report.pdf", "application/pdf")])
    assert "추출 실패): report.pdf" in out


@pytest.mark.anyio
async def test_empty_text_guidance(monkeypatch):
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b""))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="   "))
    out = await _text(ac, [_att("empty.txt", "text/plain")])
    assert "추출 텍스트 없음" in out


# ── S7 신 namespace(org/<org>/project/<proj>/chat/<conv>/...) 인식 + IDOR 유지 ──


@pytest.mark.anyio
async def test_s7_namespace_doc_extraction_injected(monkeypatch):
    """S7 AC1/AC3 회귀: 신 namespace chat 첨부도 스코프 통과 → fetch+추출 주입(probe '접근 범위 밖' 근원 해소)."""
    from app.services import attachment_context as ac

    monkeypatch.setattr(ac, "_download_object", AsyncMock(return_value=b"x"))
    monkeypatch.setattr(ac, "_extract_text", MagicMock(return_value="hello s7"))
    url = f"org/orgX/project/{PROJ}/chat/{CONV}/report.pdf"
    out = await _text(ac, [_att("report.pdf", "application/pdf", url=url)])
    assert "[첨부: report.pdf]" in out and "hello s7" in out
    assert "접근 범위 밖" not in out


@pytest.mark.anyio
async def test_s7_namespace_cross_conv_rejected(monkeypatch):
    """신 namespace라도 타 conv segment → 스코프 밖 거부(IDOR·exact segment)."""
    from app.services import attachment_context as ac

    fetch = AsyncMock(return_value=b"secret")
    monkeypatch.setattr(ac, "_download_object", fetch)
    url = f"org/orgX/project/{PROJ}/chat/OTHERCONV/leak.pdf"
    out = await _text(ac, [_att("leak.pdf", "application/pdf", url=url)])
    assert "접근 범위 밖): leak.pdf" in out and "secret" not in out
    fetch.assert_not_awaited()


@pytest.mark.anyio
async def test_s7_namespace_cross_project_and_middle_inject_rejected(monkeypatch):
    """타 project segment·중간 /chat/ 삽입 → 거부(까심 IDOR·정확 segment 바인딩)."""
    from app.services import attachment_context as ac

    fetch = AsyncMock(return_value=b"secret")
    monkeypatch.setattr(ac, "_download_object", fetch)
    for url in (
        f"org/orgX/project/OTHERPROJ/chat/{CONV}/leak.pdf",          # 타 project
        f"org/orgX/project/{PROJ}/evil/chat/{CONV}/leak.pdf",        # 중간 삽입(parts[4]!='chat')
    ):
        out = await _text(ac, [_att("leak.pdf", "application/pdf", url=url)])
        assert "접근 범위 밖): leak.pdf" in out, url
    fetch.assert_not_awaited()
