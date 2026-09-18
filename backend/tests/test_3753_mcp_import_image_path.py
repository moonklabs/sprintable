"""story #3753 AC1 — MCP `sprintable_import_image_artifact`의 `image_path`(로컬 파일
직접 읽기) 입구. client.post를 mock해 MCP 도구 함수만 단독 검증(BE 실호출 없음 —
BE 자체 동작은 test_b6b9c52d_mcp_import_image_artifact_realdb.py가 커버).

핵심 계약: image_path로 준 파일의 바이트가 base64 왕복 후 SHA256이 원본과 정확히
같아야 한다(모델 리타이핑 구간이 아예 없다는 것의 직접 증거) — image_base64 통로는
`Read` 툴 출력을 모델이 재입력하는 구간(story #3753 실사고)이 있지만, image_path는
서버가 `Path.read_bytes()`로 직접 읽어 그 구간 자체가 없다."""
from __future__ import annotations

import base64
import hashlib
import io
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.tools import visual_artifacts as va


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(**methods):
    c = MagicMock()
    c.project_id = "proj-1"
    c.require_project_id = MagicMock(return_value="proj-1")
    for name, ret in methods.items():
        setattr(c, name, AsyncMock(return_value=ret))
    return c


def _real_png_bytes() -> bytes:
    from PIL import Image

    img = Image.new("RGB", (5, 5), color=(11, 22, 33))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ── AC1: SHA256 round-trip ───────────────────────────────────────────────────

@pytest.mark.anyio
async def test_image_path_sha256_round_trips_to_original(tmp_path):
    original = _real_png_bytes()
    file_path = tmp_path / "shot.png"
    file_path.write_bytes(original)

    client = _client(post={"id": "artifact-1"})
    args = va.ImportImageArtifactInput(title="Shot", image_path=str(file_path))
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)

    assert "Error" not in out[0].text
    sent_body = client.post.call_args.kwargs.get("json") or client.post.call_args.args[1]
    sent_bytes = base64.b64decode(sent_body["image_base64"])
    assert hashlib.sha256(sent_bytes).hexdigest() == hashlib.sha256(original).hexdigest()
    assert sent_body["content_type"] == "image/png"


@pytest.mark.anyio
async def test_image_path_infers_content_type_from_extension(tmp_path):
    from PIL import Image

    img = Image.new("RGB", (5, 5), color=(1, 1, 1))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    file_path = tmp_path / "shot.jpg"
    file_path.write_bytes(buf.getvalue())

    client = _client(post={"id": "artifact-1"})
    args = va.ImportImageArtifactInput(title="Shot", image_path=str(file_path))
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)

    assert "Error" not in out[0].text
    sent_body = client.post.call_args.kwargs.get("json") or client.post.call_args.args[1]
    assert sent_body["content_type"] == "image/jpeg"


@pytest.mark.anyio
async def test_image_path_explicit_content_type_takes_precedence(tmp_path):
    original = _real_png_bytes()
    file_path = tmp_path / "shot.bin"  # 확장자로는 못 판별
    file_path.write_bytes(original)

    client = _client(post={"id": "artifact-1"})
    args = va.ImportImageArtifactInput(title="Shot", image_path=str(file_path), content_type="image/png")
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)

    assert "Error" not in out[0].text
    sent_body = client.post.call_args.kwargs.get("json") or client.post.call_args.args[1]
    assert sent_body["content_type"] == "image/png"


# ── 상호 배타 ─────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_both_image_base64_and_image_path_rejected(tmp_path):
    file_path = tmp_path / "shot.png"
    file_path.write_bytes(_real_png_bytes())

    client = _client()
    args = va.ImportImageArtifactInput(
        title="Shot", image_path=str(file_path), image_base64="aGVsbG8=", content_type="image/png",
    )
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)
    assert out[0].text.startswith("Error:")
    assert "정확히 하나" in out[0].text
    client.post.assert_not_called()


@pytest.mark.anyio
async def test_neither_image_base64_nor_image_path_rejected():
    client = _client()
    args = va.ImportImageArtifactInput(title="Shot", content_type="image/png")
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)
    assert out[0].text.startswith("Error:")
    assert "정확히 하나" in out[0].text
    client.post.assert_not_called()


# ── 파일 존재/종류 검증 ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_image_path_nonexistent_file_rejected(tmp_path):
    client = _client()
    args = va.ImportImageArtifactInput(title="Shot", image_path=str(tmp_path / "does-not-exist.png"))
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)
    assert out[0].text.startswith("Error:")
    assert "일반 파일" in out[0].text
    client.post.assert_not_called()


@pytest.mark.anyio
async def test_image_path_pointing_at_directory_rejected(tmp_path):
    client = _client()
    args = va.ImportImageArtifactInput(title="Shot", image_path=str(tmp_path))
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)
    assert out[0].text.startswith("Error:")
    client.post.assert_not_called()


@pytest.mark.anyio
async def test_image_path_oversized_file_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(va, "_MAX_IMPORT_IMAGE_BYTES", 10)  # 인위적으로 낮춰 대용량 생성 회피
    file_path = tmp_path / "shot.png"
    file_path.write_bytes(_real_png_bytes())  # 10B보다 큼

    client = _client()
    args = va.ImportImageArtifactInput(title="Shot", image_path=str(file_path))
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)
    assert out[0].text.startswith("Error:")
    assert "너무 큽니다" in out[0].text
    client.post.assert_not_called()


@pytest.mark.anyio
async def test_image_path_unrecognizable_content_type_rejected(tmp_path):
    file_path = tmp_path / "shot.unknownext"
    file_path.write_bytes(b"not-recognizable-as-any-image-format")

    client = _client()
    args = va.ImportImageArtifactInput(title="Shot", image_path=str(file_path))
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)
    assert out[0].text.startswith("Error:")
    assert "판별할 수 없습니다" in out[0].text
    client.post.assert_not_called()


# ── image_base64 경로: content_type 필수(기존 계약 유지, 스키마가 optional로 느슨해진 만큼
#    런타임에서 명시적으로 재확인) ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_image_base64_without_content_type_rejected():
    client = _client()
    args = va.ImportImageArtifactInput(title="Shot", image_base64="aGVsbG8=")
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)
    assert out[0].text.startswith("Error:")
    assert "필수" in out[0].text
    client.post.assert_not_called()


@pytest.mark.anyio
async def test_image_base64_path_unchanged_when_content_type_given():
    """회귀: image_base64 경로 자체(내용물 그대로 전달)는 #3753 변경으로 안 달라졌다."""
    client = _client(post={"id": "artifact-1"})
    args = va.ImportImageArtifactInput(title="Shot", image_base64="aGVsbG8=", content_type="image/png")
    with patch.object(va, "client", client):
        out = await va.import_image_artifact(args)
    assert "Error" not in out[0].text
    sent_body = client.post.call_args.kwargs.get("json") or client.post.call_args.args[1]
    assert sent_body["image_base64"] == "aGVsbG8="
    assert sent_body["content_type"] == "image/png"
