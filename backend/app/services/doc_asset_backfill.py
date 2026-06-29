"""E-STORAGE-SSOT S4 Phase2 (009fd681): doc 본문 base64 첨부 → GCS 자산 이관 + 본문 rewrite.

핸드오프 §1 LOCK 계약: 노드 attrs `{assetId, filename, size, mime}`(`data-asset-id` ref). 렌더러는
`data:`/base64 면 base64 렌더, `data-asset-id` 면 `sign?asset_id` 렌더(legacy 호환). 이 배치가 legacy
base64 노드를 asset-ref 노드로 치환하면 자동으로 sign 경로로 전환된다.

설계:
- **멱등**: 변환된 노드는 `data:`/`data-file-data` 가 없으므로 재스캔 대상 아님 → 2회차 0.
- **dry-run 기본**(apply=False): 변환 대상만 count, 쓰기 0. apply=True 만 put/register/content update.
- **부분실패 graceful**: 노드별 put 실패 → 그 노드는 base64 유지(continue), 나머지 진행.
- **additive register**: `sync_attachment_assets(reconcile=False)` — 같은 doc 의 기존 FE-업로드 link clobber 금지.
- **per-doc 원자**: 한 doc 의 성공 노드들을 모아 content 1회 update(트랜잭션).

⚠️ 이미지 ref 노드 정확 markup(img 태그 vs custom node·attr 이름)은 미르코 렌더러 contract(핸드오프 §1
byte-exact). `to_asset_ref_image_node` 한 곳만 §1 확정 후 맞추면 된다(PO 크럭스: option ② = src persist
금지·data-asset-id 만·렌더 시 sign 해소).
"""
from __future__ import annotations

import base64
import logging
import mimetypes
import re
import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.doc import Doc
from app.services.asset_registry import DEFAULT_CONTAINER, sync_attachment_assets

logger = logging.getLogger(__name__)

# legacy 파일 노드: <div data-type="fileAttachment" ... data-file-data="data:..."></div>
_FILE_NODE_RE = re.compile(
    r'<div\b[^>]*\bdata-type="fileAttachment"[^>]*\bdata-file-data="(?P<data>data:[^"]*)"[^>]*>\s*</div>',
    re.IGNORECASE,
)
# legacy 이미지(markdown): ![alt](data:image/...;base64,...)
_IMG_MD_RE = re.compile(r'!\[(?P<alt>[^\]]*)\]\((?P<data>data:image/[^)\s]+)\)')
# legacy 이미지(raw HTML·width 보존형): <img ... src="data:image/..." ...>
_IMG_HTML_RE = re.compile(r'<img\b[^>]*\bsrc="(?P<data>data:image/[^"]*)"[^>]*>', re.IGNORECASE)

_ATTR_RE_CACHE: dict[str, re.Pattern] = {}


def _attr(tag: str, name: str) -> str:
    """tag 문자열에서 data-* attr 값 추출(순서 무관·없으면 '')."""
    pat = _ATTR_RE_CACHE.get(name)
    if pat is None:
        pat = re.compile(rf'\b{re.escape(name)}="([^"]*)"', re.IGNORECASE)
        _ATTR_RE_CACHE[name] = pat
    m = pat.search(tag)
    return m.group(1) if m else ""


def _esc(s: str) -> str:
    """attr 값 HTML escape(FE turndown safeAttr 와 동형: & " < > )."""
    return (
        s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
    )


def _decode_data_url(data_url: str) -> tuple[bytes, str] | None:
    """`data:{mime};base64,{b64}` → (bytes, mime). 비-base64/파싱 실패 시 None."""
    m = re.match(r"data:(?P<mime>[^;,]*);base64,(?P<b64>.*)", data_url, re.DOTALL)
    if not m:
        return None
    try:
        raw = base64.b64decode(m.group("b64"), validate=False)
    except Exception:
        return None
    if not raw:
        return None
    return raw, (m.group("mime") or "application/octet-stream")


def _safe_filename(name: str, mime: str) -> str:
    """파일명 정규화(경로/공백 제거)·없으면 mime 기반 생성."""
    base = re.sub(r"[^A-Za-z0-9._-]", "_", (name or "").strip()).strip("._") or ""
    if not base:
        ext = mimetypes.guess_extension(mime) or ".bin"
        base = f"attachment{ext}"
    return base[:120]


