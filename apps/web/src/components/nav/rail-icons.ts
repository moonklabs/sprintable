import type { IconName } from '@/components/ds/icon';

// story #4885 PR 3 — 막대 · 옆 목록의 아이콘을 UI-3의 Material Symbols(`components/ds/icon`)로. 항목 id → 글리프 이름 한 표.
// 대응은 icon-map.ts(lucide → Material, 유나 UI-3 대응표)를 그대로 따른다. 새 nav 항목이 생기면 이 표에 한 줄이 없으면 시험이 빨개진다(rail-icons.test.ts).
export const RAIL_ICON_BY_ITEM_ID: Record<string, IconName> = {
  'org-briefing': 'newsmode',
  inbox: 'inbox',
  chats: 'chat_bubble',
  board: 'account_tree',
  goals: 'layers',
  loops: 'science',
  'org-members': 'groups',
  'org-workforce': 'smart_toy',
  'org-workforce-runs': 'history',
  'org-workforce-api-keys': 'key',
  docs: 'menu_book',
  artifacts: 'view_agenda',
  storage: 'hard_drive',
  'org-insights-board': 'trending_up',
  'org-channels': 'share',
  'org-generation-connectors': 'memory',
  'org-content-rules': 'checklist',
  'org-events': 'bolt',
  'org-trust': 'military_tech',
  'org-roles': 'shield',
  activity: 'assignment',
  content: 'description',
  'channel-posts': 'share',
  settings: 'settings',
  'desktop-app': 'desktop_windows',
  'all-screens': 'grid_view',
  // 막대에만 있는 단추(항목이 아니다)
  org: 'domain',
  search: 'search',
  'list-column-toggle': 'left_panel_open',
  account: 'person',
};
