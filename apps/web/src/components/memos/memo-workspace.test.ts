import { describe, expect, it } from 'vitest';
import type { MemoSummaryState } from './memo-state';
import {
  countMemoChannelMatches,
  countUnreadMemoMatches,
  filterMemoSummaries,
  getMemoTemplatePreset,
  parseMemoDraft,
  parseMemoWorkspaceSnapshot,
  serializeMemoDraft,
  serializeMemoWorkspaceSnapshot,
} from './memo-workspace';

const memos = [
  {
    id: 'memo-1',
    title: 'Bug triage',
    content: 'Investigate failing build',
    status: 'open',
    memo_type: 'request',
    created_by: 'me',
    assigned_to: 'teammate',
    created_at: '2026-04-10T00:00:00.000Z',
    project_name: 'Project Alpha',
    readers: [{ id: 'me', name: 'Didi', read_at: '2026-04-10T00:05:00.000Z' }],
  },
  {
    id: 'memo-2',
    title: 'Decision note',
    content: 'Ship it',
    status: 'resolved',
    memo_type: 'decision',
    created_by: 'teammate',
    assigned_to: null,
    created_at: '2026-04-10T00:10:00.000Z',
    project_name: 'Project Alpha',
    readers: [],
  },
  {
    id: 'memo-3',
    title: 'Checklist handoff',
    content: '- [ ] First item',
    status: 'open',
    memo_type: 'checklist',
    created_by: 'teammate',
    assigned_to: 'me',
    created_at: '2026-04-10T00:20:00.000Z',
    project_name: 'Project Beta',
    readers: [],
  },
] satisfies MemoSummaryState[];

describe('memo workspace helpers', () => {
  it('filters memos by channel, unread, and search', () => {
    const visible = filterMemoSummaries(memos, {
      channel: 'inbox',
      search: 'build',
      unreadOnly: false,
      currentTeamMemberId: 'me',
      memberNameLookup: (id) => ({ me: 'Didi', teammate: 'Qasim' }[id]),
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe('memo-1');

    const unreadVisible = filterMemoSummaries(memos, {
      channel: 'all',
      search: '',
      unreadOnly: true,
      currentTeamMemberId: 'me',
      memberNameLookup: (id) => ({ me: 'Didi', teammate: 'Qasim' }[id]),
    });

    expect(unreadVisible.map((memo) => memo.id)).toEqual(['memo-2', 'memo-3']);
  });

  it('counts channel matches and unread memos', () => {
    const counts = countMemoChannelMatches(memos, 'me');
    const unreadCount = countUnreadMemoMatches(memos, 'me');

    expect(counts.all).toBe(3);
    expect(counts.inbox).toBe(2);
    expect(counts.assigned).toBe(1);
    expect(counts.created).toBe(1);
    expect(counts.requests).toBe(1);
    expect(counts.decisions).toBe(1);
    expect(counts.tasks).toBe(1);
    expect(unreadCount).toBe(2);
  });

  it('returns checklist template presets', () => {
    const preset = getMemoTemplatePreset('checklist');

    expect(preset.memoType).toBe('checklist');
    expect(preset.content).toContain('- [ ]');
  });

  it('round-trips workspace snapshots and drafts', () => {
    const snapshot = {
      version: 1 as const,
      activeViewId: 'view-1',
      channel: 'requests' as const,
      search: 'build',
      unreadOnly: true,
      savedViews: [
        {
          id: 'view-1',
          name: 'Requests',
          channel: 'requests' as const,
          search: 'build',
          unreadOnly: true,
          createdAt: '2026-04-10T01:00:00.000Z',
        },
      ],
    };

    const draft = {
      version: 1 as const,
      title: 'Checklist',
      content: '- [ ] One',
      memoType: 'checklist',
      assignedTo: 'me',
      templateId: 'checklist' as const,
    };

    expect(parseMemoWorkspaceSnapshot(serializeMemoWorkspaceSnapshot(snapshot))).toEqual(snapshot);
    expect(parseMemoDraft(serializeMemoDraft(draft))).toEqual(draft);
  });
});
