"""첨부 url 검증 단일 규칙(SSOT) — E-STORAGE-SSOT S1.

provider 추상 도입으로 업로드 응답 url 형태가 둘로 나뉜다:
- GCS provider: legacy public https URL(`https://storage.googleapis.com/{bucket}/{path}`).
- local/s3 provider: canonical bare object path(스킴 없음·`chat/...`/`story/...`).

따라서 message/story 첨부 저장 validator는 **둘 다** 허용해야 한다(default=local 이라 bare path를
거부하면 채팅/스토리 첨부 저장이 422로 깨짐 — 까심 cross-model 적출). 외부 스킴(http/gs/file 등)·
path traversal·절대경로는 거부. read 시 `authorize_attachment` 가 path scope를 재검증한다(IDOR).
canonicalization 규칙(`routers/attachments.py::_canonical_object_path`)과 정합.
"""
from __future__ import annotations


def validate_attachment_url(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("attachment url must not be empty")
    if v.startswith("https://"):
        return v  # legacy/GCS public URL
    if "://" in v:
        # 외부 스킴(http/gs/file/...) 거부 — canonicalization 이 우리 객체로 매핑 못 함.
        raise ValueError("attachment url must be an https:// URL or a bare object path")
    # canonical bare object path(local/s3). 절대경로·traversal 거부(defense-in-depth).
    if v.startswith("/") or ".." in v.split("/"):
        raise ValueError("invalid attachment object path")
    return v
