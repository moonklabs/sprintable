import type { MemoSummaryState } from './memo-state';

export const MEMO_CHANNEL_IDS = [
  'all',
  'inbox',
  'assigned',
  'created',
  'open',
  'resolved',
  'requests',
  'decisions',
  'tasks',
] as const;

export type MemoChannelId = typeof MEMO_CHANNEL_IDS[number];

export const MEMO_TEMPLATE_IDS = [
  'blank',
  'checklist',
  'request',
  'decision',
  'handoff',
] as const;

export type MemoTemplateId = typeof MEMO_TEMPLATE_IDS[number];

export interface MemoWorkspaceView {
  id: string;
  name: string;
  channel: MemoChannelId;
  search: string;
  unreadOnly: boolean;
  createdAt: string;
}

export interface MemoWorkspaceSnapshot {
  version: 1;
  activeViewId: string | null;
  channel: MemoChannelId;
  search: string;
  unreadOnly: boolean;
  savedViews: MemoWorkspaceView[];
}

export interface MemoDraftState {
  version: 1;
  title: string;
  content: string;
  memoType: string;
  assignedTo: string | null;
  templateId: MemoTemplateId;
}

export interface MemoTemplatePreset {
  id: MemoTemplateId;
  labelKey: string;
  memoType: string;
  defaultTitle: string;
  content: string;
}

export const MEMO_TEMPLATE_PRESETS: MemoTemplatePreset[] = [
  {
    id: 'blank',
    labelKey: 'templateBlank',
    memoType: 'memo',
    defaultTitle: '',
    content: '',
  },
  {
    id: 'checklist',
    labelKey: 'templateChecklist',
    memoType: 'checklist',
    defaultTitle: 'Checklist',
    content: '- [ ] First item\n- [ ] Second item\n- [ ] Third item',
  },
  {
    id: 'request',
    labelKey: 'templateRequest',
    memoType: 'request',
    defaultTitle: 'Request',
    content: '## Context\n\n## Request\n\n## Checklist\n- [ ] Follow up\n- [ ] Confirm owner',
  },
  {
    id: 'decision',
    labelKey: 'templateDecision',
    memoType: 'decision',
    defaultTitle: 'Decision',
    content: '## Decision needed\n\n## Options\n- Option A\n- Option B\n\n## Decision\n\n## Follow-up\n- [ ] Capture action items',
  },
  {
    id: 'handoff',
    labelKey: 'templateHandoff',
    memoType: 'handoff',
    defaultTitle: 'Handoff',
    content: '## Summary\n\n## Owner\n\n## Next steps\n- [ ]',
  },
];

export function isMemoChannelId(value: string | null | undefined): value is MemoChannelId {
  return Boolean(value && (MEMO_CHANNEL_IDS as readonly string[]).includes(value));
}

export function normalizeMemoChannelId(value: string | null | undefined, fallback: MemoChannelId = 'inbox'): MemoChannelId {
  return isMemoChannelId(value) ? value : fallback;
}

export function getMemoTemplatePreset(templateId: MemoTemplateId): MemoTemplatePreset {
  return MEMO_TEMPLATE_PRESETS.find((template) => template.id === templateId) ?? MEMO_TEMPLATE_PRESETS[0];
}

export function matchesMemoChannel(memo: Pick<MemoSummaryState, 'status' | 'memo_type' | 'created_by' | 'assigned_to'>, channel: MemoChannelId, currentTeamMemberId?: string) {
  switch (channel) {
    case 'all':
      return true;
    case 'inbox':
      if (!currentTeamMemberId) return memo.status === 'open';
      return memo.status === 'open' && (memo.assigned_to === currentTeamMemberId || memo.created_by === currentTeamMemberId || memo.assigned_to === null);
    case 'assigned':
      return Boolean(currentTeamMemberId && memo.assigned_to === currentTeamMemberId);
    case 'created':
      return Boolean(currentTeamMemberId && memo.created_by === currentTeamMemberId);
    case 'open':
      return memo.status === 'open';
    case 'resolved':
      return memo.status === 'resolved';
    case 'requests':
      return memo.memo_type === 'request';
    case 'decisions':
      return memo.memo_type === 'decision';
    case 'tasks':
      return memo.memo_type === 'task' || memo.memo_type === 'checklist';
    default:
      return true;
  }
}

export function isMemoUnread(memo: Pick<MemoSummaryState, 'readers'>, currentTeamMemberId?: string) {
  if (!currentTeamMemberId) return false;
  return !(memo.readers ?? []).some((reader) => reader.id === currentTeamMemberId);
}

