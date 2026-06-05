/**
 * E-MCP-RIGHT S1 (2da32fbf) — toolset 카탈로그 계약 (picker 데이터 SSOT).
 *
 * picker는 선택지(전체 그룹 + 그룹별 멤버 툴 + core/destructive 플래그)를 이 계약으로 받는다.
 * SSOT = BE `GET /api/v2/mcp/toolset-catalog` (디디 BE / S2 연장). FE 하드코딩 금지.
 *
 * BE 엔드포인트 준비 전까지는 골격 렌더용 임시 상수(TEMP_TOOLSET_CATALOG)로 폴백한다.
 * 그룹키·core/destructive 플래그는 `backend/app/services/mcp_toolset.py`(SSOT)와 정합하며,
 * 도구명은 예시다 — 실제 멤버 툴/도구 수는 카탈로그 응답이 권위를 가진다.
 */

export interface ToolsetGroup {
  /** enforcement에 들어가는 그룹키 (불변·`api-key.scope`에 저장). */
  key: string;
  /** 그룹 소속 MCP 툴명 (표시·도구 수 배지용·읽기전용). */
  tools: string[];
  /** core = 항상 허용(체크 불가). */
  is_core: boolean;
  /** destructive = 위험 작업(opt-in·admin/destructive scope 필요). */
  is_destructive: boolean;
}

export interface ToolsetCatalog {
  groups: ToolsetGroup[];
}

/**
 * 임시 폴백 카탈로그 — BE `/api/v2/mcp/toolset-catalog` 준비 전 골격 렌더용.
 * mcp_toolset.py 그룹 체계와 정합(비파괴 15 + core + admin=destructive). 도구명은 대표 예시.
 * TODO(2da32fbf): BE 카탈로그 엔드포인트 라이브 시 fetchToolsetCatalog가 실데이터로 대체.
 */
export const TEMP_TOOLSET_CATALOG: ToolsetCatalog = {
  groups: [
    { key: 'core', is_core: true, is_destructive: false, tools: ['sprintable_ping', 'sprintable_my_dashboard', 'sprintable_check_notifications'] },
    { key: 'stories', is_core: false, is_destructive: false, tools: ['sprintable_add_story', 'sprintable_list_stories', 'sprintable_update_story_status', 'sprintable_claim_story', 'sprintable_search_stories'] },
    { key: 'tasks', is_core: false, is_destructive: false, tools: ['sprintable_add_task', 'sprintable_list_tasks', 'sprintable_update_task_status', 'sprintable_get_task'] },
    { key: 'sprints', is_core: false, is_destructive: false, tools: ['sprintable_list_sprints', 'sprintable_assign_story_to_sprint', 'sprintable_checkin_sprint', 'sprintable_sprint_summary'] },
    { key: 'epics', is_core: false, is_destructive: false, tools: ['sprintable_add_epic', 'sprintable_list_epics', 'sprintable_update_epic', 'sprintable_get_epic_progress'] },
    { key: 'chat', is_core: false, is_destructive: false, tools: ['sprintable_send_chat_message', 'sprintable_list_chat_messages', 'sprintable_create_conversation'] },
    { key: 'docs', is_core: false, is_destructive: false, tools: ['sprintable_create_doc', 'sprintable_get_doc', 'sprintable_list_docs', 'sprintable_search_docs', 'sprintable_update_doc'] },
    { key: 'analytics', is_core: false, is_destructive: false, tools: ['sprintable_get_velocity', 'sprintable_get_project_health', 'sprintable_get_project_overview', 'sprintable_get_leaderboard_v2'] },
    { key: 'retro', is_core: false, is_destructive: false, tools: ['sprintable_create_retro_session', 'sprintable_add_retro_item', 'sprintable_vote_retro_item'] },
    { key: 'standup', is_core: false, is_destructive: false, tools: ['sprintable_get_standup', 'sprintable_save_standup', 'sprintable_standup_history'] },
    { key: 'meetings', is_core: false, is_destructive: false, tools: ['sprintable_create_meeting', 'sprintable_list_meetings', 'sprintable_get_meeting'] },
    { key: 'notifications', is_core: false, is_destructive: false, tools: ['sprintable_mark_notification_read', 'sprintable_mark_all_notifications_read'] },
    { key: 'webhooks', is_core: false, is_destructive: false, tools: ['sprintable_list_webhook_configs'] },
    { key: 'rewards', is_core: false, is_destructive: false, tools: ['sprintable_get_wallet'] },
    { key: 'audit', is_core: false, is_destructive: false, tools: ['sprintable_list_audit_logs'] },
    { key: 'agent_runs', is_core: false, is_destructive: false, tools: ['sprintable_update_run_status'] },
    { key: 'admin', is_core: false, is_destructive: true, tools: ['sprintable_delete_sprint', 'sprintable_close_sprint', 'sprintable_give_reward', 'sprintable_upsert_webhook_config', 'sprintable_activate_sprint'] },
  ],
};

/**
 * 카탈로그 fetch — BE 엔드포인트 우선, 미준비/실패 시 임시 상수 폴백.
 * 반환 시 폴백 여부를 함께 알려 UI가 "임시 데이터" 안내를 노출할 수 있게 한다.
 */
export async function fetchToolsetCatalog(): Promise<{ catalog: ToolsetCatalog; isFallback: boolean }> {
  try {
    const res = await fetch('/api/mcp/toolset-catalog');
    if (!res.ok) return { catalog: TEMP_TOOLSET_CATALOG, isFallback: true };
    const json = (await res.json()) as { data?: ToolsetCatalog } | ToolsetCatalog;
    const catalog = (('data' in json ? json.data : json) ?? TEMP_TOOLSET_CATALOG) as ToolsetCatalog;
    if (!Array.isArray(catalog.groups) || catalog.groups.length === 0) {
      return { catalog: TEMP_TOOLSET_CATALOG, isFallback: true };
    }
    return { catalog, isFallback: false };
  } catch {
    return { catalog: TEMP_TOOLSET_CATALOG, isFallback: true };
  }
}
