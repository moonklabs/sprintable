"""문서 관련 MCP 도구 (6개) — E-SECURITY SEC-S1 확장: delete_doc 제거(에이전트 삭제 차단,
delete_story와 동형 조치. 까심 적대적 QA 발견 갭). story #2668(B3): submit_for_approval 추가
— 결재 상신 REST(POST /{id}/transition)를 알아야만 상신 가능했던 걸 MCP 표면에 올린다."""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent
from pydantic import model_validator

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput
from .attachments import upload_attachments


class ListDocsInput(SprintableInput):
    tags: list[str] | None = None
    cursor: str | None = None  # #2191: 이전 호출의 meta.next_cursor 값을 그대로 넘기면 다음 페이지


class GetDocInput(SprintableInput):
    """story #3324 — 이벤트 payload·참조 토큰(`entity:doc:id`)·게이트 neutral_facts는 전부
    doc id를 주는데, 이 도구는 slug만 받아 «Doc not found»로 막혔다(담롱·PO 둘 다 오늘 같은
    자리에서 걸림 — PO는 search_docs로 slug를 되짚어야 했다). `doc_id`(uuid)를 주면 slug
    해소 단계 자체를 건너뛰고 `GET /api/v2/docs/{doc_id}`로 직행 — REST는 이미 있어 MCP
    인자 배선만(신규 REST 0). slug/doc_id는 택1(ConversationScopedInput의 conversation_id/
    thread_id 검증과 동형 관례) — 둘 다 없으면 조용히 통과시키지 않고 명시 에러."""

    slug: str | None = None
    doc_id: str | None = None

    @model_validator(mode="after")
    def _require_slug_or_doc_id(self) -> "GetDocInput":
        if not self.slug and not self.doc_id:
            raise ValueError("slug 또는 doc_id 중 하나가 필요합니다.")
        return self


class SearchDocsInput(SprintableInput):
    query: str
    tags: list[str] | None = None
    limit: int | None = None  # BE search_full_text 분기는 결과 자체가 min(limit, 50)로 상한 — cursor는 없음(관련도순 정렬이라 페이지 이어달리기 불가, 아래 함수 docstring 참조).


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
    # story #2389 — 아래 넷은 백엔드 DocUpdate에 이미 있고 라우터가 실제로 적용하는데(app/
    # routers/docs.py) 이 스키마에 없어 조용히 버려지고 있었다(extra="ignore"가 검증 단계에서
    # 삼켜, args에 속성 자체가 안 생김 — read-but-ignored가 아니라 애초에 못 받음).
    slug: str | None = None
    slug_locked: bool | None = None
    sort_order: int | None = None
    doc_type: str | None = None
    assignee_id: str | None = None
    # [{content_base64, name, content_type}, ...] — 스샷/작은 문서(최대 5개·파일당 2MiB·총 6MiB).
    # 업로드 後 완성된 embed HTML(TipTap file-node/image-node 계약과 정확히 일치 — 에이전트가 마크업을
    # 몰라도 됨)을 content 끝에 append. 이 호출에 content 를 안 실었으면 현재 저장된 content 를 먼저
    # 읽어 그 뒤에 append(기존 본문을 지우지 않음).
    attachments: list[dict] | None = None


def _unwrap_docs_page(result: object) -> tuple[list, dict]:
    """story #2191: BE GET /api/v2/docs 가 bare array → {data,meta}(#2231 규약 A)로 바뀜.
    이 MCP 계층의 소비자들(list_docs·get_doc·search_docs)이 여전히 배열을 기대하므로
    공통으로 언랩한다. 구 bare-array 응답(롤백/미갱신 BE)도 하위호환으로 통과시킨다."""
    if isinstance(result, dict) and "data" in result:
        return result["data"], (result.get("meta") or {})
    return (result if isinstance(result, list) else []), {}


async def list_docs(args: ListDocsInput) -> list[TextContent]:
    """프로젝트 문서 목록 조회 (tree 또는 tag 필터). 더 있으면(has_more) 다음 페이지 안내가
    별도 텍스트 블록으로 붙는다."""
    try:
        params: dict = {"project_id": client.require_project_id()}
        if args.tags:
            params["tags"] = ",".join(args.tags)
        else:
            params["view"] = "tree"
        if args.cursor:
            params["cursor"] = args.cursor
        result = await client.get("/api/v2/docs", params=params)
        items, meta = _unwrap_docs_page(result)
        blocks = ok(items)
        if meta.get("has_more"):
            blocks.append(TextContent(
                type="text",
                text=(
                    f"※ 더 있음 — 이 응답은 {len(items)}건까지만 포함(전량 아님). "
                    f'다음 페이지: list_docs를 cursor="{meta.get("next_cursor")}"로 다시 호출.'
                ),
            ))
        return blocks
    except Exception as exc:
        return err(str(exc))