export function filterMemoSummaries(
  memos: MemoSummaryState[],
  options: {
    channel: MemoChannelId;
    search: string;
    unreadOnly: boolean;
    currentTeamMemberId?: string;
    memberNameLookup?: (memberId: string) => string | undefined;
  },
) {
  const search = options.search.trim().toLowerCase();
  return memos.filter((memo) => {
    if (!matchesMemoChannel(memo, options.channel, options.currentTeamMemberId)) return false;
    if (options.unreadOnly && !isMemoUnread(memo, options.currentTeamMemberId)) return false;
    if (!search) return true;

    const tokens = [
      memo.title ?? '',
      memo.content ?? '',
      memo.memo_type ?? '',
      memo.status ?? '',
      memo.project_name ?? '',
      options.memberNameLookup?.(memo.created_by) ?? '',
      memo.created_by ?? '',
      options.memberNameLookup?.(memo.assigned_to ?? '') ?? '',
      memo.assigned_to ?? '',
    ]
      .join(' ')
      .toLowerCase();

    return tokens.includes(search);
  });
}

export function countUnreadMemoMatches(memos: MemoSummaryState[], currentTeamMemberId?: string) {
  if (!currentTeamMemberId) return 0;
  return memos.filter((memo) => isMemoUnread(memo, currentTeamMemberId)).length;
}

export function countMemoChannelMatches(memos: MemoSummaryState[], currentTeamMemberId?: string) {
  const counts: Record<MemoChannelId, number> = {
    all: 0,
    inbox: 0,
    assigned: 0,
    created: 0,
    open: 0,
    resolved: 0,
    requests: 0,
    decisions: 0,
    tasks: 0,
  };

  for (const memo of memos) {
    counts.all += 1;
    if (matchesMemoChannel(memo, 'inbox', currentTeamMemberId)) counts.inbox += 1;
    if (matchesMemoChannel(memo, 'assigned', currentTeamMemberId)) counts.assigned += 1;
    if (matchesMemoChannel(memo, 'created', currentTeamMemberId)) counts.created += 1;
    if (matchesMemoChannel(memo, 'open', currentTeamMemberId)) counts.open += 1;
    if (matchesMemoChannel(memo, 'resolved', currentTeamMemberId)) counts.resolved += 1;
    if (matchesMemoChannel(memo, 'requests', currentTeamMemberId)) counts.requests += 1;
    if (matchesMemoChannel(memo, 'decisions', currentTeamMemberId)) counts.decisions += 1;
    if (matchesMemoChannel(memo, 'tasks', currentTeamMemberId)) counts.tasks += 1;
  }

  return counts;
}

export function createMemoWorkspaceStorageKey(projectId?: string, teamMemberId?: string) {
  return `sprintable:memo-workspace:${projectId ?? 'global'}:${teamMemberId ?? 'anon'}`;
}

export function createMemoDraftStorageKey(projectId?: string, teamMemberId?: string) {
  return `sprintable:memo-draft:${projectId ?? 'global'}:${teamMemberId ?? 'anon'}`;
}

export function serializeMemoWorkspaceSnapshot(snapshot: MemoWorkspaceSnapshot) {
  return JSON.stringify(snapshot);
}

export function parseMemoWorkspaceSnapshot(raw: string | null): MemoWorkspaceSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MemoWorkspaceSnapshot>;
    if (parsed.version !== 1) return null;
    const channel = parsed.channel;
    if (!isMemoChannelId(channel)) return null;

    const savedViews = Array.isArray(parsed.savedViews)
      ? parsed.savedViews
        .filter((view) => Boolean(
          view
          && typeof view === 'object'
          && typeof view.id === 'string'
          && typeof view.name === 'string'
          && isMemoChannelId(view.channel)
          && typeof view.search === 'string'
          && typeof view.createdAt === 'string',
        ))
        .map((view) => ({
          id: view.id,
          name: view.name,
          channel: view.channel,
          search: view.search,
          unreadOnly: typeof view.unreadOnly === 'boolean' ? view.unreadOnly : false,
          createdAt: view.createdAt,
        }))
      : [];

    return {
      version: 1,
      activeViewId: typeof parsed.activeViewId === 'string' ? parsed.activeViewId : null,
      channel,
      search: typeof parsed.search === 'string' ? parsed.search : '',
      unreadOnly: typeof parsed.unreadOnly === 'boolean' ? parsed.unreadOnly : false,
      savedViews,
    };
  } catch {
    return null;
  }
}

export function serializeMemoDraft(draft: MemoDraftState) {
  return JSON.stringify(draft);
}

export function parseMemoDraft(raw: string | null): MemoDraftState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MemoDraftState>;
    if (parsed.version !== 1) return null;
    if (!MEMO_TEMPLATE_IDS.includes(parsed.templateId ?? 'blank')) return null;

    return {
      version: 1,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      content: typeof parsed.content === 'string' ? parsed.content : '',
      memoType: typeof parsed.memoType === 'string' ? parsed.memoType : 'memo',
      assignedTo: typeof parsed.assignedTo === 'string' || parsed.assignedTo === null ? parsed.assignedTo : null,
      templateId: parsed.templateId ?? 'blank',
    };
  } catch {
    return null;
  }
}
