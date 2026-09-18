"""스토리 관련 MCP 도구 (7개). E-SECURITY SEC-S1: delete_story는 의도적으로 제거됨 — 에이전트
hard-delete는 사람 승인 없는 물리삭제라 차단(DELETE 엔드포인트 자체는 유지, 휴먼 전용으로 승격).
삭제가 필요한 워크플로우는 상태변경/archive로 대체."""
from __future__ import annotations

from mcp.types import CallToolResult, TextContent

from ..api_client import client
from ..response import err, ok, ok_paginated
from ..schemas import SprintableInput, StoryPoints, StoryPriority, StoryStatus
from .attachments import upload_attachments


def _has_more_from_headers(headers, items: list) -> tuple[bool, str | None]:
    """story #2428 — stories.py 계열은 X-Total-Count/X-Next-Cursor **헤더**로 페이지네이션을
    신호한다(docs.py/notifications.py의 body meta{has_more} 규약과 wire shape가 다름). BE가
    X-Next-Cursor를 «항상»(결과가 있으면) 싣기 때문에(app/routers/goals.py·stories.py — 실제
    다음 페이지 유무와 무관하게 `if items:`만 조건) 그 헤더의 존재 자체는 has_more 신호가
    아니다 — X-Total-Count와 이번 응답 건수를 비교해야 진짜 «더 있음»을 안다."""
    total_raw = headers.get("x-total-count")
    next_cursor = headers.get("x-next-cursor")
    if total_raw is None:
        return False, next_cursor
    try:
        total = int(total_raw)
    except (TypeError, ValueError):
        return False, next_cursor
    return total > len(items), next_cursor


class ListStoriesInput(SprintableInput):
    sprint_id: str | None = None
    epic_id: str | None = None
    status: StoryStatus | None = None
    priority: StoryPriority | None = None
    assignee_id: str | None = None
    limit: int | None = None
    cursor: str | None = None  # 이전 호출의 X-Next-Cursor 헤더 값을 그대로 넘기면 다음 페이지.


class ListBacklogInput(SprintableInput):
    limit: int | None = None
    # story #2428: cursor 없음 — 이 분기(list_backlog)는 cursor pagination 자체를 지원 안 한다
    # (app/repositories/story.py list_backlog() docstring — #2489/board 분기와 갈라진 지점).
    # 더 필요하면 limit을 올려 재호출하는 것이 유일한 다음 페이지 수단.


class AddStoryInput(SprintableInput):
    title: str
    epic_id: str | None = None
    sprint_id: str | None = None
    assignee_id: str | None = None
    priority: StoryPriority | None = None
    story_points: StoryPoints | None = None
    description: str | None = None
    acceptance_criteria: str | None = None
    # P0-05 후속(doc scope-violation-signal-design §1 확定): 선언 주체 제한 없음 — 에이전트
    # 자기신고 착수시점 파일-경로 글롭 선언(예: ["backend/app/routers/stories.py", "backend/tests/**"]).
    declared_scope_paths: list[str] | None = None
    # story #2267(C-9)·#2222(「낳음」 자동 부착): 이 스토리가 무엇에서 만들어졌는지(출처).
    # ⭐호출하는 에이전트가 지금 다른 story/doc/chat_message 맥락 안에서 이 스토리를 만드는
    # 것이라면(예: 어떤 스토리를 쪼개 후속 작업을 만들 때, 대화 중 나온 할 일을 스토리로
    # 옮길 때) origin_type("story"|"doc"|"chat_message" 등)·origin_id를 **함께 채워 보낸다**
    # — 이게 이 제품에서 「낳음」 연결이 손 안 대고 쌓이는 유일한 자동 경로다(#2222). 안
    # 채우면 그 연결은 영영 안 남는다(사후 소급 없음) — 맥락을 아는 그 순간이 유일한 기회.
    # 둘 다 지정해야 유효(하나만 있으면 서버가 무시 — app/schemas/story.py StoryCreate와 동형).
    # origin_type 은 reference_registry의 등록된 타입만 허용(story/doc/epic/task/sprint/
    # artifact/hypothesis/evidence/chat_message) — 잘못된 값이어도 story 생성 자체는 성공하고
    # (#2222 AC5), 출처 연결만 조용히 안 남는다.
    origin_type: str | None = None
    origin_id: str | None = None