async def get_doc(args: GetDocInput) -> list[TextContent]:
    """slug 또는 doc_id로 문서 단건 조회 — 본문(content) 포함.

    8a8e881a: list 엔드포인트(/api/v2/docs?slug=)는 DocSummary(메타·snippet만·content 미포함)를
    반환해 에이전트가 서로의 doc 본문을 못 읽었다. slug→id 해소 후 GET /{id}(DocResponse·content
    보유)를 surface한다. 메타데이터(id·title·slug·tags·updated_at)는 DocResponse에 그대로 있어
    기존 소비자 무영향(content 필드만 추가).

    story #2191: slug 조회 자체는 BE에서도 항상 {data,meta} 봉투로 오므로(단건이라도) 여기서
    같은 방식으로 언랩한다 — 안 하면 summaries[0]이 dict를 정수 인덱싱하려다 터진다.

    story #3324: `doc_id`가 오면 slug 해소 단계(list+필터) 자체를 건너뛰고 `GET /{id}`로
    직행한다 — 이벤트 payload·참조 토큰이 주는 id를 그대로 열 수 있게. `doc_id`가 없으면
    (기존 계약대로) slug로 해소.
    """
    try:
        if args.doc_id:
            return ok(await client.get(f"/api/v2/docs/{args.doc_id}"))
        result = await client.get(
            "/api/v2/docs", params={"project_id": client.require_project_id(), "slug": args.slug}
        )
        summaries, _meta = _unwrap_docs_page(result)
        if not summaries:
            return err(f"Doc not found: {args.slug}")
        doc_id = summaries[0]["id"]
        return ok(await client.get(f"/api/v2/docs/{doc_id}"))
    except Exception as exc:
        return err(str(exc))


async def search_docs(args: SearchDocsInput) -> list[TextContent]:
    """문서 제목/본문 검색 (tag 필터 선택).

    story #2191: 이 경로(q+project_id)는 BE에서 관련도(ts_rank)순이라 커서 페이지네이션을
    의도적으로 지원 안 함(has_more는 항상 false) — 언랩만 하고 다음 페이지 안내는 안 붙인다.
    """
    try:
        params: dict = {"project_id": client.require_project_id(), "q": args.query}
        if args.tags:
            params["tags"] = ",".join(args.tags)
        if args.limit:
            params["limit"] = args.limit
        result = await client.get("/api/v2/docs", params=params)
        items, _meta = _unwrap_docs_page(result)
        # has_more는 이 분기에서 BE가 항상 False로 고정해 보낸다(위 docstring) — 그래도 결과가
        # BE 상한(min(limit,50))에 딱 걸쳤을 수 있어 그 사실만 안내(다음 페이지 제안 아님,
        # cursor 자체가 없어 "더 좁혀 재검색"만 유효한 다음 수).
        blocks = ok(items)
        if args.limit and len(items) >= min(args.limit, 50):
            blocks.append(TextContent(
                type="text",
                text=(
                    f"※ 결과가 상한({min(args.limit, 50)}건)에 걸쳤을 수 있음 — 이 도구는 cursor를 "
                    f"지원 안 함(관련도순 정렬이라 페이지 이어달리기 불가). query를 좁혀 재검색할 것."
                ),
            ))
        return blocks
    except Exception as exc:
        return err(str(exc))


async def create_doc(args: CreateDocInput) -> list[TextContent]:
    """문서 생성."""
    try:
        body: dict = {"title": args.title, "slug": args.slug, "project_id": client.require_project_id()}
        for field in ("content", "content_format", "parent_id", "icon"):
            val = getattr(args, field)
            if val is not None:
                body[field] = val
        if args.is_folder is not None:
            body["is_folder"] = args.is_folder
        if args.tags is not None:
            body["tags"] = args.tags
        result = await client.post("/api/v2/docs", json=body)
        _attach_submit_for_approval_next_action(result)
        return ok(result)
    except Exception as exc:
        return err(str(exc))


