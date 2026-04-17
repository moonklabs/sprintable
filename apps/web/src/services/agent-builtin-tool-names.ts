export const BUILTIN_AGENT_TOOL_NAMES = [
  'get_source_memo',
  'list_recent_project_memos',
  'add_memo_reply',
  'resolve_memo',
  'create_memo',
  'reply_memo',
  'update_memo',
  'list_memos',
  'create_story',
  'update_story_status',
  'create_epic',
  'list_epics',
  'list_stories',
  'assign_story',
  'notify_slack',
  'forward_memo',
] as const;

export type BuiltinAgentToolName = typeof BUILTIN_AGENT_TOOL_NAMES[number];