class UpdateStoryInput(SprintableInput):
    story_id: str
    title: str | None = None
    priority: StoryPriority | None = None
    story_points: StoryPoints | None = None
    description: str | None = None
    acceptance_criteria: str | None = None
    assignee_id: str | None = None
    # story #2389 — 백엔드 StoryUpdate/repo에 이미 있던 복수 배정 필드가 이 스키마에 없어 조용히
    # 버려졌다(200 OK·assignee_ids: [] 응답·updated_at 불변). extra="ignore"(SprintableInput)가
    # 미선언 필드를 검증 단계에서 그냥 삼켜, args에 속성 자체가 안 생겼다 — "읽었는데 무시"가
    # 아니라 "받을 방법이 없었다".
    assignee_ids: list[str] | None = None
    epic_id: str | None = None
    # P0-05 후속: 도중 재선언/축소/해제(빈 배열)도 가능 — story.declared_scope_changed 감사 이벤트로 기록.
    declared_scope_paths: list[str] | None = None
    # [{content_base64, name, content_type}, ...] — 스샷/작은 문서(최대 5개·파일당 2MiB·총 6MiB).
    # 기존 첨부에 **추가**된다(PATCH attachments 는 서버측 full-replace 라 update_story 가 먼저 기존
    # 첨부를 읽어 병합 — 새 첨부가 기존 걸 지우지 않는다).
    attachments: list[dict] | None = None
    # story #2389 후속(민군 QA — 전수가 반쪽이었다는 지적) — StoryUpdate엔 이 스키마에 없는 필드가
    # 여덟 더 있었다. 아래 넷은 「넣어야 한다」로 판단(각자 이유 붙임), 나머지 셋(position·
    # is_excluded·meeting_id)은 「지금은 안 넣는다」로 판단(아래 update_story() 근처 주석 참조).
    # human_owner_member_id — assignee 축의 짝(누가 배정됐나 vs 누가 최종 책임자인가, P0-03
    # trust-pipeline-be-design §5). assignee_id/assignee_ids를 고치면서 이 짝만 빼면 절반짜리
    # "담당자" 개념이 된다 — 같이 넣는다.
    human_owner_member_id: str | None = None
    # E-OUTCOME-LOOP 셋 — StoryUpdate에 goals와 «똑같은» 주석("의도 필드")이 달려 있다. goals
    # 쪽(update_goal)은 #2389에서 이미 고쳤는데 story만 안 고치면, 같은 이름의 필드가 한쪽
    # 엔티티에서만 도구로 도달 가능해져 "다른 쪽도 되겠지"라는 오판을 유발한다(비대칭이 대칭보다
    # 더 헷갈린다). ⚠️다만 goals의 update_goal은 _resolve_outcome_status()로 이 세 필드가 바뀌면
    # outcome_status를 자동전이시키는데(app/routers/goals.py:112,344), story 쪽 라우터에는 그
    # 동형 함수 자체가 없다(grep 확認, 0건) — story는 필드가 «저장은 되지만» 어떤 자동전이도
    # 트리거하지 않는다. "값을 못 보낸다"에서 "값은 보내지는데 아무 일도 안 난다"로 바뀌는
    # 것이지, story에 goals와 동일한 채점 파이프라인이 생기는 것은 아니다.
    success_hypothesis: str | None = None
    metric_definition: dict | None = None
    measure_after: str | None = None
    # story #2389 재정정 — 이전 판이 이 필드를 "찾지 못함"으로 남겼는데, 원인은 제 grep이 이
    # 저장소가 아니라 무관한 stale 체크아웃(다른 로컬 브랜치)을 봤기 때문이었다(제 실수, PO가
    # 직접 찾아 정정). `allow_shrink`는 데이터 필드가 아니라 «조작 승인 플래그»다(story #2346
    # AC7) — description/acceptance_criteria 등 긴 텍스트 필드가 50%↑·최소 글자수↑로 급감하면
    # app/routers/stories.py가 400으로 거부한다(실사고 3건, 전부 -80%대, 이 게이트가 다 막았을
    # 자리). 이 필드가 없으면 «의도적으로» 줄이려는 정당한 요청도 되돌릴 방법이 없어 도구가
    # 그 상황에서 막다른 골목이 된다 — 단순 누락이 아니라 실제 워크플로우 차단이었다.
    allow_shrink: bool | None = None
    # story #2254(그라운딩 doc e5bc0789, 2026-08-25) — 한 절을 덧붙이려고 description/
    # acceptance_criteria 전문을 다시 보내다 기존 내용을 통째로 지운 실사고(디디 자진 보고,
    # 2026-07-28)의 근본 처방. description_append/acceptance_criteria_append를 쓰면 서버가
    # 「기존값+개행 2줄+이 값」을 원자적으로 이어붙인다(호출자가 현재값을 먼저 읽어올 필요
    # 없음 — read-modify-write 경합 자체가 사라진다). plain description/acceptance_criteria와
    # 동시 지정하면 BE가 422로 거부(호출 의도가 모호함 — 조용히 아무거나 고르지 않는다).
    description_append: str | None = None
    acceptance_criteria_append: str | None = None
    # 직전 값(응답의 previous_description/previous_acceptance_criteria)으로 되돌린다(현재값과
    # swap — 되돌리기 자체도 다시 되돌릴 수 있다). 되돌릴 직전 값이 없으면 BE가 422.
    restore_description: bool | None = None
    restore_acceptance_criteria: bool | None = None


