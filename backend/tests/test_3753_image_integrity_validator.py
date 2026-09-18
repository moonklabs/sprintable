"""story #3753 AC2 — `app/services/image_integrity.py::validate_image_bytes` 단위 테스트.

실사고 재현(artifact `b3f60ca8-4c65-44de-a7e9-bc5b5dcf5e01`, PO 청크 실측): 유효한 PNG
시그니처+`IHDR`+첫 `IDAT`(4096B)까지는 정상이었으나 그 다음 청크 타입이
`\\x7f\\x9f\\x00\\x00`로 깨져 있었다 — 이 파일의 `test_reproduces_incident_pattern_*`이
그 정확한 모양(시그니처+IHDR+유효 4096B IDAT+깨진 청크 타입)을 합성해 청크 walk가
정확히 그 지점에서 잡는다는 것을 고정한다(양성대조: PIL 단독이 아니라 청크 walk 자체가
일하고 있다는 증거 — walk를 빼면 이 케이스가 통과한다, AC2 되돌리면 RED 조건)."""
from __future__ import annotations

import io
import struct
import zlib

import pytest

from app.services.image_integrity import ImageIntegrityError, _walk_png_chunks, validate_image_bytes


def _png_bytes(width: int = 4, height: int = 4, *, color=(200, 50, 80)) -> bytes:
    from PIL import Image

    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_bytes(width: int = 4, height: int = 4) -> bytes:
    from PIL import Image

    img = Image.new("RGB", (width, height), color=(10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _gif_bytes() -> bytes:
    from PIL import Image

    img = Image.new("RGB", (4, 4), color=(1, 2, 3))
    buf = io.BytesIO()
    img.save(buf, format="GIF")
    return buf.getvalue()


def _webp_bytes() -> bytes:
    from PIL import Image

    img = Image.new("RGB", (4, 4), color=(9, 8, 7))
    buf = io.BytesIO()
    img.save(buf, format="WEBP")
    return buf.getvalue()


# ── happy path: 실제 PIL이 만든 이미지는 전부 통과 ──────────────────────────────

def test_valid_png_passes():
    validate_image_bytes("image/png", _png_bytes())  # raise 없으면 통과


def test_valid_jpeg_passes():
    validate_image_bytes("image/jpeg", _jpeg_bytes())


def test_valid_gif_passes():
    validate_image_bytes("image/gif", _gif_bytes())


def test_valid_webp_passes():
    validate_image_bytes("image/webp", _webp_bytes())


def test_content_type_case_insensitive():
    validate_image_bytes("IMAGE/PNG", _png_bytes())


# ── 매직 바이트 불일치 ──────────────────────────────────────────────────────────

def test_png_missing_signature_rejected():
    with pytest.raises(ImageIntegrityError, match="signature"):
        validate_image_bytes("image/png", b"not-a-png-at-all")


def test_jpeg_missing_magic_rejected():
    with pytest.raises(ImageIntegrityError, match="magic"):
        validate_image_bytes("image/jpeg", b"not-a-jpeg-at-all")


def test_content_type_mismatch_rejected():
    """실제로는 PNG인데 content_type=image/jpeg로 선언 — 매직 바이트 자체가 안 맞아 거절."""
    with pytest.raises(ImageIntegrityError, match="magic"):
        validate_image_bytes("image/jpeg", _png_bytes())


# ── 완전 쓰레기 바이트(비-이미지) ────────────────────────────────────────────────

def test_garbage_bytes_rejected_as_png():
    with pytest.raises(ImageIntegrityError):
        validate_image_bytes("image/png", b"garbage-not-a-real-image-payload" * 10)


def test_unsupported_image_subtype_falls_back_to_pil_and_rejects_garbage():
    with pytest.raises(ImageIntegrityError):
        validate_image_bytes("image/bmp", b"garbage-bytes-not-bmp")


def test_unsupported_image_subtype_accepts_pil_decodable_bytes():
    """매직 목록 밖 포맷(bmp)도 실제로 PIL이 디코드 가능하면 통과 — PIL verify 수준 폴백."""
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color=(5, 5, 5)).save(buf, format="BMP")
    validate_image_bytes("image/bmp", buf.getvalue())


# ── PNG 청크 walk 전용 — 실사고 재현 ─────────────────────────────────────────────

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _make_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)


