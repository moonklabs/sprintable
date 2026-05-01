import { describe, expect, it, vi } from 'vitest';
import { AgentSessionLifecycleService, type AgentSessionRecord, type AgentSessionRunRecord } from './agent-session-lifecycle';

function createDbStub(initial?: {
  sessions?: AgentSessionRecord[];
  runs?: AgentSessionRunRecord[];
  memories?: Array<Record<string, unknown>>;
}) {
  type RowLike = AgentSessionRecord | AgentSessionRunRecord | Record<string, unknown>;

  const state = {
    sessions: [...(initial?.sessions ?? [])],
    runs: [...(initial?.runs ?? [])],
    memories: [...(initial?.memories ?? [])],
  };

  const getValue = (row: RowLike, column: string) => (row as Record<string, unknown>)[column];
  const applyFilters = (rows: RowLike[], filters: Array<(row: RowLike) => boolean>) => rows.filter((row) => filters.every((filter) => filter(row)));

  const makeQuery = (table: 'agent_sessions' | 'agent_runs' | 'agent_session_memories') => {
    const filters: Array<(row: RowLike) => boolean> = [];
    let sortColumn: string | null = null;
    let sortAscending = true;
    let limitCount: number | null = null;

    const rowsForTable = (): RowLike[] => table === 'agent_sessions'
      ? state.sessions
      : table === 'agent_runs'
        ? state.runs
        : state.memories;

    const finalize = () => {
      let rows = applyFilters(rowsForTable(), filters);
      if (sortColumn) {
        rows = [...rows].sort((a, b) => {
          const av = getValue(a, sortColumn!);
          const bv = getValue(b, sortColumn!);
          if (av === bv) return 0;
          if (av == null) return sortAscending ? 1 : -1;
          if (bv == null) return sortAscending ? -1 : 1;
          return av > bv ? (sortAscending ? 1 : -1) : (sortAscending ? -1 : 1);
        });
      }
      if (limitCount !== null) rows = rows.slice(0, limitCount);
      return rows;
    };

    const query = {
      select() { return this; },
      eq(column: string, value: unknown) {
        filters.push((row) => getValue(row, column) === value);
        return this;
      },
      neq(column: string, value: unknown) {
        filters.push((row) => getValue(row, column) !== value);
        return this;
      },
      is(column: string, value: unknown) {
        filters.push((row) => (getValue(row, column) ?? null) === value);
        return this;
      },
      not(column: string, operator: string, value: unknown) {
        if (operator === 'is') {
          filters.push((row) => (getValue(row, column) ?? null) !== value);
        }
        return this;
      },
      lte(column: string, value: string) {
        filters.push((row) => String(getValue(row, column) ?? '') <= value);
        return this;
      },
      order(column: string, options?: { ascending?: boolean }) {
        sortColumn = column;
        sortAscending = options?.ascending ?? true;
        return this;
      },
      limit(count: number) {
        limitCount = count;
        return this;
      },
      maybeSingle: async () => ({ data: finalize()[0] ?? null, error: null }),
      single: async () => {
        const rows = finalize();
        return { data: rows[0] ?? null, error: rows[0] ? null : new Error('not_found') };
      },
      insert: (payload: Record<string, unknown>) => {
        const record = {
          id: payload.id ?? `${table}-${rowsForTable().length + 1}`,
          created_at: payload.created_at ?? '2026-04-09T00:00:00.000Z',
          updated_at: payload.updated_at ?? '2026-04-09T00:00:00.000Z',
          ...payload,
        };
        rowsForTable().push(record);
        return {
          select() { return this; },
          single: async () => ({ data: record, error: null }),
        };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (column: string, value: unknown) => {
          filters.push((row) => getValue(row, column) === value);
          const apply = () => {
            const rows = finalize();
            rows.forEach((row) => Object.assign(row, patch));
            return rows;
          };
          return {
            error: null,
            eq: (column2: string, value2: unknown) => {
              filters.push((row) => getValue(row, column2) === value2);
              const rows = apply();
              return { data: rows, error: null };
            },
            select: async () => {
              const rows = apply();
              return { data: rows, error: null };
            },
            single: async () => {
              const rows = apply();
              return { data: rows[0] ?? null, error: rows[0] ? null : new Error('not_found') };
            },
            then(resolve: (value: { data: unknown[]; error: null }) => void) {
              return Promise.resolve({ data: apply(), error: null }).then(resolve);
            },
          };
        },
        select: async () => {
          const rows = finalize();
          rows.forEach((row) => Object.assign(row, patch));
          return { data: rows, error: null };
        },
      }),
      then(resolve: (value: { data: unknown[]; error: null }) => void) {
        return Promise.resolve({ data: finalize(), error: null }).then(resolve);
      },
    };

    return query;
  };

  return {
    state,
    db: {
      from(table: string) {
        if (table === 'agent_sessions' || table === 'agent_runs' || table === 'agent_session_memories') {
          return makeQuery(table);
        }
        throw new Error(`Unsupported table: ${table}`);
      },
    },
  };
}