class AssignStoryToSprintInput(SprintableInput):
    story_id: str
    sprint_id: str


class UnassignStoryFromSprintInput(SprintableInput):
    story_id: str


class UpdateStoryStatusInput(SprintableInput):
    story_id: str
    status: StoryStatus


async def list_stories(args: ListStoriesInput) -> list[TextContent]:
    """프로젝트 스토리 목록 조회."""
    try:
        params: dict = {"project_id": client.require_project_id()}
        if client.org_id:
            params["org_id"] = client.org_id
        if args.sprint_id:
            params["sprint_id"] = args.sprint_id
        if args.epic_id:
            params["epic_id"] = args.epic_id
        if args.status:
            params["status"] = args.status.value
        if args.priority:
            params["priority"] = args.priority.value
        if args.assignee_id:
            params["assignee_id"] = args.assignee_id
        if args.limit:
            params["limit"] = args.limit
        if args.cursor:
            params["cursor"] = args.cursor
        items, headers = await client.get_with_headers("/api/v2/stories", params=params)
        has_more, next_cursor = _has_more_from_headers(headers, items)
        return ok_paginated(items, has_more=has_more, next_cursor=next_cursor, tool_name="sprintable_list_stories")
    except Exception as exc:
        return err(str(exc))


async def list_backlog(args: ListBacklogInput) -> list[TextContent]:
    """백로그 스토리 목록 (스프린트 미배정 · done/in-review 제외)."""
    # b5870c4c: 전용 `/stories/backlog` 라우트 부재 → `/{id}` 로 shadow 돼 422(id="backlog" 非-UUID).
    # 기존 list 엔드포인트 + `no_sprint` 필터(server-side repo.list_backlog·sprint 미배정·docstring 정합) 재사용.
    # ⚠️ no_sprint 는 project_id 와 함께여야 backlog 분기 동작(stories.py list_stories).
    # story #3148 — sprint 미배정만으론 done/in-review도 섞인다(PO가 이 도구로 오배분한
    # 실사고 원인). exclude_status는 이 도구가 항상 고정으로 보낸다 — 이름이 「백로그」인
    # 도구가 완료·검토중 항목을 내는 건 이름의 약속 위반이라 옵션이 아니라 기본 동작이다.
    try:
        params: dict = {
            "project_id": client.require_project_id(), "no_sprint": "true",
            "exclude_status": "done,in-review",
        }
        if args.limit:
            params["limit"] = args.limit
        items, headers = await client.get_with_headers("/api/v2/stories", params=params)
        # story #2428: 이 분기는 X-Next-Cursor를 안 싣는다(cursor 미지원 — ListBacklogInput 주석
        # 참조) — ok_paginated의 cursor 문구는 여기서 오해를 부르므로 쓰지 않고 limit 재호출을
        # 직접 안내한다.
        has_more, _ = _has_more_from_headers(headers, items)
        blocks = ok(items)
        if has_more:
            blocks.append(TextContent(
                type="text",
                text=(
                    f"※ 더 있음 — 이 응답은 {len(items)}건까지만 포함(전량 아님). "
                    f"이 도구는 cursor를 지원 안 함 — limit을 올려 sprintable_list_backlog를 다시 호출."
                ),
            ))
        return blocks
    except Exception as exc:
        return err(str(exc))