def to_asset_ref_file_node(asset_id: uuid.UUID, filename: str, size: int, mime: str) -> str:
    """파일 노드 asset-ref 직렬화(미르코 §1 LOCK byte-exact: data-asset-id **LAST**·data-file-data 없음).

    `<div data-type="fileAttachment" data-filename data-size data-mime-type data-asset-id></div>`
    """
    return (
        f'<div data-type="fileAttachment" data-filename="{_esc(filename)}" data-size="{size}" '
        f'data-mime-type="{_esc(mime)}" data-asset-id="{asset_id}"></div>'
    )


def to_asset_ref_image_node(
    asset_id: uuid.UUID, filename: str, size: int, mime: str, *, width: int | None = None,
    alt: str | None = None,
) -> str:
    """이미지 노드 asset-ref 직렬화 — **FE content-converter `imageWithAsset` 룰(실 round-trip 코드)
    byte-exact**. ⚠️ §1.1 doc(`width="{px}"`·width-before-alt)은 부정확 — 실 코드는:
    - escape = **quote-only**(`"`→&quot;·`&`/`<`/`>` 미escape·FE `a()` 동형).
    - order = data-asset-id, data-filename, data-size, data-mime-type, **alt, then width**.
    - width = **`style="width:{px}px;max-width:100%;height:auto"`** (width attr 아님).
    - src 미출력(option ②·signed URL ephemeral·렌더 시 data-asset-id→sign?asset_id 해소).
    """
    def _q(s: str) -> str:  # FE image a(): 따옴표만 escape(파일 노드 safeAttr 와 다름)
        return s.replace('"', "&quot;")

    s = (
        f'<img data-asset-id="{asset_id}" data-filename="{_q(filename)}" '
        f'data-size="{size}" data-mime-type="{_q(mime)}"'
    )
    if alt:
        s += f' alt="{_q(alt)}"'
    if width:
        s += f' style="width:{width}px;max-width:100%;height:auto"'
    return s + ">"


_WIDTH_STYLE_RE = re.compile(r"width:\s*(\d+)\s*px", re.IGNORECASE)
_WIDTH_ATTR_RE = re.compile(r'\bwidth="(\d+)"', re.IGNORECASE)


def _extract_width(tag: str) -> int | None:
    """legacy <img> width 추출 — style="width:Xpx" 또는 width="X" attr. 회귀0(resize 보존)."""
    style = _attr(tag, "style")
    m = _WIDTH_STYLE_RE.search(style) or _WIDTH_ATTR_RE.search(tag)
    return int(m.group(1)) if m else None


class _Node:
    __slots__ = ("start", "end", "kind", "data_url", "alt", "filename", "width", "asset_ref")

    def __init__(self, start, end, kind, data_url, alt, filename, width=None):
        self.start = start
        self.end = end
        self.kind = kind  # 'file' | 'image'
        self.data_url = data_url
        self.alt = alt
        self.filename = filename
        self.width = width
        self.asset_ref: str | None = None


def _scan_nodes(content: str) -> list[_Node]:
    """본문에서 base64 노드(파일+이미지) 추출(span·kind·data-url·메타). 멱등: data-asset-id 노드는 미매치."""
    nodes: list[_Node] = []
    for m in _FILE_NODE_RE.finditer(content):
        tag = m.group(0)
        nodes.append(_Node(m.start(), m.end(), "file", m.group("data"),
                           _attr(tag, "data-filename"), _attr(tag, "data-filename")))
    for m in _IMG_MD_RE.finditer(content):
        nodes.append(_Node(m.start(), m.end(), "image", m.group("data"), m.group("alt"), m.group("alt")))
    for m in _IMG_HTML_RE.finditer(content):
        tag = m.group(0)
        nodes.append(_Node(m.start(), m.end(), "image", m.group("data"),
                           _attr(tag, "alt"), _attr(tag, "alt"), _extract_width(tag)))
    return nodes


