"""문서 관련 MCP 도구 (5개) — E-SECURITY SEC-S1 확장: delete_doc 제거(에이전트 삭제 차단,
delete_story와 동형 조치. 까심 적대적 QA 발견 갭)."""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput
from .attachments import upload_attachments


class ListDocsInput(SprintableInput):
    tags: list[str] | None = None


class GetDocInput(SprintableInput):
    slug: str


class SearchDocsInput(SprintableInput):
    query: str
    tags: list[str] | None = None


class CreateDocInput(SprintableInput):
    title: str
    slug: str
    content: str | None = None
    content_format: Literal["markdown", "html"] | None = None
    parent_id: str | None = None
    is_folder: bool | None = None
    icon: str | None = None
    tags: list[str] | None = None


class UpdateDocInput(SprintableInput):
    doc_id: str
    title: str | None = None
    content: str | None = None
    content_format: Literal["markdown", "html"] | None = None
    icon: str | None = None
    tags: list[str] | None = None
    parent_id: str | None = None
    expected_updated_at: str | None = None
    force_overwrite: bool | None = None
    # [{content_base64, name, content_type}, ...] — 스샷/작은 문서(최대 5개·파일당 2MiB·총 6MiB).
    # 업로드 後 완성된 embed HTML(TipTap file-node/image-node 계약과 정확히 일치 — 에이전트가 마크업을
    # 몰라도 됨)을 content 끝에 append. 이 호출에 content 를 안 실었으면 현재 저장된 content 를 먼저
    # 읽어 그 뒤에 append(기존 본문을 지우지 않음).
    attachments: list[dict] | None = None


async def list_docs(args: ListDocsInput) -> list[TextContent]:
    """프로젝트 문서 목록 조회 (tree 또는 tag 필터)."""
    params: dict = {"project_id": client.project_id}
    if args.tags:
        params["tags"] = ",".join(args.tags)
    else:
        params["view"] = "tree"
    try:
        return ok(await client.get("/api/v2/docs", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_doc(args: GetDocInput) -> list[TextContent]:
    """slug로 문서 단건 조회 — 본문(content) 포함.

    8a8e881a: list 엔드포인트(/api/v2/docs?slug=)는 DocSummary(메타·snippet만·content 미포함)를
    반환해 에이전트가 서로의 doc 본문을 못 읽었다. slug→id 해소 후 GET /{id}(DocResponse·content
    보유)를 surface한다. 메타데이터(id·title·slug·tags·updated_at)는 DocResponse에 그대로 있어
    기존 소비자 무영향(content 필드만 추가).
    """
    try:
        summaries = await client.get(
            "/api/v2/docs", params={"project_id": client.project_id, "slug": args.slug}
        )
        if not summaries:
            return err(f"Doc not found: {args.slug}")
        doc_id = summaries[0]["id"]
        return ok(await client.get(f"/api/v2/docs/{doc_id}"))
    except Exception as exc:
        return err(str(exc))


async def search_docs(args: SearchDocsInput) -> list[TextContent]:
    """문서 제목/본문 검색 (tag 필터 선택)."""
    params: dict = {"project_id": client.project_id, "q": args.query}
    if args.tags:
        params["tags"] = ",".join(args.tags)
    try:
        return ok(await client.get("/api/v2/docs", params=params))
    except Exception as exc:
        return err(str(exc))


async def create_doc(args: CreateDocInput) -> list[TextContent]:
    """문서 생성."""
    body: dict = {"title": args.title, "slug": args.slug, "project_id": client.project_id}
    for field in ("content", "content_format", "parent_id", "icon"):
        val = getattr(args, field)
        if val is not None:
            body[field] = val
    if args.is_folder is not None:
        body["is_folder"] = args.is_folder
    if args.tags is not None:
        body["tags"] = args.tags
    try:
        return ok(await client.post("/api/v2/docs", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_doc(args: UpdateDocInput) -> list[TextContent]:
    """문서 수정."""
    updates: dict = {}
    for field in ("title", "content", "content_format", "icon", "parent_id", "expected_updated_at"):
        val = getattr(args, field)
        if val is not None:
            updates[field] = val
    if args.tags is not None:
        updates["tags"] = args.tags
    if args.force_overwrite is not None:
        updates["force_overwrite"] = args.force_overwrite
    try:
        if args.attachments:
            uploaded = await upload_attachments(
                f"/api/v2/docs/{args.doc_id}/attachments", args.attachments,
            )
            if uploaded:
                base_content = updates.get("content")
                if base_content is None:
                    current = await client.get(f"/api/v2/docs/{args.doc_id}")
                    base_content = (current.get("content") or "") if isinstance(current, dict) else ""
                snippets = "".join(a["embed_snippet"] for a in uploaded if isinstance(a, dict) and a.get("embed_snippet"))
                updates["content"] = f"{base_content}\n{snippets}" if base_content else snippets
        return ok(await client.patch(f"/api/v2/docs/{args.doc_id}", json=updates))
    except Exception as exc:
        return err(str(exc))
