import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchMemoAssignmentImmediately } = vi.hoisted(() => ({
  dispatchMemoAssignmentImmediately: vi.fn(async () => undefined),
}));

vi.mock('./memo-assignment-dispatch', () => ({
  dispatchMemoAssignmentImmediately,
}));

import { AgentHitlTimeoutService } from './agent-hitl-timeout';

const syncSlackHitlFn = vi.fn(async () => ({ status: 'updated' as const }));

type State = ReturnType<typeof createState>;
type Filters = Array<{ kind: 'eq' | 'in' | 'is' | 'not' | 'gt' | 'lte'; column: string; value: unknown; extra?: unknown }>;

type StubOptions = {
  skipRunTransition?: boolean;
  failTimeoutMemoInsert?: boolean;
};

function createState() {
  return {
    requests: [
      {
        id: 'hitl-reminder-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        run_id: 'run-reminder-1',
        requested_for: 'admin-1',
        title: 'Need reminder',
        prompt: 'remind me',
        status: 'pending',
        response_text: null,
        expires_at: '2026-04-08T11:30:00.000Z',
        reminder_sent_at: null,
        expired_at: null,
        metadata: {
          source_memo_id: 'memo-source-reminder',
          hitl_memo_id: 'memo-hitl-reminder',
          source_memo_title: 'Reminder source memo',
          reminder_minutes_before: 60,
          escalation_mode: 'timeout_memo',
        },
      },
      {
        id: 'hitl-expired-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        run_id: 'run-expired-1',
        requested_for: 'admin-1',
        title: 'Need approval',
        prompt: 'Should I proceed?',
        status: 'pending',
        response_text: null,
        expires_at: '2026-04-08T09:30:00.000Z',
        reminder_sent_at: null,
        expired_at: null,
        metadata: {
          source_memo_id: 'memo-source-1',
          source_memo_title: 'Source memo',
          hitl_memo_id: 'memo-hitl-1',
          hitl_memo_title: 'HITL memo',
          reminder_minutes_before: 60,
          escalation_mode: 'timeout_memo',
          slack_channel_id: 'C123',
          slack_message_ts: '1710000001.000200',
          slack_team_id: 'T123',
        },
      },
    ] as Array<Record<string, unknown>>,
    runs: [
      { id: 'run-reminder-1', status: 'hitl_pending', result_summary: 'Waiting for HITL', finished_at: null, last_error_code: null, error_message: null },
      { id: 'run-expired-1', status: 'hitl_pending', result_summary: 'Waiting for HITL', finished_at: null, last_error_code: null, error_message: null },
    ] as Array<Record<string, unknown>>,
    notifications: [] as Array<Record<string, unknown>>,
    orgMembers: [
      { org_id: 'org-1', user_id: 'user-admin-1', role: 'owner' },
      { org_id: 'org-1', user_id: 'user-admin-2', role: 'admin' },
    ] as Array<Record<string, unknown>>,
    teamMembers: [
      { id: 'admin-1', org_id: 'org-1', project_id: 'project-1', type: 'human', user_id: 'user-admin-1', is_active: true },
      { id: 'admin-2', org_id: 'org-1', project_id: 'project-1', type: 'human', user_id: 'user-admin-2', is_active: true },
    ] as Array<Record<string, unknown>>,
    memos: [
      { id: 'memo-hitl-1', status: 'open', resolved_at: null, resolved_by: null },
      { id: 'memo-source-1', status: 'open', resolved_at: null, resolved_by: null },
    ] as Array<Record<string, unknown>>,
    insertedTimeoutMemos: [] as Array<Record<string, unknown>>,
    memoReplies: [] as Array<Record<string, unknown>>,
    nextReplyId: 1,
  };
}

function matches(row: Record<string, unknown>, filters: Filters) {
  return filters.every((filter) => {
    const current = row[filter.column];
    switch (filter.kind) {
      case 'eq': return current === filter.value;
      case 'in': return Array.isArray(filter.value) && filter.value.includes(current);
      case 'is': return filter.value === null ? current === null : current === filter.value;
      case 'not': {
        if (filter.extra === 'is') return filter.value === null ? current !== null : current !== filter.value;
        return true;
      }
      case 'gt': return typeof current === 'string' && typeof filter.value === 'string' && current > filter.value;
      case 'lte': return typeof current === 'string' && typeof filter.value === 'string' && current <= filter.value;
      default: return true;
    }
  });
}

