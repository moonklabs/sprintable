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

import asyncio
import io
import logging
import os

logger = logging.getLogger(__name__)

_BUCKET = os.environ.get("GCS_MEMO_ATTACHMENTS_BUCKET", "sprintable-memo-attachments")
_PUBLIC_PREFIX = f"https://storage.googleapis.com/{_BUCKET}/"

_PER_ATTACHMENT_CAP = 8000   # §7-3 첨부당 자수 cap
_TOTAL_CAP = 24000           # §7-3 총합 cap
_TRUNC_MARK = "…(잘림)"

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


async def _download_object(object_path: str) -> bytes:
    """GCS 객체 bytes 다운로드 — 서비스계정(ADC) 직접 read. blocking client 는 thread 로 격리."""

    def _blocking() -> bytes:
        from google.cloud import storage  # 지연 import(의존 없을 때 모듈 로드 무영향)

        client = storage.Client()
        return client.bucket(_BUCKET).blob(object_path).download_as_bytes()

    return await asyncio.to_thread(_blocking)


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
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + _TRUNC_MARK


async def build_attachment_context(attachments: list[dict] | None) -> str:
    """메시지 attachments(list of {url,name,content_type,size}) → 에이전트 주입용 텍스트 블록.

    문서=GCS fetch+추출, 이미지=메타 안내(v1), 미지원/실패=안내 라인. 총량 cap 도달 시 중단.
    빈 결과면 "" (주입 무영향). best-effort — 개별 첨부 실패는 안내 라인으로 흡수.
    """
    if not attachments:
        return ""
    blocks: list[str] = []
    total = 0
    for a in attachments:
        if not isinstance(a, dict):
            continue
        name = (a.get("name") or "첨부").strip() or "첨부"
        ctype = (a.get("content_type") or "").strip()
        ext = _ext(name)

        # 이미지 — v1 은 메타 안내(본격 분석=S2 백엔드 Vision 캡션)
        if ctype.startswith("image/") or ext in _IMAGE_EXTS:
            blocks.append(f"[이미지 첨부: {name} ({ctype or 'image'}) — 이미지 분석은 준비 중]")
            continue

        # 미지원 형식 안내
        if ext not in _DOC_EXTS:
            blocks.append(f"[첨부(미지원 형식): {name} ({ctype or ext or 'unknown'})]")
            continue

        obj = _canonical_object_path(a.get("url") or "")
        if obj is None:
            blocks.append(f"[첨부(읽기 불가 경로): {name}]")
            continue

        try:
            data = await _download_object(obj)
            text = _extract_text(ext, data).strip()
        except Exception:
            logger.warning("attachment_context: 추출 실패 name=%s", name, exc_info=True)
            blocks.append(f"[첨부(추출 실패): {name}]")
            continue

        if not text:
            blocks.append(f"[첨부: {name} — 추출 텍스트 없음]")
            continue

        remaining = _TOTAL_CAP - total
        capped = _cap(text, min(_PER_ATTACHMENT_CAP, remaining))
        total += len(capped)
        blocks.append(f"[첨부: {name}]\n{capped}")
        if total >= _TOTAL_CAP:
            blocks.append("[…첨부 컨텍스트 총량 한도 도달 — 이후 첨부 생략]")
            break

    if not blocks:
        return ""
    return _HEADER + "\n\n".join(blocks)
