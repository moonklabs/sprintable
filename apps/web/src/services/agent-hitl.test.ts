import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHitlService, HitlConflictError } from './agent-hitl';
import { ForbiddenError } from './sprint';

const fireWebhooksFn = vi.fn(async () => undefined);

type State = ReturnType<typeof createState>;

type QueryPlan = {
  mode: 'select' | 'update' | 'insert' | 'delete';
  payload: Record<string, unknown> | null;
  filters: Array<{ column: string; value: unknown }>;
  wantSelect: boolean;
};

function createState() {
  return {
    hitlRequests: [
      {
        id: 'hitl-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        deployment_id: 'deployment-1',
        session_id: 'session-1',
        run_id: 'run-hitl-1',
        requested_for: 'admin-1',
        status: 'pending',
        title: 'Need approval',
        prompt: 'Please approve',
        metadata: {
          source_memo_id: 'memo-source-1',
          hitl_memo_id: 'memo-hitl-1',
        },
        response_text: null,
        responded_by: null,
        responded_at: null,
        expired_at: null,
      },
    ] as Array<Record<string, unknown>>,
    runs: [
      {
        id: 'run-hitl-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        deployment_id: 'deployment-1',
        session_id: 'session-1',
        story_id: 'story-1',
        memo_id: 'memo-source-1',
        trigger: 'memo_realtime_dispatch',
        model: 'gpt-4o-mini',
        status: 'hitl_pending',
        result_summary: 'Waiting for HITL',
        finished_at: null,
        last_error_code: null,
        error_message: null,
        max_retries: 3,
        retry_count: 0,
      },
    ] as Array<Record<string, unknown>>,
    memos: [
      {
        id: 'memo-source-1',
        org_id: 'org-1',
        project_id: 'project-1',
        status: 'open',
        resolved_by: null,
        resolved_at: null,
      },
      {
        id: 'memo-hitl-1',
        org_id: 'org-1',
        project_id: 'project-1',
        status: 'open',
        resolved_by: null,
        resolved_at: null,
      },
    ] as Array<Record<string, unknown>>,
    memoReplies: [] as Array<Record<string, unknown>>,
    auditLogs: [] as Array<Record<string, unknown>>,
    nextRunId: 2,
    nextReplyId: 1,
  };
}

function matchesFilters(row: Record<string, unknown>, filters: Array<{ column: string; value: unknown }>) {
  return filters.every((filter) => row[filter.column] === filter.value);
}

function createBuilder(executor: (plan: QueryPlan) => Promise<{ data: unknown; error: unknown }>) {
  let mode: QueryPlan['mode'] = 'select';
  let payload: Record<string, unknown> | null = null;
  const filters: QueryPlan['filters'] = [];
  let wantSelect = false;

  const builder = {
    select() { wantSelect = true; return builder; },
    update(next: Record<string, unknown>) { mode = 'update'; payload = next; return builder; },
    insert(next: Record<string, unknown>) { mode = 'insert'; payload = next; return builder; },
    delete() { mode = 'delete'; payload = null; return builder; },
    eq(column: string, value: unknown) { filters.push({ column, value }); return builder; },
    is(column: string, value: unknown) { filters.push({ column, value }); return builder; },
    maybeSingle: async () => executor({ mode, payload, filters, wantSelect }),
    single: async () => executor({ mode, payload, filters, wantSelect }),
    then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => Promise.resolve(executor({ mode, payload, filters, wantSelect })).then(resolve),
  };

  return builder;
}

