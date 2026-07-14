"""시각 산출물(visual_artifact) MCP 도구(7개) — E-CANVAS C1-S3(story 8bace49e)+
C2-S6(story 0edca31e, 코멘트 왕복)+C3-S7(story 940266db, 편집 왕복)+C4-S8(story a5118cb0,
정본 제안 — 승인은 always-HITL이라 MCP 미제공)."""
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


class CanvasBoundsInput(SprintableInput):
    """뷰어 통합 재설계(story 1948d19d): sandbox iframe은 내부 콘텐츠 크기를 서버가 측정할 수
    없어, 렌더 산출물이 자기 프레임 크기(CSS px)를 직접 선언한다. w/h는 양수·상한(20000px)
    — 위반 시 서버가 422로 거절."""
    w: int
    h: int


class CreateArtifactInput(SprintableInput):
    title: str
    story_id: str | None = None
    epic_id: str | None = None
    doc_id: str | None = None
    source: str | None = None  # "created" | "imported" — 기본 created
    nodes: list[ArtifactNodeInput] | None = None
    summary: str | None = None  # 최초 버전 변경 이유(선택)
    # 뷰어 통합 재설계(story 1948d19d): 생성 시점 프레임 크기(선택 — 미선언 시 FE가 기본
    # 아트보드 규약으로 폴백). 최초 버전(version_number=1)에 저장된다.
    canvas_bounds: CanvasBoundsInput | None = None


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
    # 뷰어 통합 재설계(story 1948d19d): canvas_bounds만으로도 편집 호출 가능해져 operations가
    # 선택제로 바뀌었다(둘 다 비면 서버가 422) — 프레임 크기만 갱신하는 호출도 유효.
    operations: list[ArtifactNodeOperationInput] = []
    summary: str | None = None  # 새 버전 변경 이유(선택)
    source_comment_id: str | None = None  # 이 편집이 응답한 코멘트(선택, closed-loop)
    # 프레임 크기 재선언(선택) — 버전 단위 SSOT라 이것만 바뀌어도 무-mutate 버전 원칙대로 새
    # 버전이 생긴다. 미지정 시 직전 버전 값을 그대로 이어받는다(operations만으로 편집해도
    # 프레임은 자동 보존됨 — 매 호출마다 재선언할 필요 없음).
    canvas_bounds: CanvasBoundsInput | None = None


class ListSpecPinsInput(SprintableInput):
    artifact_id: str


class CreateSpecPinInput(SprintableInput):
    """편집 캔버스 핀 저작(story 7fe16274) — description pane 저작 입구. 항상 artifact의
    **최신 버전**에 붙는다(과거 버전 핀은 그때 스냅샷으로 불변)."""
    artifact_id: str
    anchor_type: str  # "coord"(좌표 — v1 기본) | "node"(구조화 노드 참조 — reflow-safe)
    anchor_x: float | None = None  # anchor_type="coord" 필수(canvas_bounds 좌표계, 0 이상)
    anchor_y: float | None = None  # anchor_type="coord" 필수
    node_id: str | None = None  # anchor_type="node" 필수(get_artifact의 node.id·최신 버전 소속)
    description: str  # non-empty 강제 — 빈 스펙 커밋 차단(핸드오프 계약 규율)


class UpdateSpecPinInput(SprintableInput):
    artifact_id: str
    pin_id: str
    description: str  # non-empty 강제


class DeleteSpecPinInput(SprintableInput):
    artifact_id: str
    pin_id: str


class ProposeCanonicalInput(SprintableInput):
    artifact_id: str
    version_number: int


class ListArtifactsInput(SprintableInput):
    # 프로젝트 스코프는 서버-파생(키 컨텍스트·비-caller-suppliable) — 아래 필터만 선택 지정.
    story_id: str | None = None
    epic_id: str | None = None
    doc_id: str | None = None


async def create_artifact(args: CreateArtifactInput) -> list[TextContent]:
    """시각 산출물 생성(에이전트 생성 입구, blueprint §F1) — 트리(nodes[])로 구조화해 전달.
    임포트된 raw HTML/이미지는 type="html_blob" 노드 하나로 감싸도 된다.
    canvas_bounds{w,h}(선택): 렌더 결과의 자기 프레임 크기(CSS px) — sandbox iframe이라 서버가
    내부 콘텐츠를 측정할 수 없어 호출자 선언이 필요. 미지정 시 FE가 기본 아트보드로 폴백."""
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
        if args.canvas_bounds:
            body["canvas_bounds"] = args.canvas_bounds.model_dump(exclude_none=True)
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


