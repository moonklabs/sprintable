"""시각 산출물(visual_artifact) MCP 도구(5개) — E-CANVAS C1-S3(story 8bace49e)+
C2-S6(story 0edca31e, 코멘트 왕복)+C3-S7(story 940266db, 편집 왕복)."""
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
    description: str | None = None  # C2-S6: description pane(요소별 스펙)


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


class ListArtifactCommentsInput(SprintableInput):
    artifact_id: str


class AddArtifactCommentInput(SprintableInput):
    artifact_id: str
    content: str
    node_id: str | None = None  # 요소 앵커(특정 노드에 코멘트)
    anchor_x: float | None = None  # 좌표 앵커(자유 핀 — node_id 대신 또는 병행)
    anchor_y: float | None = None
    parent_id: str | None = None  # 답글이면 부모 코멘트 id
    mentioned_ids: list[str] | None = None


class ArtifactNodeOperationInput(SprintableInput):
    op: str  # "add" | "update" | "delete"
    id: str | None = None  # add: 선택 / update·delete: 필수(대상 node id)
    type: str | None = None  # add 필수
    props: dict | None = None  # add: 초기값 / update: 지정 시 전체 교체
    parent_id: str | None = None
    sort_order: int | None = None
    description: str | None = None


class EditArtifactInput(SprintableInput):
    artifact_id: str
    operations: list[ArtifactNodeOperationInput]
    summary: str | None = None  # 새 버전 변경 이유(선택)
    source_comment_id: str | None = None  # 이 편집이 응답한 코멘트(선택, closed-loop)


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


async def list_artifact_comments(args: ListArtifactCommentsInput) -> list[TextContent]:
    """artifact 코멘트 스레드 조회(요소/좌표 앵커·resolve 상태 포함) — 휴먼 딸깍 피드백을
    에이전트가 읽고 반응하는 왕복 입구."""
    try:
        result = await client.get(f"/api/v2/visual-artifacts/{args.artifact_id}/comments")
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def add_artifact_comment(args: AddArtifactCommentInput) -> list[TextContent]:
    """artifact에 코멘트 추가 — node_id(요소 앵커) 또는 anchor_x/anchor_y(좌표 핀)로 위치 지정,
    parent_id로 답글. 대상자에게 comment.created 이벤트 전파(C0)."""
    try:
        body: dict = {"content": args.content}
        if args.node_id:
            body["node_id"] = args.node_id
        if args.anchor_x is not None:
            body["anchor_x"] = args.anchor_x
        if args.anchor_y is not None:
            body["anchor_y"] = args.anchor_y
        if args.parent_id:
            body["parent_id"] = args.parent_id
        if args.mentioned_ids:
            body["mentioned_ids"] = args.mentioned_ids
        result = await client.post(f"/api/v2/visual-artifacts/{args.artifact_id}/comments", json=body)
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def edit_artifact(args: EditArtifactInput) -> list[TextContent]:
    """artifact 요소를 add/update/delete로 편집 — 휴먼 딸깍 편집과 동일 엔드포인트를 경유해
    "같은 객체를 양쪽이 편집"(AC4 왕복). 편집은 항상 새 버전을 만든다(무-mutate 버전 원칙).
    대상자에게 artifact.updated 이벤트 전파."""
    try:
        body = {
            "operations": [op.model_dump(exclude_none=True) for op in args.operations],
        }
        if args.summary:
            body["summary"] = args.summary
        if args.source_comment_id:
            body["source_comment_id"] = args.source_comment_id
        result = await client.post(f"/api/v2/visual-artifacts/{args.artifact_id}/edit", json=body)
        return ok(result)
    except Exception as exc:
        return err(str(exc))