async def add_story(args: AddStoryInput) -> list[TextContent]:
    """스토리 생성."""
    try:
        body: dict = {"title": args.title, "project_id": client.require_project_id()}
        if args.epic_id:
            body["epic_id"] = args.epic_id
        if args.sprint_id:
            body["sprint_id"] = args.sprint_id
        if args.assignee_id:
            body["assignee_id"] = args.assignee_id
        if args.priority:
            body["priority"] = args.priority.value
        if args.story_points:
            body["story_points"] = args.story_points.value
        if args.description:
            body["description"] = args.description
        if args.acceptance_criteria:
            body["acceptance_criteria"] = args.acceptance_criteria
        if args.declared_scope_paths is not None:
            body["declared_scope_paths"] = args.declared_scope_paths
        if args.origin_type and args.origin_id:
            body["origin_type"] = args.origin_type
            body["origin_id"] = args.origin_id
        result = await client.post("/api/v2/stories", json=body)
        # story 8b7e52d6(PO 재정의, 2026-09-04) — assignee_id를 생략하고 만든 스토리는
        # claim_story를 몇 번 호출해도 assignee가 채워지지 않는다(claim_story는
        # participation만 건드림, story 3414b6d7 결정) — 보드 배정·통지 수신자가 영구히
        # 비는 상태로 남을 수 있다는 걸 생성 시점에 바로 알린다(사후 수동 개입 필요했던
        # 실사례: story 0845cb03).
        if not args.assignee_id and isinstance(result, dict):
            result = {
                **result,
                "warning": (
                    "assignee 없음 → 통지 수신자 0. claim_story는 assignee를 채우지 "
                    "않습니다 — 필요하면 update_story의 assignee_id/assignee_ids로 "
                    "직접 배정하세요."
                ),
            }
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def update_story(args: UpdateStoryInput) -> list[TextContent]:
    """스토리 수정.

    ⭐한 절만 덧붙일 땐 description/acceptance_criteria에 전문을 다시 쓰지 말 것 —
    description_append/acceptance_criteria_append를 쓰면 서버가 원자적으로 이어붙인다
    (읽어와서 합쳐 재전송하다 실수로 기존 내용을 지우는 사고를 원천 차단, story #2254).
    직전 값으로 되돌리려면 restore_description/restore_acceptance_criteria=true.

    story #2389 후속 — StoryUpdate에 있지만 이 도구에 «의도적으로 안 넣은» 셋:
      - position: 보드 드래그앤드롭 순서(정수, 이웃 상대적 계산 전제) — 자연어로 지시된 절대
        정수값을 그대로 넣으면 다른 카드들과의 순서가 어긋나기 쉽다. UI 드래그 전용으로 남긴다.
      - is_excluded: 코드 주석 자체가 "PO 직접 플래그, 자동 대량 마킹 금지"(E-CAGE-REFEREE P1)
        라고 명시한 오염 마킹 — 이 코멘트가 이미 "도구로 자동화하지 말라"는 뜻이라 그대로 존중.
      - meeting_id: 이 스토리를 낳은 회의 링크(출처 성격) — 보통 생성 시점에 붙거나 회의 쪽
        플로우에서 연결되는 값이라, update_story로 임의 재연결하게 열면 실수로 무관한 회의에
        스토리가 붙는 사고를 만들 수 있다. 필요해지면 전용 도구로 별도 검토.
    """
    updates: dict = {}
    if args.title is not None:
        updates["title"] = args.title
    if args.priority is not None:
        updates["priority"] = args.priority.value
    if args.story_points is not None:
        updates["story_points"] = args.story_points.value
    if args.description is not None:
        updates["description"] = args.description
    if args.acceptance_criteria is not None:
        updates["acceptance_criteria"] = args.acceptance_criteria
    if args.assignee_id is not None:
        updates["assignee_id"] = args.assignee_id
    if args.assignee_ids is not None:
        updates["assignee_ids"] = args.assignee_ids
    if args.human_owner_member_id is not None:
        updates["human_owner_member_id"] = args.human_owner_member_id
    if args.success_hypothesis is not None:
        updates["success_hypothesis"] = args.success_hypothesis
    if args.metric_definition is not None:
        updates["metric_definition"] = args.metric_definition
    if args.measure_after is not None:
        updates["measure_after"] = args.measure_after
    if args.allow_shrink is not None:
        updates["allow_shrink"] = args.allow_shrink
    if args.description_append is not None:
        updates["description_append"] = args.description_append
    if args.acceptance_criteria_append is not None:
        updates["acceptance_criteria_append"] = args.acceptance_criteria_append
    if args.restore_description is not None:
        updates["restore_description"] = args.restore_description
    if args.restore_acceptance_criteria is not None:
        updates["restore_acceptance_criteria"] = args.restore_acceptance_criteria
    if args.epic_id is not None:
        updates["epic_id"] = args.epic_id
    if args.declared_scope_paths is not None:
        updates["declared_scope_paths"] = args.declared_scope_paths
    try:
        if args.attachments:
            uploaded = await upload_attachments(
                f"/api/v2/stories/{args.story_id}/attachments", args.attachments,
            )
            if uploaded:
                # PATCH attachments 는 서버측 full-replace(교체 SSOT 재동기화) — 기존 첨부를 먼저
                # 읽어 병합해야 새 첨부가 기존 걸 지우지 않는다.
                current = await client.get(f"/api/v2/stories/{args.story_id}")
                existing = current.get("attachments") or [] if isinstance(current, dict) else []
                updates["attachments"] = existing + uploaded
        return ok(await client.patch(f"/api/v2/stories/{args.story_id}", json=updates))
    except Exception as exc:
        return err(str(exc))


async def assign_story_to_sprint(args: AssignStoryToSprintInput) -> list[TextContent]:
    """스토리를 스프린트에 배정."""
    try:
        return ok(await client.patch(f"/api/v2/stories/{args.story_id}", json={"sprint_id": args.sprint_id}))
    except Exception as exc:
        return err(str(exc))


async def unassign_story_from_sprint(args: UnassignStoryFromSprintInput) -> list[TextContent]:
    """스토리를 스프린트에서 제거."""
    try:
        return ok(await client.patch(f"/api/v2/stories/{args.story_id}", json={"sprint_id": None}))
    except Exception as exc:
        return err(str(exc))


async def update_story_status(args: UpdateStoryStatusInput) -> list[TextContent] | CallToolResult:
    """스토리 상태 변경."""
    try:
        return ok(await client.patch(f"/api/v2/stories/{args.story_id}/status", json={"status": args.status.value}))
    except Exception as exc:
        return err(str(exc))
