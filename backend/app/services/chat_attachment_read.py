"""story 4646 — 채팅 첨부를 에이전트가 읽을 수 있는 형태로 줄이는 순수 함수(모델로 가기 전 단계).

서버가 원본을 읽고(storage.download_object) 여기서 줄인 뒤, MCP 도구가 image content로 돌려준다.
- 원본 상한은 올리기 상수와 같은 값을 쓴다(mcp_attachment_upload.MAX_JSON_ATTACHMENT_UPLOAD_SIZE).
- 이미지: EXIF 방향을 먼저 세우고(폰 사진이 옆으로 눕지 않게) 긴 변 ≤ 1568px · ≤ 1.5MB로 줄인다.
  저장할 때 EXIF는 버린다(GPS 위치가 모델로 가지 않게). 압축 폭탄 가드(MAX_IMAGE_PIXELS).
- 텍스트: 확장자 허용 + 200KB 이하일 때만 본문. 그 밖은 메타만.
열기 · 디코드가 실패하면 None — 호출부는 메타만 돌려준다(도구가 죽지 않게).
"""
from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image, ImageOps

from app.services.mcp_attachment_upload import MAX_JSON_ATTACHMENT_UPLOAD_SIZE

MAX_EDGE_PX = 1568
MAX_OUT_BYTES = int(1.5 * 1024 * 1024)
MAX_TEXT_BYTES = 200 * 1024
# 압축 폭탄 가드 — 약 8천만 화소를 넘으면 열지 않는다(폰 48MP 사진은 통과).
Image.MAX_IMAGE_PIXELS = 80_000_000

IMAGE_EXTS = frozenset({"jpg", "jpeg", "png", "gif", "webp"})
TEXT_EXTS = frozenset({"txt", "md", "csv", "json", "log"})


@dataclass(frozen=True)
class PreparedImage:
    data: bytes
    mime_type: str
    width: int
    height: int
    original_bytes: int


def prepare_image(raw: bytes) -> PreparedImage | None:
    """원본 이미지 바이트 → 모델용 축소본. 못 열면 None."""
    if len(raw) > MAX_JSON_ATTACHMENT_UPLOAD_SIZE * 8:  # 아주 큰 원본은 열기 전에 거른다(상한 × 8)
        return None
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.load()
            im = ImageOps.exif_transpose(im)  # 방향을 픽셀에 반영한 뒤 EXIF는 버린다
            im = im.convert("RGB") if im.mode not in ("RGB", "L") else im
            im.thumbnail((MAX_EDGE_PX, MAX_EDGE_PX))
            width, height = im.size
            for quality in (85, 75, 65, 50):
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=quality, optimize=True)  # save는 info(EXIF 포함)를 넘기지 않음
                if buf.tell() <= MAX_OUT_BYTES:
                    return PreparedImage(buf.getvalue(), "image/jpeg", width, height, len(raw))
            return None  # 줄여도 1.5MB를 못 넘기는 그림은 메타만
    except (Image.DecompressionBombError, OSError, ValueError):
        return None


def text_body(raw: bytes, ext: str) -> str | None:
    """텍스트 파일이고 200KB 이하일 때만 본문(UTF-8). 아니면 None."""
    if ext.lower() not in TEXT_EXTS or len(raw) > MAX_TEXT_BYTES:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
