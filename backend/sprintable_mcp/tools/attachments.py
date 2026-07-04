"""E-MCP-OPT: inline base64 첨부 업로드 공용 프리미티브 — chat(S2)·story/doc(S6) 공유.

3번째 리소스 종류(story) 추가 시점에 chat 전용이던 검증/업로드 로직을 여기로 추출(S2 당시엔 chat
하나뿐이라 로컬이었음). 값/로직은 chat 과 100% 동일 — 업로드 대상 엔드포인트 경로만 호출부가 넘긴다.
"""
from __future__ import annotations

import base64
import binascii

from ..api_client import client

# 백엔드 `app/services/mcp_attachment_upload.py`의 동일 상수와 정합(client-side fail-fast 가드 —
# MCP 페이로드 낭비 전 조기 거부).
MAX_ATTACHMENTS = 5
MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024  # 2MiB decoded/file
MAX_TOTAL_ATTACHMENT_BYTES = 6 * 1024 * 1024  # 6MiB decoded/total
_MAX_ATTACHMENT_BASE64_CHARS = ((MAX_ATTACHMENT_BYTES + 2) // 3) * 4


def validate_attachment(att: dict, index: int) -> tuple[dict, int]:
    if not isinstance(att, dict):
        raise ValueError(f"attachments[{index}] must be an object")
    name = str(att.get("name") or "").strip()
    content_type = str(att.get("content_type") or "").strip()
    content_base64 = str(att.get("content_base64") or "").strip()
    if not name:
        raise ValueError(f"attachments[{index}].name is required")
    if not content_type:
        raise ValueError(f"attachments[{index}].content_type is required")
    if not content_base64:
        raise ValueError(f"attachments[{index}].content_base64 is required")
    if len(content_base64) > _MAX_ATTACHMENT_BASE64_CHARS:
        raise ValueError(
            f"attachments[{index}] too large (max {MAX_ATTACHMENT_BYTES} decoded bytes)"
        )
    try:
        decoded = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError(f"attachments[{index}].content_base64 must be valid base64")
    if not decoded:
        raise ValueError(f"attachments[{index}] must not be empty")
    if len(decoded) > MAX_ATTACHMENT_BYTES:
        raise ValueError(
            f"attachments[{index}] too large (max {MAX_ATTACHMENT_BYTES} decoded bytes)"
        )
    return {"content_base64": content_base64, "name": name, "content_type": content_type}, len(decoded)


async def upload_attachments(upload_path: str, attachments: list[dict] | None) -> list[dict]:
    """각 첨부를 `upload_path`(리소스별 신규 업로드 엔드포인트)에 순차 업로드.

    개수/사이즈 가드는 **전부 먼저 검증**(네트워크 호출 0)한 다음에야 업로드를 시작한다 — 순차
    검증+업로드를 인터리빙하면 총량 초과가 마지막 파일에서만 드러날 때 앞선 파일들이 이미 실제
    업로드돼 orphan blob 이 되고서야 실패하는 낭비/누출이 생긴다(S5 #2 교훈).
    """
    if not attachments:
        return []
    if len(attachments) > MAX_ATTACHMENTS:
        raise ValueError(f"too many attachments (max {MAX_ATTACHMENTS})")

    validated: list[tuple[dict, int]] = [validate_attachment(att, i) for i, att in enumerate(attachments)]
    total_size = sum(size for _payload, size in validated)
    if total_size > MAX_TOTAL_ATTACHMENT_BYTES:
        raise ValueError(
            f"attachments total too large (max {MAX_TOTAL_ATTACHMENT_BYTES} decoded bytes)"
        )

    uploaded: list[dict] = []
    for payload, _size in validated:
        uploaded.append(await client.post(upload_path, json=payload))
    return uploaded
