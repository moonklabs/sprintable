"""이미지 바이트 구조 무결성 검증(story #3753) — 저장 直前 공용 관문.

실사고(2026-09-09, artifact `b3f60ca8-4c65-44de-a7e9-bc5b5dcf5e01`): MCP
`sprintable_import_image_artifact`가 모델이 리타이핑한 base64를 그대로 받아 저장했다 —
PNG `IHDR` → 첫 `IDAT`(4096B)까지는 정상이었으나 그 다음 청크 타입 바이트가
`\\x7f\\x9f\\x00\\x00`로 깨져 있었다(청크 프레이밍 붕괴, `IEND` 미도달). BE 입구는
그 바이트를 그대로 저장했다 — 화면엔 "이미지 산출물"로 서지만 열면 전부 검정.

`visual_artifacts.py::import_image_artifact`·`channel_posts.py::post_channel_post_image_import`
(둘 다 base64-in 원콜 입구) 라우터가 `get_storage_provider().put_object(...)` 호출 前에
이 함수를 부른다 — 실패하면 저장 자체를 안 해(고아 객체 청소 불요, 애초에 안 생김).
"""
from __future__ import annotations

import io
import struct
import zlib

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_MAGIC_PREFIXES: dict[str, bytes] = {
    "image/jpeg": b"\xff\xd8\xff",
    "image/gif": b"GIF8",
}


class ImageIntegrityError(Exception):
    """이미지 바이트가 선언된 content_type의 유효한 구조가 아님 — 호출부가 422
    `IMAGE_CORRUPT`(+`reason`)로 매핑한다."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


def _walk_png_chunks(data: bytes) -> None:
    """PNG 청크 프레이밍 전수 walk(길이·타입 ASCII·CRC32·`IEND` 도달) — 실사고 재현:
    유효한 시그니처+`IHDR`+`IDAT`(4096B)까지 지나도, 그 다음 청크 타입이 4바이트
    알파벳이 아니면(예: `\\x7f\\x9f\\x00\\x00`) 여기서 잡는다. PIL의 `load()`도 결국
    같은 자리에서 실패하지만(zlib 스트림이 청크 경계를 못 찾음), 그 실패가 "포맷
    미지원"인지 "구조가 실제로 깨졌다"인지 구분이 안 된다 — 이 walk는 청크 단위로
    정확한 깨짐 지점(offset)을 짚어 사유를 남긴다."""
    pos = len(_PNG_SIGNATURE)
    seen_iend = False
    while pos < len(data):
        if pos + 8 > len(data):
            raise ImageIntegrityError(f"PNG chunk header truncated at offset {pos}")
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        chunk_type = data[pos + 4:pos + 8]
        if not chunk_type.isalpha():
            raise ImageIntegrityError(f"PNG chunk type invalid at offset {pos}: {chunk_type!r}")
        chunk_end = pos + 8 + length
        if chunk_end + 4 > len(data):
            raise ImageIntegrityError(
                f"PNG chunk data/CRC truncated at offset {pos} (type={chunk_type!r})"
            )
        chunk_data = data[pos + 8:chunk_end]
        declared_crc = struct.unpack(">I", data[chunk_end:chunk_end + 4])[0]
        actual_crc = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
        if declared_crc != actual_crc:
            raise ImageIntegrityError(f"PNG chunk CRC mismatch at offset {pos} (type={chunk_type!r})")
        pos = chunk_end + 4
        if chunk_type == b"IEND":
            seen_iend = True
            break
    if not seen_iend:
        raise ImageIntegrityError("PNG stream ended without reaching an IEND chunk")


def _validate_via_pil(data: bytes, *, expected_format: str | None) -> None:
    from PIL import Image, UnidentifiedImageError

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageIntegrityError(f"decode failed: {exc}") from exc
    actual_format = (img.format or "").upper()
    if expected_format is not None and actual_format != expected_format:
        raise ImageIntegrityError(
            f"declared content_type implies {expected_format} but decoded format is {actual_format!r}"
        )


def validate_image_bytes(content_type: str, data: bytes) -> None:
    """저장 直前 공용 관문(story #3753 AC2) — 매직 바이트가 선언된 content_type과
    일치하는지, PNG는 청크 구조 전수(CRC·IEND)까지, 그 외 포맷은 PIL 디코드+load()
    까지 확인한다. 실패하면 `ImageIntegrityError(reason)`."""
    ct = content_type.lower()
    if ct == "image/png":
        if not data.startswith(_PNG_SIGNATURE):
            raise ImageIntegrityError("missing PNG signature")
        _walk_png_chunks(data)
        _validate_via_pil(data, expected_format="PNG")
        return
    if ct == "image/jpeg":
        if not data.startswith(_MAGIC_PREFIXES["image/jpeg"]):
            raise ImageIntegrityError("missing JPEG magic bytes")
        _validate_via_pil(data, expected_format="JPEG")
        return
    if ct == "image/gif":
        if not data.startswith(_MAGIC_PREFIXES["image/gif"]):
            raise ImageIntegrityError("missing GIF magic bytes")
        _validate_via_pil(data, expected_format="GIF")
        return
    if ct == "image/webp":
        if not (data[:4] == b"RIFF" and data[8:12] == b"WEBP"):
            raise ImageIntegrityError("missing WEBP RIFF/WEBP magic bytes")
        _validate_via_pil(data, expected_format="WEBP")
        return
    # 그 외 image/* — 매직 목록 밖 포맷은 PIL 디코드 수준으로만(content_type↔format 대조 없음).
    _validate_via_pil(data, expected_format=None)
