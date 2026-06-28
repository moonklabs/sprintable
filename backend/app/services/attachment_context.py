"""채팅 첨부 → 에이전트 컨텍스트 텍스트 추출 (R2 S1, story 9d130c01 / af66acee).

문서(pdf/docx/txt/csv/md) 텍스트를 추출해 에이전트-facing content 에 주입할 텍스트 블록으로
변환한다. 이미지·미지원 형식은 안내 라인. 블루프린트 §3 결정 = **백엔드 텍스트 추출·균일 주입**
(이질 런타임에 런타임 무변경으로 균일 적용). 이미지 Vision 캡션은 S2.

§7 결정 반영: 추출 v1=pdf/docx/txt/csv/md · cap 첨부당 8k자/총 24k자·truncate 표시 ·
GCS 서비스계정 직접 read · 보안=기존 authorize 전달 경로(webhook/SSE→참가자) 상속(추가검증 불요).

⚠️ 배포 전제(infra/PO lane): 백엔드 서비스계정에 버킷 read 권한 + google-cloud-storage·pypdf·
python-docx 의존 설치(pyproject). GCS fetch 실패/미지원은 best-effort(전달 무영향·안내 라인).
"""
from __future__ import annotations

import io
import logging
import os
from datetime import timedelta

from app.services.asset_registry import path_in_source_scope
from app.services.storage import get_storage_provider

logger = logging.getLogger(__name__)

_BUCKET = os.environ.get("GCS_MEMO_ATTACHMENTS_BUCKET", "sprintable-memo-attachments")
_PUBLIC_PREFIX = f"https://storage.googleapis.com/{_BUCKET}/"

_PER_ATTACHMENT_CAP = 8000   # §7-3 첨부당 자수 cap
_TOTAL_CAP = 24000           # §7-3 총합 cap
_TRUNC_MARK = "…(잘림)"

# f3ccb40c 이미지-멀티모달: 이미지는 텍스트 추출 대신 단기 V4 read 서명 URL 을 payload 에 실어
# 에이전트 런타임이 fetch→멀티모달 모델이 직접 view(백엔드 vision 안 함). 30분 = 에이전트 async 처리 윈도.
_SIGNED_URL_TTL = timedelta(minutes=30)

_DOC_EXTS = frozenset({"pdf", "docx", "txt", "csv", "md"})
_IMAGE_EXTS = frozenset({"jpg", "jpeg", "png", "gif", "webp"})
_HEADER = "\n\n--- 첨부 내용 ---\n"


def _canonical_object_path(stored_url: str) -> str | None:
    """stored attachment url → canonical GCS object path. 우리 버킷 외/비정상이면 None.

    attachments.py 의 동일 규칙(신규=bare path·legacy=public prefix·외부 도메인=None).
    """
    if not stored_url:
        return None
    if stored_url.startswith(_PUBLIC_PREFIX):
        return stored_url[len(_PUBLIC_PREFIX):]
    if "://" in stored_url:
        return None
    return stored_url


def _ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _is_scoped_to_conversation(object_path: str, project_id, conversation_id, org_id) -> bool:
    """canonical object path 가 **이 대화**에 스코프됐는지 — 등록(asset_registry)·authorize 와 **동일**
    `path_in_source_scope` SSOT 로 판정(까심 재QA: 규칙 단일화).

    legacy `chat/<proj>/<conv>/` + S7 `org/<org>/project/<proj>/chat/<conv>/` 인식하되 **org/project/conv
    전 tenancy segment 를 exact 바인딩**. ⚠️ CRITICAL(까심): 신 namespace 의 org segment(parts[1])를
    검증 안 하면 project_id+conv_id 만 맞춘 **cross-org path 가 통과**(SA objectAdmin 으로 타 org 객체
    fetch→에이전트 컨텍스트 누출). path_in_source_scope 는 `org/{org_id}/...` exact-prefix 로 org 까지 바인딩.
    """
    return path_in_source_scope(
        object_path, "conversation_message", project_id, conversation_id, org_id
    )


async def _download_object(object_path: str) -> bytes:
    """객체 bytes 다운로드 — provider 추상 경유(E-STORAGE-SSOT S1·AC3). _BUCKET=컨테이너.

    호출 전 _is_scoped_to_conversation 으로 IDOR 게이트를 통과한 path 만 받는다(스코프 로직은 본 모듈 유지).
    """
    return await get_storage_provider().download_object(_BUCKET, object_path)


async def _signed_read_url(object_path: str) -> str | None:
    """scoped 객체에 대한 단기 read 서명 URL — provider 추상 경유(GCS V4 / S3 presigned / local HMAC).

    실패 시 None(best-effort). 호출 전 _is_scoped_to_conversation 으로 IDOR 게이트를 통과한 path 만 받는다.
    """
    return await get_storage_provider().signed_read_url(
        _BUCKET, object_path, ttl=_SIGNED_URL_TTL
    )


def _extract_text(ext: str, data: bytes) -> str:
    """확장자별 텍스트 추출. 미지원/실패 시 빈 문자열."""
    if ext in ("txt", "csv", "md"):
        return data.decode("utf-8", errors="replace")
    if ext == "pdf":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    if ext == "docx":
        import docx  # python-docx

        document = docx.Document(io.BytesIO(data))
        return "\n".join(p.text for p in document.paragraphs)
    return ""


