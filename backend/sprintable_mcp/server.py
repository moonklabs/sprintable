from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

from .config import settings
from .response import ok
from .tools.epics import (
    AddEpicInput, DeleteEpicInput, ListEpicsInput, UpdateEpicInput,
    add_epic, delete_epic, list_epics, update_epic,
)
from .tools.stories import (
    AddStoryInput, AssignStoryToSprintInput, DeleteStoryInput,
    ListStoriesInput, UnassignStoryFromSprintInput, UpdateStoryInput,
    UpdateStoryStatusInput,
    add_story, assign_story_to_sprint, delete_story,
    list_backlog, list_stories, unassign_story_from_sprint,
    update_story, update_story_status,
)
from .tools.tasks import (
    AddTaskInput, DeleteTaskInput, GetTaskInput, ListMyTasksInput,
    ListTasksInput, UpdateTaskInput, UpdateTaskStatusInput,
    add_task, delete_task, get_task, list_my_tasks, list_tasks,
    update_task, update_task_status,
)
from .schemas import SprintableInput
from .tools.docs import (
    CreateDocInput, DeleteDocInput, GetDocInput, ListDocsInput,
    SearchDocsInput, UpdateDocInput,
    create_doc, delete_doc, get_doc, list_docs, search_docs, update_doc,
)
from .tools.sprints import (
    CreateSprintInput, ListSprintsInput, SprintIdInput, UpdateSprintInput,
    activate_sprint, close_sprint, create_sprint, delete_sprint,
    get_velocity, list_sprints, sprint_summary, update_sprint,
)

mcp = FastMCP(
    name="sprintable-mcp-python",
    instructions=(
        "Sprintable Python MCP server. "
        f"Backend: {settings.sprintable_api_url}"
    ),
)


@mcp.tool()
def ping() -> list[TextContent]:
    """서버 생존 확인용 smoke tool."""
    return ok({"status": "pong"})


# ── Stories (8개) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_stories(args: ListStoriesInput) -> list[TextContent]:
    """프로젝트 스토리 목록 조회. project_id/org_id context 자동 주입."""
    return await list_stories(args)


@mcp.tool()
async def sprintable_list_backlog(args: SprintableInput) -> list[TextContent]:
    """백로그 스토리 목록 (스프린트 미배정)."""
    return await list_backlog(args)


@mcp.tool()
async def sprintable_add_story(args: AddStoryInput) -> list[TextContent]:
    """스토리 생성."""
    return await add_story(args)


@mcp.tool()
async def sprintable_update_story(args: UpdateStoryInput) -> list[TextContent]:
    """스토리 수정."""
    return await update_story(args)


@mcp.tool()
async def sprintable_delete_story(args: DeleteStoryInput) -> list[TextContent]:
    """스토리 삭제."""
    return await delete_story(args)


@mcp.tool()
async def sprintable_assign_story_to_sprint(args: AssignStoryToSprintInput) -> list[TextContent]:
    """스토리를 스프린트에 배정."""
    return await assign_story_to_sprint(args)


@mcp.tool()
async def sprintable_unassign_story_from_sprint(args: UnassignStoryFromSprintInput) -> list[TextContent]:
    """스토리를 스프린트에서 제거."""
    return await unassign_story_from_sprint(args)


@mcp.tool()
async def sprintable_update_story_status(args: UpdateStoryStatusInput) -> list[TextContent]:
    """스토리 상태 변경."""
    return await update_story_status(args)


# ── Tasks (7개) ────────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_tasks(args: ListTasksInput) -> list[TextContent]:
    """태스크 목록 조회."""
    return await list_tasks(args)


@mcp.tool()
async def sprintable_list_my_tasks(args: ListMyTasksInput) -> list[TextContent]:
    """내 태스크 목록 조회."""
    return await list_my_tasks(args)


@mcp.tool()
async def sprintable_get_task(args: GetTaskInput) -> list[TextContent]:
    """태스크 단건 조회."""
    return await get_task(args)