function createSupabaseStub(state: State, options?: { failRunTransition?: boolean }) {
  const failRunTransition = options?.failRunTransition ?? false;
  return {
    from(table: string) {
      if (table === 'agent_hitl_requests') {
        return createBuilder(async (plan) => {
          if (plan.mode === 'select') {
            const row = state.hitlRequests.find((entry) => matchesFilters(entry, plan.filters)) ?? null;
            return { data: row, error: null };
          }

          if (plan.mode === 'update') {
            const row = state.hitlRequests.find((entry) => matchesFilters(entry, plan.filters)) ?? null;
            if (!row) return { data: null, error: null };
            Object.assign(row, plan.payload ?? {});
            return { data: plan.wantSelect ? { id: row.id } : null, error: null };
          }

          throw new Error(`Unexpected plan for ${table}: ${plan.mode}`);
        });
      }

      if (table === 'agent_runs') {
        return createBuilder(async (plan) => {
          if (plan.mode === 'select') {
            const row = state.runs.find((entry) => matchesFilters(entry, plan.filters)) ?? null;
            return { data: row, error: null };
          }

          if (plan.mode === 'update') {
            if (failRunTransition && plan.filters.some((filter) => filter.column === 'status' && filter.value === 'hitl_pending')) {
              return { data: null, error: null };
            }
            const row = state.runs.find((entry) => matchesFilters(entry, plan.filters)) ?? null;
            if (!row) return { data: null, error: null };
            Object.assign(row, plan.payload ?? {});
            return { data: plan.wantSelect ? { id: row.id, status: row.status } : null, error: null };
          }

          if (plan.mode === 'insert') {
            const row = {
              id: `run-hitl-resume-${state.nextRunId++}`,
              ...(plan.payload ?? {}),
            } as Record<string, unknown>;
            state.runs.push(row);
            return {
              data: {
                id: row.id as string,
                agent_id: row.agent_id as string,
                story_id: (row.story_id as string | null | undefined) ?? null,
                memo_id: (row.memo_id as string | null | undefined) ?? null,
                model: (row.model as string | null | undefined) ?? null,
                trigger: row.trigger as string,
              },
              error: null,
            };
          }

          if (plan.mode === 'delete') {
            state.runs = state.runs.filter((entry) => !matchesFilters(entry, plan.filters));
            return { data: null, error: null };
          }

          throw new Error(`Unexpected plan for ${table}: ${plan.mode}`);
        });
      }

      if (table === 'memo_replies') {
        return createBuilder(async (plan) => {
          if (plan.mode === 'insert') {
            const row = {
              id: `reply-${state.nextReplyId++}`,
              ...(plan.payload ?? {}),
            };
            state.memoReplies.push(row);
            return { data: { id: row.id }, error: null };
          }

          if (plan.mode === 'delete') {
            state.memoReplies = state.memoReplies.filter((entry) => !matchesFilters(entry, plan.filters));
            return { data: null, error: null };
          }

          throw new Error(`Unexpected plan for ${table}: ${plan.mode}`);
        });
      }

      if (table === 'memos') {
        return createBuilder(async (plan) => {
          if (plan.mode === 'update') {
            const row = state.memos.find((entry) => matchesFilters(entry, plan.filters)) ?? null;
            if (!row) return { data: null, error: null };
            Object.assign(row, plan.payload ?? {});
            return { data: plan.wantSelect ? { id: row.id } : null, error: null };
          }

          if (plan.mode === 'select') {
            const row = state.memos.find((entry) => matchesFilters(entry, plan.filters)) ?? null;
            return { data: row, error: null };
          }

          throw new Error(`Unexpected plan for ${table}: ${plan.mode}`);
        });
      }

      if (table === 'agent_audit_logs') {
        return createBuilder(async (plan) => {
          if (plan.mode === 'insert') {
            state.auditLogs.push(plan.payload ?? {});
            return { data: null, error: null };
          }
          throw new Error(`Unexpected plan for ${table}: ${plan.mode}`);
        });
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

describe('AgentHitlService', () => {
  beforeEach(() => {
    fireWebhooksFn.mockReset();
    fireWebhooksFn.mockResolvedValue(undefined);
  });

  it('approves a pending HITL request, resolves the memo, and resumes the run', async () => {
    const state = createState();
    const supabase = createSupabaseStub(state);
    const service = new AgentHitlService(supabase as never, { fireWebhooksFn, logger: console });

    const result = await service.respond({
      requestId: 'hitl-1',
      actorId: 'admin-1',
      orgId: 'org-1',
      projectId: 'project-1',
      action: 'approve',
      comment: '진행해도 되는',
    });

    expect(result).toMatchObject({
      id: 'hitl-1',
      status: 'approved',
      resumed_run_id: 'run-hitl-resume-2',
      source_memo_id: 'memo-source-1',
      hitl_memo_id: 'memo-hitl-1',
    });
    expect(state.hitlRequests[0]).toMatchObject({
      status: 'approved',
      response_text: '진행해도 되는',
      responded_by: 'admin-1',
    });
    expect(state.runs[0]).toMatchObject({
      id: 'run-hitl-1',
      status: 'completed',
    });
    expect(state.runs[1]).toMatchObject({
      id: 'run-hitl-resume-2',
      parent_run_id: 'run-hitl-1',
      trigger: 'hitl_resume',
      status: 'running',
    });
    expect(state.memos.find((memo) => memo.id === 'memo-hitl-1')).toMatchObject({
      status: 'resolved',
      resolved_by: 'admin-1',
    });
    expect(state.memoReplies).toEqual(expect.arrayContaining([
      expect.objectContaining({ memo_id: 'memo-hitl-1', review_type: 'approve' }),
      expect.objectContaining({ memo_id: 'memo-source-1', review_type: 'comment', content: expect.stringContaining('재개 run ID: run-hitl-resume-2') }),
    ]));
    expect(fireWebhooksFn).toHaveBeenCalledWith(supabase, 'org-1', expect.objectContaining({
      event: 'agent_run.retry_requested',
      data: expect.objectContaining({ new_run_id: 'run-hitl-resume-2', original_run_id: 'run-hitl-1' }),
    }));
  });

  it('rejects a pending HITL request and records the rejection reason', async () => {
    const state = createState();
    const supabase = createSupabaseStub(state);
    const service = new AgentHitlService(supabase as never, { fireWebhooksFn, logger: console });

    const result = await service.respond({
      requestId: 'hitl-1',
      actorId: 'admin-1',
      orgId: 'org-1',
      projectId: 'project-1',
      action: 'reject',
      comment: '사람 검토가 더 필요한',
    });

    expect(result).toMatchObject({
      id: 'hitl-1',
      status: 'rejected',
      resumed_run_id: null,
    });
    expect(state.hitlRequests[0]).toMatchObject({
      status: 'rejected',
      response_text: '사람 검토가 더 필요한',
      responded_by: 'admin-1',
    });
    expect(state.runs[0]).toMatchObject({
      id: 'run-hitl-1',
      status: 'failed',
      last_error_code: 'hitl_rejected',
      error_message: '사람 검토가 더 필요한',
    });
    expect(state.memoReplies).toEqual(expect.arrayContaining([
      expect.objectContaining({ memo_id: 'memo-hitl-1', review_type: 'reject' }),
      expect.objectContaining({ memo_id: 'memo-source-1', content: expect.stringContaining('거부 사유: 사람 검토가 더 필요한') }),
    ]));
    expect(fireWebhooksFn).not.toHaveBeenCalled();
  });

  it('rolls back approval artifacts when the original run transition no longer succeeds', async () => {
    const state = createState();
    const supabase = createSupabaseStub(state, { failRunTransition: true });
    const service = new AgentHitlService(supabase as never, { fireWebhooksFn, logger: console });

    await expect(service.respond({
      requestId: 'hitl-1',
      actorId: 'admin-1',
      orgId: 'org-1',
      projectId: 'project-1',
      action: 'approve',
      comment: '진행해도 되는',
    })).rejects.toBeInstanceOf(HitlConflictError);

    expect(state.hitlRequests[0]).toMatchObject({
      status: 'pending',
      response_text: null,
      responded_by: null,
      responded_at: null,
    });
    expect(state.memos.find((memo) => memo.id === 'memo-hitl-1')).toMatchObject({
      status: 'open',
      resolved_by: null,
      resolved_at: null,
    });
    expect(state.memoReplies).toEqual([]);
    expect(state.runs).toHaveLength(1);
    expect(fireWebhooksFn).not.toHaveBeenCalled();
  });

  it('throws conflict when the request was already processed', async () => {
    const state = createState();
    state.hitlRequests[0]!.status = 'approved';
    const supabase = createSupabaseStub(state);
    const service = new AgentHitlService(supabase as never, { fireWebhooksFn, logger: console });

    await expect(service.respond({
      requestId: 'hitl-1',
      actorId: 'admin-1',
      orgId: 'org-1',
      projectId: 'project-1',
      action: 'approve',
      comment: null,
    })).rejects.toBeInstanceOf(HitlConflictError);
  });

  it('blocks admins who are not assigned to the request', async () => {
    const state = createState();
    const supabase = createSupabaseStub(state);
    const service = new AgentHitlService(supabase as never, { fireWebhooksFn, logger: console });

    await expect(service.respond({
      requestId: 'hitl-1',
      actorId: 'admin-2',
      orgId: 'org-1',
      projectId: 'project-1',
      action: 'approve',
      comment: null,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