def _cap(text: str, limit: int) -> str:
    """text 를 limit 자 이내로 — 잘릴 때 마커 포함 길이도 limit 이내(QA RC LOW: 마커 미카운트로
    총량 초과 방지)."""
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    keep = max(0, limit - len(_TRUNC_MARK))
    return text[:keep] + _TRUNC_MARK


async def build_attachment_context(
    attachments: list[dict] | None,
    *,
    project_id,
    conversation_id,
    org_id,
) -> tuple[str, list[dict]]:
    """메시지 attachments(list of {url,name,content_type,size}) → (에이전트 주입용 텍스트 블록, 이미지 목록).

    문서=GCS fetch+추출, 이미지=단기 V4 서명 URL(f3ccb40c·백엔드 vision 안 함), 미지원/실패=안내 라인.
    총량 cap(헤더·마커·안내 라인 포함)·도달 시 중단. best-effort — 개별 첨부 실패는 안내 라인으로 흡수.

    반환:
      - text: content 에 주입할 텍스트 블록(이미지는 `![name](signed-url)` 마크다운 — 멀티모달 에이전트 fetch+view).
        빈 결과면 "".
      - images: 구조화 이미지 목록 `[{url, name, mime}]`(payload `images` 필드용·Hermes 등 런타임 clean 계약).

    ⚠️ 보안: 문서 fetch·이미지 서명 모두 object path 가 **이 (project, conversation)에 스코프된 chat
    첨부**일 때만 수행(_is_scoped_to_conversation). 타 대화/외부 객체 URL 은 거부(IDOR 차단·QA RC HIGH).
    """
    if not attachments:
        return "", []
    blocks: list[str] = []
    images: list[dict] = []
    total = len(_HEADER)  # 헤더도 총량에 카운트(LOW)

    def _append(line: str) -> bool:
        """line 추가. 총량(헤더+블록+구분자+마커) 한도 초과면 한도 라인(자리 있으면) 후 중단(False)."""
        nonlocal total
        sep = 2 if blocks else 0  # "\n\n" join
        # QA RC LOW: blocks 가드 제거 — 첫 첨부(blocks 빈)도 overflow 체크(긴 파일명 첫 라인 24k 초과 방지).
        if total + sep + len(line) > _TOTAL_CAP:
            marker = "[…첨부 컨텍스트 총량 한도 도달 — 이후 첨부 생략]"
            if total + sep + len(marker) <= _TOTAL_CAP:  # 마커도 한도 내일 때만(총량 엄수)
                blocks.append(marker)
                total += sep + len(marker)
            return False
        blocks.append(line)
        total += sep + len(line)
        return True

    for a in attachments:
        if not isinstance(a, dict):
            continue
        name = (a.get("name") or "첨부").strip() or "첨부"
        ctype = (a.get("content_type") or "").strip()
        ext = _ext(name)

        # 이미지(f3ccb40c) — 백엔드 vision 안 함. scope 통과 객체에 단기 V4 서명 URL 발급 →
        # content 엔 `![name](url)` 마크다운(멀티모달 에이전트 fetch+view) + images 목록(구조화 계약).
        if ctype.startswith("image/") or ext in _IMAGE_EXTS:
            obj = _canonical_object_path(a.get("url") or "")
            if obj is None or not _is_scoped_to_conversation(obj, project_id, conversation_id, org_id):
                if not _append(f"[이미지 첨부(접근 범위 밖): {name}]"):
                    break
                continue
            signed = await _signed_read_url(obj)
            if not signed:
                if not _append(f"[이미지 첨부: {name} — URL 생성 실패]"):
                    break
                continue
            if not _append(f"![{name}]({signed})"):
                break
            images.append({"url": signed, "name": name, "mime": ctype or f"image/{ext or 'png'}"})
            continue

        # 미지원 형식 안내
        if ext not in _DOC_EXTS:
            if not _append(f"[첨부(미지원 형식): {name} ({ctype or ext or 'unknown'})]"):
                break
            continue

        obj = _canonical_object_path(a.get("url") or "")
        # ⚠️ 보안: 우리 버킷 객체 + 이 대화에 스코프된 path 만 fetch(타 대화/story/외부 거부)
        if obj is None or not _is_scoped_to_conversation(obj, project_id, conversation_id, org_id):
            if not _append(f"[첨부(접근 범위 밖): {name}]"):
                break
            continue

        try:
            data = await _download_object(obj)
            text = _extract_text(ext, data).strip()
        except Exception:
            logger.warning("attachment_context: 추출 실패 name=%s", name, exc_info=True)
            if not _append(f"[첨부(추출 실패): {name}]"):
                break
            continue

        if not text:
            if not _append(f"[첨부: {name} — 추출 텍스트 없음]"):
                break
            continue

        # per-attachment cap + 남은 총량 내로(마커 포함 길이 _cap 이 보장)
        prefix = f"[첨부: {name}]\n"
        remaining = _TOTAL_CAP - total - (2 if blocks else 0) - len(prefix)
        capped = _cap(text, min(_PER_ATTACHMENT_CAP, remaining))
        if not capped:
            if not _append(f"[첨부: {name} — 총량 한도로 생략]"):
                break
            continue
        if not _append(prefix + capped):
            break

    if not blocks:
        return "", images
    return _HEADER + "\n\n".join(blocks), images