function makeSession(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 'session-1',
    org_id: 'org-1',
    project_id: 'project-1',
    agent_id: 'agent-1',
    persona_id: null,
    deployment_id: null,
    session_key: 'memo:memo-1',
    channel: 'memo',
    title: 'Memo 1',
    status: 'active',
    context_window_tokens: null,
    metadata: {},
    context_snapshot: {},
    created_by: 'human-1',
    started_at: '2026-04-09T00:00:00.000Z',
    last_activity_at: '2026-04-09T00:00:00.000Z',
    idle_at: null,
    suspended_at: null,
    ended_at: null,
    terminated_at: null,
    created_at: '2026-04-09T00:00:00.000Z',
    updated_at: '2026-04-09T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<AgentSessionRunRecord> = {}): AgentSessionRunRecord {
  return {
    id: 'run-1',
    org_id: 'org-1',
    project_id: 'project-1',
    agent_id: 'agent-1',
    memo_id: 'memo-1',
    session_id: null,
    status: 'running',
    retry_count: 0,
    max_retries: 3,
    started_at: '2026-04-09T00:00:00.000Z',
    finished_at: null,
    result_summary: null,
    last_error_code: null,
    error_message: null,
    ...overrides,
  };
}

describe('AgentSessionLifecycleService', () => {
  it('creates an active session and restores snapshot memories when capacity is available', async () => {
    const { db, state } = createDbStub({
      sessions: [makeSession({
        id: 'session-restore',
        session_key: 'memo:memo-1',
        status: 'idle',
        context_snapshot: {
          memories: [{ memory_type: 'summary', content: 'remember this', importance: 80, created_at: '2026-04-09T00:00:00.000Z' }],
        },
      })],
    });
    const service = new AgentSessionLifecycleService(db as never, { nowFn: () => new Date('2026-04-09T01:00:00.000Z') });

    const result = await service.claimSession({
      run: makeRun({ session_id: 'session-restore' }),
      memo: { id: 'memo-1', memo_type: 'memo', title: 'Memo 1', created_by: 'human-1' },
      personaId: null,
      deploymentId: null,
      channel: 'memo',
      resumeSuspended: true,
    });

    expect(result.holdRun).toBe(false);
    expect(result.session.status).toBe('active');
    expect(result.restoredMemoryCount).toBe(1);
    expect(state.memories).toHaveLength(1);
  });

  it('holds a new session when another active session already occupies the concurrency slot', async () => {
    const { db } = createDbStub({
      sessions: [
        makeSession({ id: 'session-active', session_key: 'memo:other', status: 'active' }),
      ],
    });
    const service = new AgentSessionLifecycleService(db as never, { sessionLimit: 1, nowFn: () => new Date('2026-04-09T01:00:00.000Z') });

    const result = await service.claimSession({
      run: makeRun({ id: 'run-2', memo_id: 'memo-2' }),
      memo: { id: 'memo-2', memo_type: 'memo', title: 'Memo 2', created_by: 'human-1' },
      personaId: null,
      deploymentId: null,
      channel: 'memo',
    });

    expect(result.holdRun).toBe(true);
    expect(result.holdReason).toBe('session_waiting_for_capacity');
    expect(result.session.status).toBe('idle');
  });

  it('suspends HITL sessions and resumes the oldest waiting held run', async () => {
    const { db, state } = createDbStub({
      sessions: [
        makeSession({ id: 'session-current', session_key: 'memo:memo-1', status: 'active' }),
        makeSession({ id: 'session-waiting', session_key: 'memo:memo-2', status: 'idle' }),
      ],
      runs: [
        makeRun({ id: 'run-current', session_id: 'session-current', memo_id: 'memo-1', status: 'running' }),
        makeRun({ id: 'run-waiting', session_id: 'session-waiting', memo_id: 'memo-2', status: 'held', started_at: '2026-04-09T00:30:00.000Z' }),
      ],
      memories: [{
        org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', session_id: 'session-current', run_id: 'run-current', memory_type: 'summary', importance: 80, content: 'Need approval', created_at: '2026-04-09T00:40:00.000Z',
      }],
    });
    const service = new AgentSessionLifecycleService(db as never, { sessionLimit: 1, nowFn: () => new Date('2026-04-09T01:00:00.000Z') });

    const result = await service.applyRunOutcome({
      run: makeRun({ id: 'run-current', session_id: 'session-current', memo_id: 'memo-1', status: 'hitl_pending' }),
      sessionId: 'session-current',
      outcome: 'hitl_pending',
    });

    expect(result.session.status).toBe('suspended');
    expect(result.resumptions).toEqual([{ runId: 'run-waiting', memoId: 'memo-2', orgId: 'org-1', projectId: 'project-1', agentId: 'agent-1' }]);
    expect(state.sessions.find((session) => session.id === 'session-waiting')?.status).toBe('active');
    expect(state.runs.find((run) => run.id === 'run-waiting')?.status).toBe('running');
  });

  it('excludes cross-project memories from the saved session snapshot', async () => {
    const { db } = createDbStub({
      sessions: [makeSession({ id: 'session-current', status: 'active' })],
      runs: [makeRun({ id: 'run-current', session_id: 'session-current', status: 'running' })],
      memories: [
        {
          org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', session_id: 'session-current', run_id: 'run-current', memory_type: 'summary', importance: 80, content: '현재 프로젝트 메모리', created_at: '2026-04-09T00:40:00.000Z',
        },
        {
          org_id: 'org-1', project_id: 'project-2', agent_id: 'agent-1', session_id: 'session-current', run_id: 'run-current', memory_type: 'summary', importance: 95, content: '다른 프로젝트 메모리', created_at: '2026-04-09T00:41:00.000Z',
        },
      ],
    });
    const service = new AgentSessionLifecycleService(db as never, { nowFn: () => new Date('2026-04-09T01:00:00.000Z') });

    const result = await service.applyRunOutcome({
      run: makeRun({ id: 'run-current', session_id: 'session-current', status: 'completed' }),
      sessionId: 'session-current',
      outcome: 'completed',
    });

    const snapshotMemories = (result.session.context_snapshot?.memories as Array<{ content: string }> | undefined) ?? [];
    expect(snapshotMemories.map((memory) => memory.content)).toEqual(['현재 프로젝트 메모리']);
  });

  it('terminates the session after a final failure when no retry is scheduled', async () => {
    const { db } = createDbStub({
      sessions: [makeSession({ id: 'session-fail', status: 'active' })],
      runs: [makeRun({ id: 'run-fail', session_id: 'session-fail', status: 'failed', retry_count: 3, max_retries: 3 })],
    });
    const service = new AgentSessionLifecycleService(db as never, { nowFn: () => new Date('2026-04-09T01:00:00.000Z') });

    const result = await service.applyRunOutcome({
      run: makeRun({ id: 'run-fail', session_id: 'session-fail', status: 'failed', retry_count: 3, max_retries: 3 }),
      sessionId: 'session-fail',
      outcome: 'failed',
      retryScheduled: false,
    });

    expect(result.session.status).toBe('terminated');
    expect(result.session.terminated_at).toBe('2026-04-09T01:00:00.000Z');
  });

  it('reactivates a suspended session and returns its held run for execution', async () => {
    const { db, state } = createDbStub({
      sessions: [makeSession({ id: 'session-reactivate', status: 'suspended', suspended_at: '2026-04-09T00:30:00.000Z' })],
      runs: [makeRun({ id: 'run-held', session_id: 'session-reactivate', memo_id: 'memo-1', status: 'held' })],
    });
    const service = new AgentSessionLifecycleService(db as never, { sessionLimit: 1, nowFn: () => new Date('2026-04-09T01:00:00.000Z') });

    const result = await service.transitionSession({
      sessionId: 'session-reactivate',
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'human-1',
      status: 'active',
      reason: 'resume_manual',
    });

    expect(result.session.status).toBe('active');
    expect(result.resumptions).toEqual([{ runId: 'run-held', memoId: 'memo-1', orgId: 'org-1', projectId: 'project-1', agentId: 'agent-1' }]);
    expect(state.runs[0]).toMatchObject({ status: 'running', result_summary: 'Queued run resumed after session was manually reactivated' });
  });

  it('recovers stale running runs, schedules retry, and suspends the crashed session', async () => {
    const retryService = { scheduleRetry: vi.fn(async () => ({ scheduled: true, nextRetryAt: '2026-04-09T01:05:00.000Z' })) };
    const { db, state } = createDbStub({
      sessions: [makeSession({ id: 'session-crash', status: 'active' })],
      runs: [makeRun({ id: 'run-crash', session_id: 'session-crash', started_at: '2026-04-09T00:00:00.000Z', status: 'running' })],
      memories: [{
        org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', session_id: 'session-crash', run_id: 'run-crash', memory_type: 'context', importance: 70, content: 'tool output', created_at: '2026-04-09T00:10:00.000Z',
      }],
    });
    const service = new AgentSessionLifecycleService(db as never, {
      nowFn: () => new Date('2026-04-09T01:00:00.000Z'),
      crashTimeoutMs: 5 * 60 * 1000,
      retryService,
    });

    const result = await service.recoverStaleRuns();

    expect(result).toMatchObject({ recoveredCount: 1, retryScheduledCount: 1, terminatedCount: 0, resumedCount: 0, resumeCandidates: [] });
    expect(retryService.scheduleRetry).toHaveBeenCalledWith('run-crash');
    expect(state.runs[0]).toMatchObject({ status: 'failed', last_error_code: 'session_crash_recovered' });
    expect(state.sessions[0]).toMatchObject({ status: 'suspended' });
  });
});