async def list_artifacts(args: ListArtifactsInput) -> list[TextContent]:
    """현재 프로젝트의 시각 산출물 목록 조회 — story_id/epic_id/doc_id로 필터 가능(미지정 시
    프로젝트 전체). 각 항목은 artifact 메타(title·story/epic/doc 연결·latest 버전 번호)만 반환하며
    노드 트리는 미포함 — 특정 artifact의 nodes/상세는 get_artifact로 조회."""
    try:
        params: dict = {}
        if args.story_id:
            params["story_id"] = args.story_id
        if args.epic_id:
            params["epic_id"] = args.epic_id
        if args.doc_id:
            params["doc_id"] = args.doc_id
        result = await client.get("/api/v2/visual-artifacts", params=params)
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
    """artifact 요소를 operations[]로 편집 — 휴먼 딸깍 편집과 동일 엔드포인트를 경유해 "같은 객체를
    양쪽이 편집"(AC4 왕복). 편집은 항상 새 버전을 만든다(무-mutate 버전 원칙). 대상자에게
    artifact.updated 이벤트 전파.
    각 operation = {op, id, type?, props?, parent_id?, sort_order?, description?}:
      · op="add": 새 노드(type 필수·props 초기값·id 미지정 시 서버 생성).
      · op="update": **대상 노드 = `id`**(get_artifact의 node.id·`node_id` 아님)·props 지정 시 전체 교체.
      · op="delete": **대상 노드 = `id`**만.
    (대상 요소는 항상 `id` 필드로 지정 — 코멘트 앵커의 node_id와 혼동 주의.)
    canvas_bounds{w,h}(선택): 프레임 크기 재선언 — 버전 단위 SSOT라 미지정 시 직전 버전 값을
    그대로 이어받는다(매 편집마다 재선언 불요). operations를 비우고 canvas_bounds만 보내
    프레임 크기만 갱신하는 호출도 유효(둘 다 비면 서버가 422)."""
    try:
        body: dict = {
            "operations": [op.model_dump(exclude_none=True) for op in args.operations],
        }
        if args.summary:
            body["summary"] = args.summary
        if args.source_comment_id:
            body["source_comment_id"] = args.source_comment_id
        if args.canvas_bounds:
            body["canvas_bounds"] = args.canvas_bounds.model_dump(exclude_none=True)
        result = await client.post(f"/api/v2/visual-artifacts/{args.artifact_id}/edit", json=body)
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def list_spec_pins(args: ListSpecPinsInput) -> list[TextContent]:
    """artifact 최신 버전의 스펙 핀 목록 조회(description pane 저작 대상) — 코멘트와 달리
    작성자/시간 속성 없음(감시금지)."""
    try:
        result = await client.get(f"/api/v2/visual-artifacts/{args.artifact_id}/pins")
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def create_spec_pin(args: CreateSpecPinInput) -> list[TextContent]:
    """artifact에 스펙 핀 추가 — 요소/좌표에 description(핸드오프 스펙)을 앵커. `anchor_type`이
    "coord"면 `anchor_x`/`anchor_y`(canvas_bounds 좌표계, 0 이상) 둘 다 필수·`node_id` 금지.
    "node"면 `node_id`(get_artifact의 node.id) 필수·좌표 금지. `description`은 non-empty
    강제(빈 스펙 저장 불가). 핀은 최신 버전에 붙고, 이후 편집(edit_artifact)마다 자동으로
    새 버전에 계승된다(node 앵커는 그 노드가 살아있는 한 재해석·삭제되면 핀도 함께 소멸)."""
    try:
        body: dict = {"anchor_type": args.anchor_type, "description": args.description}
        if args.anchor_x is not None:
            body["anchor_x"] = args.anchor_x
        if args.anchor_y is not None:
            body["anchor_y"] = args.anchor_y
        if args.node_id:
            body["node_id"] = args.node_id
        result = await client.post(f"/api/v2/visual-artifacts/{args.artifact_id}/pins", json=body)
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def update_spec_pin(args: UpdateSpecPinInput) -> list[TextContent]:
    """스펙 핀의 description 재저작(팝오버 재개와 동형 — 덮어씀, 스레드/이력 없음). 최신 버전
    소속 핀만 대상(과거 버전 핀은 불변 스냅샷이라 수정 불가 → 404)."""
    try:
        result = await client.patch(
            f"/api/v2/visual-artifacts/{args.artifact_id}/pins/{args.pin_id}",
            json={"description": args.description},
        )
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def delete_spec_pin(args: DeleteSpecPinInput) -> list[TextContent]:
    """스펙 핀 삭제(최신 버전 소속만 대상)."""
    try:
        result = await client.delete(f"/api/v2/visual-artifacts/{args.artifact_id}/pins/{args.pin_id}")
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def propose_canonical_version(args: ProposeCanonicalInput) -> list[TextContent]:
    """이 버전을 정본으로 제안(E-DG 게이트 생성) — 제안만, **승인은 항상 휴먼**(에이전트는
    이 도구로 제안까지만 가능. 승인/반려는 POST /api/v2/gates/{id}/transition, human-only)."""
    try:
        result = await client.post(
            f"/api/v2/visual-artifacts/{args.artifact_id}/versions/{args.version_number}/canonicalize",
        )
        return ok(result)
    except Exception as exc:
        return err(str(exc))
