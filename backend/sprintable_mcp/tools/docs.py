"""문서 관련 MCP 도구 (6개)."""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


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


class DeleteDocInput(SprintableInput):
    doc_id: str


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
        return ok(await client.patch(f"/api/v2/docs/{args.doc_id}", json=updates))
    except Exception as exc:
        return err(str(exc))


async def delete_doc(args: DeleteDocInput) -> list[TextContent]:
    """문서 소프트 삭제."""
    try:
        await client.delete(f"/api/v2/docs/{args.doc_id}")
        return ok({"deleted": True})
    except Exception as exc:
        return err(str(exc))
