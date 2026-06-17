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


def _is_scoped_to_conversation(object_path: str, project_id, conversation_id) -> bool:
    """canonical object path 가 **이 대화**에 스코프됐는지(`chat/<project_id>/<conversation_id>/<file>`).

    ⚠️ 보안(QA RC HIGH·object-scope IDOR): 저장 URL 을 그대로 믿고 fetch 하면, 참가자가 *타 대화*
    객체 URL 을 첨부에 심어 백엔드 SA(objectAdmin) 권한으로 임의 객체를 읽어 그 내용을 에이전트
    컨텍스트로 누출시킬 수 있다(attachments.py 스코프 게이트 우회). 업로드 경로가 resource 에
    스코프되므로(`chat/<proj>/<conv>/<file>`), path segment 가 정확히 이 conversation 을 가리킬
    때만 fetch 한다(substring 금지·정확 segment 매치). 다른 conversation/story/외부 = 거부.
    """
    parts = object_path.split("/")
    return (
        len(parts) >= 4
        and parts[0] == "chat"
        and parts[1] == str(project_id)
        and parts[2] == str(conversation_id)
        and parts[3] != ""
    )


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
) -> str:
    """메시지 attachments(list of {url,name,content_type,size}) → 에이전트 주입용 텍스트 블록.

    문서=GCS fetch+추출, 이미지=메타 안내(v1), 미지원/실패=안내 라인. 총량 cap(헤더·마커·안내 라인
    포함)·도달 시 중단. 빈 결과면 "" (주입 무영향). best-effort — 개별 첨부 실패는 안내 라인으로 흡수.

    ⚠️ 보안: 문서 fetch 는 object path 가 **이 (project, conversation)에 스코프된 chat 첨부**일
    때만 수행(_is_scoped_to_conversation). 타 대화/외부 객체 URL 은 거부(IDOR 차단·QA RC HIGH).
    """
    if not attachments:
        return ""
    blocks: list[str] = []
    total = len(_HEADER)  # 헤더도 총량에 카운트(LOW)

    def _append(line: str) -> bool:
        """line 추가. 총량(헤더+블록+구분자+마커) 한도 초과면 한도 라인(자리 있으면) 후 중단(False)."""
        nonlocal total
        sep = 2 if blocks else 0  # "\n\n" join
        if blocks and total + sep + len(line) > _TOTAL_CAP:
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

        # 이미지 — v1 은 메타 안내(본격 분석=S2 백엔드 Vision 캡션)
        if ctype.startswith("image/") or ext in _IMAGE_EXTS:
            if not _append(f"[이미지 첨부: {name} ({ctype or 'image'}) — 이미지 분석은 준비 중]"):
                break
            continue

        # 미지원 형식 안내
        if ext not in _DOC_EXTS:
            if not _append(f"[첨부(미지원 형식): {name} ({ctype or ext or 'unknown'})]"):
                break
            continue

        obj = _canonical_object_path(a.get("url") or "")
        # ⚠️ 보안: 우리 버킷 객체 + 이 대화에 스코프된 path 만 fetch(타 대화/story/외부 거부)
        if obj is None or not _is_scoped_to_conversation(obj, project_id, conversation_id):
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
        return ""
    return _HEADER + "\n\n".join(blocks)
