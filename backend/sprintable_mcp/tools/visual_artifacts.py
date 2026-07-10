"""시각 산출물(visual_artifact) MCP 도구(2개) — E-CANVAS C1-S3(story 8bace49e)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class ArtifactNodeInput(SprintableInput):
    type: str  # 컴포넌트 타입 | "html_blob"(캐치올 — 임포트 raw HTML/이미지)
    props: dict | None = None
    parent_id: str | None = None
    sort_order: int | None = None


class CreateArtifactInput(SprintableInput):
    title: str
    story_id: str | None = None
    epic_id: str | None = None
    doc_id: str | None = None
    source: str | None = None  # "created" | "imported" — 기본 created
    nodes: list[ArtifactNodeInput] | None = None
    summary: str | None = None  # 최초 버전 변경 이유(선택)


class GetArtifactInput(SprintableInput):
    artifact_id: str


async def create_artifact(args: CreateArtifactInput) -> list[TextContent]:
    """시각 산출물 생성(에이전트 생성 입구, blueprint §F1) — 트리(nodes[])로 구조화해 전달.
    임포트된 raw HTML/이미지는 type="html_blob" 노드 하나로 감싸도 된다."""
    try:
        body: dict = {"title": args.title}
        if args.story_id:
            body["story_id"] = args.story_id
        if args.epic_id:
            body["epic_id"] = args.epic_id
        if args.doc_id:
            body["doc_id"] = args.doc_id
        if args.source:
            body["source"] = args.source
        if args.nodes:
            body["nodes"] = [n.model_dump(exclude_none=True) for n in args.nodes]
        if args.summary:
            body["summary"] = args.summary
        result = await client.post("/api/v2/visual-artifacts", json=body)
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def get_artifact(args: GetArtifactInput) -> list[TextContent]:
    """시각 산출물 단건 조회(latest 버전 + nodes)."""
    try:
        result = await client.get(f"/api/v2/visual-artifacts/{args.artifact_id}")
        return ok(result)
    except Exception as exc:
        return err(str(exc))