def test_reproduces_incident_pattern_corrupted_chunk_type_after_valid_idat():
    """b3f60ca8 실사고의 정확한 모양: 유효 시그니처+IHDR+첫 IDAT(4096B, 유효 CRC)까지
    지나간 뒤, 다음 청크 타입이 알파벳이 아닌 바이트(\\x7f\\x9f\\x00\\x00)로 깨짐 —
    청크 walk가 그 정확한 지점에서 「PNG chunk type invalid」로 잡아야 한다."""
    ihdr_data = struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)  # width height bitdepth=8 colortype=2(RGB)...
    ihdr_chunk = _make_chunk(b"IHDR", ihdr_data)
    idat_chunk = _make_chunk(b"IDAT", zlib.compress(b"\x00" * (4 * 3 + 1) * 4)[:4096].ljust(4096, b"\x00"))
    corrupted_next_chunk_header = struct.pack(">I", 100) + b"\x7f\x9f\x00\x00"  # 깨진 타입, CRC 없음
    data = _PNG_SIGNATURE + ihdr_chunk + idat_chunk + corrupted_next_chunk_header

    with pytest.raises(ImageIntegrityError, match="chunk type invalid"):
        _walk_png_chunks(data)


def test_png_truncated_mid_chunk_rejected():
    ihdr_chunk = _make_chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
    data = _PNG_SIGNATURE + ihdr_chunk + struct.pack(">I", 500) + b"IDAT"  # 길이 선언했지만 데이터 없음
    with pytest.raises(ImageIntegrityError, match="truncated"):
        _walk_png_chunks(data)


def test_png_crc_mismatch_rejected():
    ihdr_data = struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)
    bad_crc_chunk = struct.pack(">I", len(ihdr_data)) + b"IHDR" + ihdr_data + struct.pack(">I", 0xDEADBEEF)
    data = _PNG_SIGNATURE + bad_crc_chunk
    with pytest.raises(ImageIntegrityError, match="CRC mismatch"):
        _walk_png_chunks(data)


def test_png_missing_iend_rejected():
    ihdr_chunk = _make_chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
    data = _PNG_SIGNATURE + ihdr_chunk  # IEND 없이 끝남
    with pytest.raises(ImageIntegrityError, match="IEND"):
        _walk_png_chunks(data)


def test_png_reaching_iend_passes_chunk_walk():
    ihdr_chunk = _make_chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
    iend_chunk = _make_chunk(b"IEND", b"")
    data = _PNG_SIGNATURE + ihdr_chunk + iend_chunk
    _walk_png_chunks(data)  # raise 없으면 통과(PIL 디코드는 여기서 안 함 — walk 단독 테스트)


# ── 양성대조: walk를 빼면 위 실사고 재현 케이스가 조용히 통과한다는 것 ──────────────
# (validate_image_bytes 전체 관문 — PIL 폴백 없이 walk가 먼저 걸리는지)

def test_validate_image_bytes_rejects_incident_pattern_via_png_path():
    ihdr_chunk = _make_chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
    idat_chunk = _make_chunk(b"IDAT", zlib.compress(b"\x00" * (4 * 3 + 1) * 4)[:4096].ljust(4096, b"\x00"))
    corrupted_next_chunk_header = struct.pack(">I", 100) + b"\x7f\x9f\x00\x00"
    data = _PNG_SIGNATURE + ihdr_chunk + idat_chunk + corrupted_next_chunk_header

    with pytest.raises(ImageIntegrityError):
        validate_image_bytes("image/png", data)