@mcp.tool()
async def sprintable_add_task(args: AddTaskInput) -> list[TextContent]:
    """태스크 생성."""
    return await add_task(args)


@mcp.tool()
async def sprintable_update_task(args: UpdateTaskInput) -> list[TextContent]:
    """태스크 수정."""
    return await update_task(args)


@mcp.tool()
async def sprintable_update_task_status(args: UpdateTaskStatusInput) -> list[TextContent]:
    """태스크 상태 변경."""
    return await update_task_status(args)


@mcp.tool()
async def sprintable_delete_task(args: DeleteTaskInput) -> list[TextContent]:
    """태스크 삭제."""
    return await delete_task(args)


# ── Epics (4개) ────────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_epics(args: ListEpicsInput) -> list[TextContent]:
    """에픽 목록 조회."""
    return await list_epics(args)


@mcp.tool()
async def sprintable_add_epic(args: AddEpicInput) -> list[TextContent]:
    """에픽 생성."""
    return await add_epic(args)


@mcp.tool()
async def sprintable_update_epic(args: UpdateEpicInput) -> list[TextContent]:
    """에픽 수정."""
    return await update_epic(args)


@mcp.tool()
async def sprintable_delete_epic(args: DeleteEpicInput) -> list[TextContent]:
    """에픽 삭제."""
    return await delete_epic(args)


# ── Sprints (8개) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_sprints(args: ListSprintsInput) -> list[TextContent]:
    """스프린트 목록 조회."""
    return await list_sprints(args)


@mcp.tool()
async def sprintable_sprint_summary(args: SprintIdInput) -> list[TextContent]:
    """스프린트 스토리 상태별 요약."""
    return await sprint_summary(args)


@mcp.tool()
async def sprintable_activate_sprint(args: SprintIdInput) -> list[TextContent]:
    """스프린트 활성화 (planning → active)."""
    return await activate_sprint(args)


@mcp.tool()
async def sprintable_close_sprint(args: SprintIdInput) -> list[TextContent]:
    """스프린트 종료 (active → closed)."""
    return await close_sprint(args)


@mcp.tool()
async def sprintable_get_velocity(args: SprintIdInput) -> list[TextContent]:
    """스프린트 벨로시티 조회."""
    return await get_velocity(args)


@mcp.tool()
async def sprintable_create_sprint(args: CreateSprintInput) -> list[TextContent]:
    """스프린트 생성."""
    return await create_sprint(args)


@mcp.tool()
async def sprintable_update_sprint(args: UpdateSprintInput) -> list[TextContent]:
    """스프린트 수정."""
    return await update_sprint(args)


@mcp.tool()
async def sprintable_delete_sprint(args: SprintIdInput) -> list[TextContent]:
    """스프린트 삭제."""
    return await delete_sprint(args)


# ── Docs (6개) ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_docs(args: ListDocsInput) -> list[TextContent]:
    """문서 목록 조회 (tree 또는 tag 필터)."""
    return await list_docs(args)


@mcp.tool()
async def sprintable_get_doc(args: GetDocInput) -> list[TextContent]:
    """slug로 문서 단건 조회."""
    return await get_doc(args)


@mcp.tool()
async def sprintable_search_docs(args: SearchDocsInput) -> list[TextContent]:
    """문서 제목/본문 검색."""
    return await search_docs(args)


@mcp.tool()
async def sprintable_create_doc(args: CreateDocInput) -> list[TextContent]:
    """문서 생성."""
    return await create_doc(args)


@mcp.tool()
async def sprintable_update_doc(args: UpdateDocInput) -> list[TextContent]:
    """문서 수정."""
    return await update_doc(args)


@mcp.tool()
async def sprintable_delete_doc(args: DeleteDocInput) -> list[TextContent]:
    """문서 소프트 삭제."""
    return await delete_doc(args)
