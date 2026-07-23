"""story #2055: 첨부 이미지 업로드 시점 서버측 가로·세로 측정.

AC1 판단(디디 은와추쿠): 클라이언트 제공 값은 위조 가능(#2055 AC1 명시 우려)하므로 서버가 직접
측정한다. `imagesize`로 이미지 바이트 헤더만 파싱(파일 전체를 디코드하지 않음 — Pillow 등
풀 디코더 대비 가벼움). 스토리지는 provider 추상(`get_storage_provider`, E-STORAGE-SSOT)을
그대로 재사용 — object path canonicalization은 `attachment_context.py`/`attachments.py`의
기존 규칙과 동일(신규=bare path·legacy=GCS public prefix·외부 도메인=None).

best-effort — 측정 실패(손상 파일·미지원 포맷·스토리지 미도달 등)는 예외 전파 없이 None을
반환한다(#2055 AC4와 동형 정신: 못 재면 자리를 못 예약할 뿐, 메시지/스토리 저장 자체를 막지
않는다 — FE는 기존 고정 프레임 폴백으로 떨어진다).
"""
from __future__ import annotations

import logging
import os

from app.services.storage import get_storage_provider

logger = logging.getLogger(__name__)

_BUCKET = os.environ.get("GCS_MEMO_ATTACHMENTS_BUCKET", "sprintable-memo-attachments")
_PUBLIC_PREFIX = f"https://storage.googleapis.com/{_BUCKET}/"

# attachment_context.py/attachments.py와 동일 지원 포맷 집합(#2055 AC4: 비이미지는 대상 아님).
_IMAGE_CONTENT_TYPE_PREFIX = "image/"

# 오르테가 PO 리뷰(2026-07-20) 실측 발견: `imagesize`는 청크 타입/CRC를 검증하지 않고 시그니처
# 직후 4바이트를 그대로 width/height로 읽는다 — 손상/잘린 바이트가 우연히 큰 양수로 해석되면
# (예: b"...truncated-not-a-real-header" → (1953658222, 1667331173)) `width <= 0` 가드를
# 통과해버린다. 실 이미지가 이 상한을 넘을 일은 없으므로(일반적 업로드 한도 100MB 안에서 이
# 해상도는 비현실적) 안전판으로 상한을 둔다 — 넘으면 파싱 실패와 동일하게 취급(None).
_MAX_PLAUSIBLE_DIMENSION = 20_000


def _canonical_object_path(stored_url: str) -> str | None:
    """stored attachment url → canonical object path. attachments.py/attachment_context.py와
    동일 규칙(신규=bare path·legacy=GCS public prefix·외부 도메인=None)."""
    if not stored_url:
        return None
    if stored_url.startswith(_PUBLIC_PREFIX):
        return stored_url[len(_PUBLIC_PREFIX):]
    if "://" in stored_url:
        return None
    return stored_url


def measure_image_dimensions_from_bytes(content_type: str, data: bytes) -> tuple[int, int] | None:
    """이미 메모리에 있는 바이트로 (width, height) 측정 — MCP JSON/base64 업로드 경로처럼 재다운로드가
    불필요한 호출부용(stories.py::upload_story_attachment). 이미지가 아니거나 측정 실패 시 None."""
    if not content_type.lower().startswith(_IMAGE_CONTENT_TYPE_PREFIX):
        return None
    try:
        import io

        import imagesize

        width, height = imagesize.get(io.BytesIO(data))
        if width <= 0 or height <= 0 or width > _MAX_PLAUSIBLE_DIMENSION or height > _MAX_PLAUSIBLE_DIMENSION:
            return None
        return int(width), int(height)
    except Exception:  # noqa: BLE001 — best-effort(손상 파일·미지원 포맷 등).
        logger.warning("measure_image_dimensions_from_bytes failed", exc_info=True)
        return None


async def measure_image_dimensions(content_type: str, stored_url: str) -> tuple[int, int] | None:
    """이미지 첨부의 (width, height) 측정. 이미지가 아니거나 측정 실패 시 None(best-effort).

    #2055 AC1: 서버측 측정(client 위조 방지) — 업로드 완료된 객체를 provider 추상으로 직접
    읽어(`download_object`) `imagesize`로 헤더만 파싱한다.
    """
    if not content_type.lower().startswith(_IMAGE_CONTENT_TYPE_PREFIX):
        return None

    object_path = _canonical_object_path(stored_url)
    if object_path is None:
        return None

    try:
        data = await get_storage_provider().download_object(_BUCKET, object_path)
    except Exception:  # noqa: BLE001 — best-effort(스토리지 미도달 등).
        logger.warning("measure_image_dimensions download failed object_path=%s", object_path, exc_info=True)
        return None
    return measure_image_dimensions_from_bytes(content_type, data)
