import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseAdminClient,
  dispatchMemoIfNeeded,
  stop,
  MemoEventDispatcher,
} = vi.hoisted(() => {
  const createSupabaseAdminClient = vi.fn(() => ({ tag: 'admin-supabase' }));
  const dispatchMemoIfNeeded = vi.fn();
  const stop = vi.fn();
  const MemoEventDispatcher = vi.fn(function MemoEventDispatcher() {
    return {
      dispatchMemoIfNeeded,
      stop,
    };
  });

  return {
    createSupabaseAdminClient,
    dispatchMemoIfNeeded,
    stop,
    MemoEventDispatcher,
  };
});

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient,
}));

vi.mock('./memo-event-dispatcher', () => ({
  MemoEventDispatcher,
}));

import { dispatchMemoAssignmentImmediately } from './memo-assignment-dispatch';

describe('dispatchMemoAssignmentImmediately', () => {
  beforeEach(() => {
    createSupabaseAdminClient.mockClear();
    dispatchMemoIfNeeded.mockReset();
    stop.mockReset();
    MemoEventDispatcher.mockClear();
  });

  it('dispatches assigned open memos immediately through the memo dispatcher', async () => {
    await dispatchMemoAssignmentImmediately({
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Urgent memo',
      content: 'Please review',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      metadata: { source: 'discord' },
      updated_at: '2026-04-10T09:00:00.000Z',
      created_at: '2026-04-10T09:00:00.000Z',
    });

    expect(createSupabaseAdminClient).toHaveBeenCalledTimes(1);
    expect(MemoEventDispatcher).toHaveBeenCalledWith({
      supabase: { tag: 'admin-supabase' },
      logger: console,
    });
    expect(dispatchMemoIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'memo-1', assigned_to: 'agent-1' }),
      'realtime',
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('skips unassigned memos', async () => {
    await dispatchMemoAssignmentImmediately({
      id: 'memo-2',
      org_id: 'org-1',
      project_id: 'project-1',
      title: null,
      content: 'FYI',
      memo_type: 'memo',
      status: 'open',
      assigned_to: null,
      created_by: 'human-1',
      metadata: null,
      updated_at: '2026-04-10T09:00:00.000Z',
      created_at: '2026-04-10T09:00:00.000Z',
    });

    expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(dispatchMemoIfNeeded).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});