def _attach_submit_for_approval_next_action(doc: object) -> None:
    """story #2668(B3) — next_action_code(`decision_pending`)는 사람이 읽는 문구고, 그걸 보고
    "그래서 무슨 도구를 부르지"로 이어지는 경로가 없었다(REST `POST /{id}/transition`을
    알아야만 상신 가능 — MCP 도구 목록엔 없어 발견 자체가 안 됐다, 오늘 PO 재발 2회의 구조
    원인). draft 문서 응답에 `next_action`을 `{tool, args}` 실행 가능 명세로 동봉한다 —
    BE의 next_action_code SSOT(app.services.next_action, 다중 소비자·PO 판정 이력 다수)는
    건드리지 않는다(이 스토리 범위는 MCP 표면 하나). status가 draft가 아니면(이미 상신됐거나
    다른 상태) 아무것도 안 붙인다 — 없는 행동을 지어내지 않는다.

    story #2680 — `tool` 필드만으론 이 광고가 무효할 수 있다: sprintable_submit_for_approval
    자체가 이 문서를 만든 그 `create_doc`/`update_doc`보다 «나중에» 추가된 도구라(B3),
    이 서버가 tools/list_changed를 못 보내는 구조(SprintableFastMCP는
    stateless_http=True — mcp SDK streamable_http_manager가 stateless 모드에서 요청마다
    완전히 새 transport를 만들고 세션 트래킹 자체를 안 한다, 실측 확認: 서버가 밀어줄
    «연결된 세션» 개념이 원리적으로 없다) 오래 연결된 세션은 이 tool을 영원히 못 본다 —
    광고는 보여도 이행이 막힌다. `fallback_rest`를 같이 동봉해, 그 도구가 없는 세션도
    (curl/HTTP 실행 능력만 있으면) REST를 직접 쳐 완주할 수 있게 한다 — 이 필드는 신규
    도구 등록에 의존하지 않는다(create_doc/update_doc 자체는 이미 모든 세션에 있는
    기존 도구이므로 이 응답 보강은 세션 나이와 무관하게 항상 도달)."""
    if isinstance(doc, dict) and doc.get("status") == "draft" and doc.get("id"):
        doc_id = doc["id"]
        doc["next_action"] = {
            "tool": "sprintable_submit_for_approval",
            "args": {"doc_id": doc_id},
            "fallback_rest": {
                "method": "POST",
                "url": f"{client._base_url}/api/v2/docs/{doc_id}/transition",
                "headers": {"Authorization": "Bearer <YOUR_SPRINTABLE_API_KEY>"},
                # story #3004(선생님 정책 확定 2026-08-24) — approver_member_id가 서버 필수(400
                # APPROVER_REQUIRED)가 됐다. 이 광고 시점엔 대상을 알 수 없어(create_doc/
                # update_doc 응답에 없음) 기존 관례(Authorization 헤더와 동형) 그대로 각괄호
                # placeholder로 명시 — 지어낸 값 대신 "채워 넣어야 하는 자리"임을 정직하게 드러낸다.
                "body": {"status": "pending", "approver_member_id": "<APPROVER_MEMBER_ID>"},
                "note": (
                    "sprintable_submit_for_approval 도구가 이 세션에 안 보이면(구 세션 —"
                    " 이 도구가 등록된 뒤 재연결 안 한 경우) 이 REST 호출을 직접 실행해도"
                    " 동일하게 상신된다. approver_member_id는 결재자로 지정할 org member_id"
                    "(owner/admin)로 채워야 한다 — 미지정/본인 지정은 서버가 거부한다."
                ),
            },
        }


async def update_doc(args: UpdateDocInput) -> list[TextContent]:
    """문서 수정."""
    updates: dict = {}
    for field in (
        "title", "content", "content_format", "icon", "parent_id", "expected_updated_at",
        "slug", "slug_locked", "sort_order", "doc_type", "assignee_id",
    ):
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
        result = await client.patch(f"/api/v2/docs/{args.doc_id}", json=updates)
        _attach_submit_for_approval_next_action(result)
        return ok(result)
    except Exception as exc:
        return err(str(exc))


class SubmitForApprovalInput(SprintableInput):
    doc_id: str
    # story #2985(PO 설계 확定 2026-08-24)에서 신설(선택), story #3004(선생님 정책 확定
    # 2026-08-24)부터 **필수**(org member_id) — "받는 사람이 없는 결재는 존재할 수 없다".
    # 서버(transition_doc)가 최종 자격 검증(owner/admin·not-self)을 하지만, 이 필드를 Pydantic
    # required로 걸어 두면 호출 즉시(왕복 前) 명확한 에러를 받는다.
    approver_member_id: str


async def submit_for_approval(args: SubmitForApprovalInput) -> list[TextContent]:
    """문서를 결재 상신(draft→pending) — `POST /{id}/transition`의 MCP 래퍼.

    story #2668(B3): 응답에 doc(status=pending)뿐 아니라 그 상신이 실제로 만든 pending 게이트
    (실물)를 동봉한다 — "호출은 200인데 게이트가 진짜 생겼는지"를 에이전트가 별도 조회 없이
    이 한 번의 호출로 확認할 수 있게(AC1: MCP만으로 create_doc→submit_for_approval→pending
    게이트 실물까지 왕복).
    """
    try:
        body: dict[str, object] = {"status": "pending", "approver_member_id": args.approver_member_id}
        doc = await client.post(f"/api/v2/docs/{args.doc_id}/transition", json=body)
        gates = await client.get(
            "/api/v2/gates", params={"work_item_id": args.doc_id, "work_item_type": "doc", "status": "pending"},
        )
        gate = gates[0] if isinstance(gates, list) and gates else None
        return ok({"doc": doc, "gate": gate})
    except Exception as exc:
        return err(str(exc))
