"""E-MCP-OPT: MCP(비-브라우저) JSON/base64 첨부 업로드 공용 프리미티브 — S2(chat)·S6(story/doc) 공유.

3번째 리소스 종류(story) 추가 시점에 chat 전용이던 상수/헬퍼를 여기로 추출(S2/S5 당시엔 chat 하나뿐이라
로컬이었음). 값/로직은 chat 과 100% 동일(정합 유지) — object_path 의 5번째 세그먼트(kind)만 리소스별로
다르다(chat|story|doc).
"""
from __future__ import annotations

import base64
import binascii
import re
import uuid

from fastapi import HTTPException

from app.services.asset_registry import DEFAULT_CONTAINER, canonical_object_path

# 스샷/작은 문서가 실사용(대용량 아님). FE-proxy 100MB 캡과 별개로 더 작게(Cloud Run HTTP/1 32MiB 요청
# 캡 대비 여유 마진). sprintable_mcp 의 동일 상수(tools/*.py)와 정합.
MAX_JSON_ATTACHMENT_UPLOAD_SIZE = 2 * 1024 * 1024  # 2MiB decoded (per-file)
MAX_ATTACHMENT_NAME_LEN = 255
# 선언 한도(5개/6MiB 합계) — sprintable_mcp client-side 가드와 동일 값. 업로드 엔드포인트가 개별
# 호출만 파일당 캡을 걸면 다회 호출로 이 선언 한도를 우회할 수 있어(S5 #2), 종결 액션(chat=send_message·
# story=create/update) 에서 mcp-태그 부분집합에 한해 재검증한다. doc 은 업로드=즉시 등록이 종결 액션
# 자체라 별도 재검증 불요(모듈별 라우터에서 각자 판단).
MCP_MAX_ATTACHMENTS = 5
MCP_MAX_TOTAL_ATTACHMENT_BYTES = 6 * 1024 * 1024  # 6MiB decoded (total)

_SAFE_ATTACHMENT_NAME_RE = re.compile(r"[^\w.\-]+")


def safe_attachment_filename(name: str) -> str:
    safe = _SAFE_ATTACHMENT_NAME_RE.sub("_", name.strip())[-128:]
    return safe or "file"


def decode_json_attachment(content_base64: str, *, max_size: int = MAX_JSON_ATTACHMENT_UPLOAD_SIZE) -> bytes:
    """base64 디코드 + 사이즈 가드. 실패 시 HTTPException(400/413) — 라우터가 그대로 propagate."""
    try:
        data = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="content_base64 must be valid base64")
    if not data:
        raise HTTPException(status_code=400, detail="attachment must not be empty")
    if len(data) > max_size:
        raise HTTPException(status_code=413, detail=f"attachment too large (max {max_size} bytes)")
    return data


def build_mcp_object_path(
    *, org_id: uuid.UUID, project_id: uuid.UUID, kind: str, resource_id: uuid.UUID, safe_name: str,
) -> str:
    """S7 namespace + `mcp/` 마커. FE 업로드 라우트(각 리소스의 apps/web .../attachments/route.ts)와
    동일 접두(org/<org>/project/<project>/<kind>/<resource_id>/...) — path_in_source_scope 는 그
    접두까지만 segment-match 하므로(그 뒤 세그먼트 수는 안 봄) `mcp/` 추가가 IDOR 가드에 영향 없다.
    """
    return f"org/{org_id}/project/{project_id}/{kind}/{resource_id}/mcp/{uuid.uuid4()}-{safe_name}"


def is_mcp_upload_object_path(url: str, *, kind: str, container: str = DEFAULT_CONTAINER) -> bool:
    """이 url 이 MCP JSON 업로드 엔드포인트로 실제 생성된 객체 경로인지(리소스 종류=kind 한정).

    그 엔드포인트만 `org/<org>/project/<project>/<kind>/<resource_id>/mcp/<file>` 형태(6번째
    segment=``mcp``)로 서버가 직접 object_path 를 구성한다 — client 는 ``name``(파일명 suffix) 외에는
    경로에 관여할 수 없어 이 segment 를 조작해 자신에게 더 엄격한 검사를 켜는 것 외엔 스푸핑 이득이
    없다(false-positive 는 harmless·false-negative 는 발생하지 않음 — 이 엔드포인트가 쓰는 유일한 shape).
    """
    canon = canonical_object_path(url, container)
    if not canon:
        return False
    parts = canon.split("/")
    return (
        len(parts) >= 7
        and parts[0] == "org" and parts[2] == "project" and parts[4] == kind and parts[6] == "mcp"
    )