function createSelectBuilder(rows: Array<Record<string, unknown>>) {
  const filters: Filters = [];
  let limitCount: number | null = null;

  const builder = {
    eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
    in(column: string, value: unknown[]) { filters.push({ kind: 'in', column, value }); return builder; },
    is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return builder; },
    not(column: string, operator: string, value: unknown) { filters.push({ kind: 'not', column, value, extra: operator }); return builder; },
    gt(column: string, value: unknown) { filters.push({ kind: 'gt', column, value }); return builder; },
    lte(column: string, value: unknown) { filters.push({ kind: 'lte', column, value }); return builder; },
    order() { return builder; },
    limit(count: number) { limitCount = count; return builder; },
    then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
      let data = rows.filter((row) => matches(row, filters));
      if (limitCount !== null) data = data.slice(0, limitCount);
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };

  return builder;
}

function createUpdateBuilder(
  rows: Array<Record<string, unknown>>,
  payload: Record<string, unknown>,
  options?: { skipAll?: boolean },
) {
  const filters: Filters = [];
  const builder = {
    eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
    in(column: string, value: unknown[]) { filters.push({ kind: 'in', column, value }); return builder; },
    is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return builder; },
    select: async () => {
      const data = options?.skipAll ? [] : rows.filter((row) => matches(row, filters));
      data.forEach((row) => Object.assign(row, payload));
      return { data, error: null };
    },
    then(resolve: (value: { data: unknown; error: null }) => unknown) {
      const data = options?.skipAll ? [] : rows.filter((row) => matches(row, filters));
      data.forEach((row) => Object.assign(row, payload));
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return builder;
}

function createDeleteBuilder(rows: Array<Record<string, unknown>>, onDelete?: (deleted: Array<Record<string, unknown>>) => void) {
  const filters: Filters = [];
  const builder = {
    eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
    in(column: string, value: unknown[]) { filters.push({ kind: 'in', column, value }); return builder; },
    then(resolve: (value: { data: null; error: null }) => unknown) {
      const deleted = rows.filter((row) => matches(row, filters));
      onDelete?.(deleted);
      for (const row of deleted) {
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
      }
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return builder;
}

function createDbStub(state: State, options: StubOptions = {}) {
  return {
    from(table: string) {
      if (table === 'agent_hitl_requests') {
        return {
          select() { return createSelectBuilder(state.requests); },
          update(payload: Record<string, unknown>) { return createUpdateBuilder(state.requests, payload); },
        };
      }

      if (table === 'agent_runs') {
        return {
          select() { return createSelectBuilder(state.runs); },
          update(payload: Record<string, unknown>) {
            return createUpdateBuilder(state.runs, payload, { skipAll: options.skipRunTransition === true });
          },
        };
      }

      if (table === 'notifications') {
        return {
          insert: async (payload: Record<string, unknown> | Record<string, unknown>[]) => {
            state.notifications.push(...(Array.isArray(payload) ? payload : [payload]));
            return { error: null };
          },
        };
      }

      if (table === 'org_members') {
        return {
          select() { return createSelectBuilder(state.orgMembers); },
        };
      }

      if (table === 'team_members') {
        return {
          select() { return createSelectBuilder(state.teamMembers); },
        };
      }

      if (table === 'memos') {
        return {
          insert: (payload: Record<string, unknown>[]) => ({
            select: async () => {
              if (options.failTimeoutMemoInsert) {
                return { data: null, error: new Error('memo_insert_failed') };
              }
              const inserted = payload.map((row, index) => ({
                id: `timeout-memo-${index + 1}`,
                ...row,
              })) as Array<Record<string, unknown>>;
              state.insertedTimeoutMemos.push(...inserted);
              state.memos.push(...inserted);
              return {
                data: inserted,
                error: null,
              };
            },
          }),
          update(payload: Record<string, unknown>) { return createUpdateBuilder(state.memos, payload); },
          delete() {
            return createDeleteBuilder(state.memos, (deleted) => {
              state.insertedTimeoutMemos = state.insertedTimeoutMemos.filter((memo) => !deleted.some((row) => row.id === memo.id));
            });
          },
        };
      }

      if (table === 'memo_replies') {
        return {
          insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => ({
            select: async () => {
              const rows = (Array.isArray(payload) ? payload : [payload]).map((row) => ({
                id: `reply-${state.nextReplyId++}`,
                ...row,
              }));
              state.memoReplies.push(...rows);
              return { data: rows.map((row) => ({ id: row.id })), error: null };
            },
          }),
          delete() { return createDeleteBuilder(state.memoReplies); },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

describe('AgentHitlTimeoutService', () => {
  beforeEach(() => {
    dispatchMemoAssignmentImmediately.mockReset();
    dispatchMemoAssignmentImmediately.mockResolvedValue(undefined);
    syncSlackHitlFn.mockReset();
    syncSlackHitlFn.mockResolvedValue({ status: 'updated' });
  });

  it('sends one-hour reminders and expires overdue HITL requests in bulk', async () => {
    const state = createState();
    const db = createDbStub(state);
    const service = new AgentHitlTimeoutService(db as never, {
      now: () => new Date('2026-04-08T10:30:00.000Z'),
      syncSlackHitlFn,
      logger: console,
    });

    const result = await service.scan({ limit: 20 });

    expect(result).toEqual({
      reminders_sent: 1,
      reminder_request_ids: ['hitl-reminder-1'],
      timed_out: 1,
      timeout_request_ids: ['hitl-expired-1'],
      timeout_memo_ids: ['timeout-memo-1'],
      skipped_timeout_request_ids: [],
    });
    expect(state.notifications).toEqual([
      expect.objectContaining({ user_id: 'admin-1', title: 'HITL 요청 만료 임박', body: 'Need reminder 요청의 응답 기한이 1시간 이내로 남았습니다.' }),
    ]);
    expect(state.requests.find((row) => row.id === 'hitl-reminder-1')).toMatchObject({
      reminder_sent_at: '2026-04-08T10:30:00.000Z',
      status: 'pending',
    });
    expect(state.requests.find((row) => row.id === 'hitl-expired-1')).toMatchObject({
      expired_at: '2026-04-08T10:30:00.000Z',
      status: 'expired',
      response_text: 'HITL timeout',
    });
    expect(state.runs.find((row) => row.id === 'run-expired-1')).toMatchObject({
      status: 'failed',
      last_error_code: 'hitl_timeout',
    });
    expect(state.insertedTimeoutMemos[0]).toMatchObject({
      title: 'HITL timeout · Source memo',
      assigned_to: 'admin-1',
    });
    expect(dispatchMemoAssignmentImmediately).toHaveBeenCalledWith(expect.objectContaining({
      id: 'timeout-memo-1',
      assigned_to: 'admin-1',
    }));
    expect(state.memoReplies).toEqual(expect.arrayContaining([
      expect.objectContaining({ memo_id: 'memo-source-1', created_by: 'agent-1' }),
      expect.objectContaining({ memo_id: 'memo-hitl-1', created_by: 'agent-1' }),
    ]));
    expect(state.memos.find((row) => row.id === 'memo-hitl-1')).toMatchObject({ status: 'resolved' });
    expect(syncSlackHitlFn).toHaveBeenCalledTimes(1);
  });

  it('uses policy reminder windows and escalates timeout follow-up when configured', async () => {
    const state = createState();
    state.requests[0]!.expires_at = '2026-04-08T11:45:00.000Z';
    state.requests[0]!.metadata = {
      ...(state.requests[0]!.metadata as Record<string, unknown>),
      reminder_minutes_before: 120,
    };
    state.requests[1]!.metadata = {
      ...(state.requests[1]!.metadata as Record<string, unknown>),
      escalation_mode: 'timeout_memo_and_escalate',
    };

    const db = createDbStub(state);
    const service = new AgentHitlTimeoutService(db as never, {
      now: () => new Date('2026-04-08T10:30:00.000Z'),
      syncSlackHitlFn,
      logger: console,
    });

    const result = await service.scan({ limit: 20 });

    expect(result.reminders_sent).toBe(1);
    expect(result.timed_out).toBe(1);
    expect(state.notifications[0]).toMatchObject({
      body: 'Need reminder 요청의 응답 기한이 2시간 이내로 남았습니다.',
    });
    expect(state.insertedTimeoutMemos[0]).toMatchObject({
      title: 'HITL timeout escalation · Source memo',
      assigned_to: 'admin-2',
      metadata: expect.objectContaining({
        escalation_mode: 'timeout_memo_and_escalate',
        escalated_to: 'admin-2',
      }),
    });
  });

  it('does not starve longer reminder classes behind mixed fast backlog', async () => {
    const state = createState();
    state.requests = [];
    state.notifications = [];
    state.runs = [];

    for (let index = 0; index < 50; index += 1) {
      state.requests.push({
        id: `hitl-fast-${index}`,
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        run_id: `run-fast-${index}`,
        requested_for: 'admin-1',
        title: `Fast backlog ${index}`,
        prompt: 'fast backlog',
        status: 'pending',
        response_text: null,
        expires_at: '2026-04-08T11:45:00.000Z',
        reminder_sent_at: null,
        expired_at: null,
        metadata: {
          source_memo_id: `memo-fast-${index}`,
          hitl_memo_id: `memo-hitl-fast-${index}`,
          source_memo_title: `Fast memo ${index}`,
          reminder_minutes_before: 60,
          escalation_mode: 'timeout_memo',
        },
      });
    }

    state.requests.push({
      id: 'hitl-extended-due',
      org_id: 'org-1',
      project_id: 'project-1',
      agent_id: 'agent-1',
      run_id: 'run-extended-due',
      requested_for: 'admin-1',
      title: 'Extended due reminder',
      prompt: 'extended due reminder',
      status: 'pending',
      response_text: null,
      expires_at: '2026-04-09T10:00:00.000Z',
      reminder_sent_at: null,
      expired_at: null,
      metadata: {
        source_memo_id: 'memo-extended-due',
        hitl_memo_id: 'memo-hitl-extended-due',
        source_memo_title: 'Extended memo',
        reminder_minutes_before: 1440,
        escalation_mode: 'timeout_memo',
      },
    });

    const db = createDbStub(state);
    const service = new AgentHitlTimeoutService(db as never, {
      now: () => new Date('2026-04-08T10:30:00.000Z'),
      syncSlackHitlFn,
      logger: console,
    });

    const result = await service.scan({ limit: 10 });

    expect(result.reminders_sent).toBe(1);
    expect(result.reminder_request_ids).toEqual(['hitl-extended-due']);
    expect(state.notifications).toEqual([
      expect.objectContaining({
        user_id: 'admin-1',
        body: 'Extended due reminder 요청의 응답 기한이 24시간 이내로 남았습니다.',
      }),
    ]);
  });

  it('clears the expired claim when the run transition loses a race', async () => {
    const state = createState();
    const db = createDbStub(state, { skipRunTransition: true });
    const service = new AgentHitlTimeoutService(db as never, {
      now: () => new Date('2026-04-08T10:30:00.000Z'),
      syncSlackHitlFn,
      logger: console,
    });

    const result = await service.scan({ limit: 20 });

    expect(result).toEqual({
      reminders_sent: 1,
      reminder_request_ids: ['hitl-reminder-1'],
      timed_out: 0,
      timeout_request_ids: [],
      timeout_memo_ids: [],
      skipped_timeout_request_ids: ['hitl-expired-1'],
    });
    expect(state.requests.find((row) => row.id === 'hitl-expired-1')).toMatchObject({
      status: 'pending',
      expired_at: null,
    });
    expect(state.runs.find((row) => row.id === 'run-expired-1')).toMatchObject({
      status: 'hitl_pending',
    });
    expect(state.insertedTimeoutMemos).toEqual([]);
    expect(dispatchMemoAssignmentImmediately).not.toHaveBeenCalled();
    expect(state.memoReplies).toEqual([]);
  });

  it('rolls back timeout claims and run state when timeout memo creation fails', async () => {
    const state = createState();
    const db = createDbStub(state, { failTimeoutMemoInsert: true });
    const service = new AgentHitlTimeoutService(db as never, {
      now: () => new Date('2026-04-08T10:30:00.000Z'),
      syncSlackHitlFn,
      logger: console,
    });

    await expect(service.scan({ limit: 20 })).rejects.toThrow('memo_insert_failed');
    expect(state.requests.find((row) => row.id === 'hitl-expired-1')).toMatchObject({
      status: 'pending',
      expired_at: null,
      response_text: null,
    });
    expect(state.runs.find((row) => row.id === 'run-expired-1')).toMatchObject({
      status: 'hitl_pending',
      result_summary: 'Waiting for HITL',
      last_error_code: null,
    });
    expect(state.insertedTimeoutMemos).toEqual([]);
    expect(dispatchMemoAssignmentImmediately).not.toHaveBeenCalled();
    expect(state.memoReplies).toEqual([]);
    expect(state.memos.find((row) => row.id === 'memo-hitl-1')).toMatchObject({ status: 'open' });
    expect(syncSlackHitlFn).not.toHaveBeenCalled();
  });

  it('does not resend reminders or reprocess expired requests after claim markers are set', async () => {
    const state = createState();
    state.requests[0]!.reminder_sent_at = '2026-04-08T10:00:00.000Z';
    state.requests[1]!.status = 'expired';
    state.requests[1]!.expired_at = '2026-04-08T10:00:00.000Z';

    const db = createDbStub(state);
    const service = new AgentHitlTimeoutService(db as never, {
      now: () => new Date('2026-04-08T10:30:00.000Z'),
      syncSlackHitlFn,
      logger: console,
    });

    const result = await service.scan({ limit: 20 });

    expect(result).toEqual({
      reminders_sent: 0,
      reminder_request_ids: [],
      timed_out: 0,
      timeout_request_ids: [],
      timeout_memo_ids: [],
      skipped_timeout_request_ids: [],
    });
    expect(state.notifications).toEqual([]);
    expect(state.insertedTimeoutMemos).toEqual([]);
    expect(syncSlackHitlFn).not.toHaveBeenCalled();
  });
});