async def backfill_doc(
    session: AsyncSession,
    *,
    doc_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    content: str,
    apply: bool,
) -> dict:
    """단일 doc backfill. dry-run(apply=False)=count만. 반환 counts + (apply 시) 새 content."""
    nodes = _scan_nodes(content)
    result = {"found": len(nodes), "converted": 0, "failed": 0, "skipped_modified": 0}
    if not nodes or not apply:
        return result

    from app.services.storage import get_storage_provider  # call-time(테스트 patch·sync 와 동일 경로)

    provider = get_storage_provider()
    attachments: list[dict] = []
    for n in nodes:
        decoded = _decode_data_url(n.data_url)
        if decoded is None:
            result["failed"] += 1
            continue
        raw, mime = decoded
        fname = _safe_filename(n.filename, mime)
        obj = f"org/{org_id}/project/{project_id}/doc/{doc_id}/{uuid.uuid4()}-{fname}"
        ok = await provider.put_object(DEFAULT_CONTAINER, obj, raw, content_type=mime)
        if not ok:
            result["failed"] += 1
            continue  # base64 유지(부분실패 graceful)
        n.filename, n.alt = fname, (n.alt or fname)
        attachments.append({"url": obj, "name": fname, "content_type": mime, "_node": n,
                            "_size": len(raw), "_mime": mime})

    if not attachments:
        return result

    # 낙관적 동시성(PO codex: lost-update race) — 스캔 스냅샷(content)↔content write 사이 유저가 그 doc 을
    # 편집하면 무조건 덮어쓰기가 유저 편집을 clobber(데이터유실). register(asset/link insert) + content CAS
    # (`WHERE content == 스냅샷`)를 savepoint 로 묶어, CAS miss(doc 변경됨)면 통째 rollback → asset/link
    # orphan 0(GCS blob 만 미참조로 잔류=무해)·base64 유지·다음 run 재변환. 정상은 savepoint→chunk commit persist.
    sp = await session.begin_nested()
    try:
        url_map = await sync_attachment_assets(
            session, org_id=org_id, project_id=project_id, source_type="doc",
            source_id=doc_id, attachments=[{"url": a["url"], "name": a["name"],
                                            "content_type": a["content_type"]} for a in attachments],
            reconcile=False,
        )
        for a in attachments:
            asset_id = url_map.get(a["url"])
            n = a["_node"]
            if asset_id is None:
                result["failed"] += 1
                continue  # register 미성공(scope 거부 등) → base64 유지
            if n.kind == "file":
                n.asset_ref = to_asset_ref_file_node(asset_id, n.filename, a["_size"], a["_mime"])
            else:
                n.asset_ref = to_asset_ref_image_node(
                    asset_id, n.filename, a["_size"], a["_mime"], width=n.width, alt=n.alt
                )

        # 성공 노드만 역순 치환(position 보존). 실패 노드는 base64 그대로.
        new_content = content
        applied = 0
        for n in sorted([x for x in nodes if x.asset_ref], key=lambda x: x.start, reverse=True):
            new_content = new_content[:n.start] + n.asset_ref + new_content[n.end:]
            applied += 1

        if applied and new_content != content:
            res = await session.execute(
                update(Doc)
                .where(Doc.id == doc_id, Doc.content == content)  # CAS — 스냅샷과 동일할 때만
                .values(content=new_content)
            )
            if not res.rowcount:
                await sp.rollback()  # doc 변경됨 — clobber 방지·asset/link insert 통째 취소
                result["skipped_modified"] = applied
                logger.warning("backfill: doc %s 스캔 후 변경됨 — lost-update 방지 skip", doc_id)
                return result
            result["content"] = new_content
        await sp.commit()
        result["converted"] = applied
    except Exception:
        await sp.rollback()
        raise
    return result


async def backfill_docs(
    session: AsyncSession,
    *,
    apply: bool,
    org_id: uuid.UUID | None = None,
    chunk: int = 100,
) -> dict:
    """전 doc(또는 org 한정) keyset chunk 순회 backfill. 반환 집계 counts."""
    totals = {"docs_scanned": 0, "docs_converted": 0, "found": 0, "converted": 0,
              "failed": 0, "skipped_modified": 0}
    last_id: uuid.UUID | None = None
    while True:
        q = select(Doc.id, Doc.org_id, Doc.project_id, Doc.content).order_by(Doc.id).limit(chunk)
        # base64 보유 doc만(인덱스 없는 LIKE·배치라 허용). data-file-data 또는 data:image.
        q = q.where(Doc.content.like("%data:%"))
        if org_id is not None:
            q = q.where(Doc.org_id == org_id)
        if last_id is not None:
            q = q.where(Doc.id > last_id)
        rows = (await session.execute(q)).all()
        if not rows:
            break
        for did, oid, pid, content in rows:
            last_id = did
            if pid is None or not content:
                continue
            totals["docs_scanned"] += 1
            r = await backfill_doc(session, doc_id=did, org_id=oid, project_id=pid,
                                   content=content, apply=apply)
            totals["found"] += r["found"]
            totals["converted"] += r["converted"]
            totals["failed"] += r["failed"]
            totals["skipped_modified"] += r["skipped_modified"]
            if r["converted"]:
                totals["docs_converted"] += 1
        if apply:
            await session.commit()  # chunk 단위 커밋(resumable·부분 진행 보존)
        if len(rows) < chunk:
            break
    return totals
