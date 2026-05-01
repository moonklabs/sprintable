import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClient, execute } = vi.hoisted(() => ({
  createClient: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('@/services/agent-execution-loop', () => ({
  AgentExecutionLoop: class AgentExecutionLoop {
    execute = execute;
  },
}));

import { POST } from './route';

type QueryPlan = {
  filters: Array<{ column: string; value: unknown }>;
};

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const RETRY_RUN_ID = '22222222-2222-4222-8222-222222222222';
const MEMO_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '44444444-4444-4444-8444-444444444444';
const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const RULE_ID = '77777777-7777-4777-8777-777777777777';

function matchesFilters(row: Record<string, unknown>, filters: QueryPlan['filters']) {
  return filters.every((filter) => row[filter.column] === filter.value);
}

function createBuilder(executor: (plan: QueryPlan) => Promise<{ data: unknown; error: unknown }>) {
  const filters: QueryPlan['filters'] = [];

  const builder = {
    select() { return builder; },
    eq(column: string, value: unknown) { filters.push({ column, value }); return builder; },
    is(column: string, value: unknown) { filters.push({ column, value }); return builder; },
    maybeSingle: async () => executor({ filters }),
    single: async () => executor({ filters }),
    then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => Promise.resolve(executor({ filters })).then(resolve),
  };

  return builder;
}

function createSupabaseStub(options?: {
  run?: Record<string, unknown> | null;
  webhookConfigs?: Array<Record<string, unknown>>;
}) {
  const run = options?.run ?? null;
  const webhookConfigs = options?.webhookConfigs ?? [];

  return {
    from(table: string) {
      if (table === 'agent_runs') {
        return createBuilder(async (plan) => {
          const row = run && matchesFilters(run, plan.filters) ? run : null;
          return { data: row, error: null };
        });
      }

      if (table === 'webhook_configs') {
        return createBuilder(async (plan) => {
          const row = webhookConfigs.find((entry) => matchesFilters(entry, plan.filters)) ?? null;
          return {
            data: row ? { secret: row.secret ?? null } : null,
            error: null,
          };
        });
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function makeRequest(body: Record<string, unknown>, secret?: string) {
  return new Request('http://localhost/api/webhooks/agent-runtime', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-webhook-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/webhooks/agent-runtime', () => {
  beforeEach(() => {
    createClient.mockReset();
    execute.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  it('executes memo.assigned payloads after validating the project webhook secret', async () => {
    createClient.mockReturnValue(createSupabaseStub({
      webhookConfigs: [{
        org_id: ORG_ID,
        member_id: AGENT_ID,
        project_id: PROJECT_ID,
        is_active: true,
        secret: 'project-secret',
      }],
    }));
    execute.mockResolvedValue({ status: 'completed' });

    const response = await POST(makeRequest({
      event: 'memo.assigned',
      data: {
        run_id: RUN_ID,
        memo_id: MEMO_ID,
        project_id: PROJECT_ID,
        org_id: ORG_ID,
        agent_id: AGENT_ID,
        routing: {
          rule_id: RULE_ID,
          auto_reply_mode: 'process_and_report',
          forward_to_agent_id: null,
          original_assigned_to: null,
          target_runtime: 'internal',
          target_model: null,
        },
      },
    }, 'project-secret'));

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({
      runId: RUN_ID,
      memoId: MEMO_ID,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      agentId: AGENT_ID,
      triggerEvent: 'memo.assigned',
      originalRunId: undefined,
      routing: {
        ruleId: RULE_ID,
        autoReplyMode: 'process_and_report',
        forwardToAgentId: null,
        originalAssignedTo: null,
        targetRuntime: 'internal',
        targetModel: null,
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { status: 'completed' },
    });
  });

  it('resolves retry_requested payloads from the resumed run even when memo_id is omitted', async () => {
    createClient.mockReturnValue(createSupabaseStub({
      run: {
        id: RETRY_RUN_ID,
        org_id: ORG_ID,
        project_id: PROJECT_ID,
        memo_id: MEMO_ID,
        agent_id: AGENT_ID,
      },
    }));
    execute.mockResolvedValue({ status: 'completed' });

    const response = await POST(makeRequest({
      event: 'agent_run.retry_requested',
      data: {
        new_run_id: RETRY_RUN_ID,
        original_run_id: RUN_ID,
        agent_id: AGENT_ID,
      },
    }));

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({
      runId: RETRY_RUN_ID,
      memoId: MEMO_ID,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      agentId: AGENT_ID,
      triggerEvent: 'agent_run.retry_requested',
      originalRunId: RUN_ID,
      routing: undefined,
    });
  });

  it('rejects webhook calls with an invalid secret', async () => {
    createClient.mockReturnValue(createSupabaseStub({
      webhookConfigs: [{
        org_id: ORG_ID,
        member_id: AGENT_ID,
        project_id: PROJECT_ID,
        is_active: true,
        secret: 'expected-secret',
      }],
    }));

    const response = await POST(makeRequest({
      event: 'memo.assigned',
      data: {
        run_id: RUN_ID,
        memo_id: MEMO_ID,
        project_id: PROJECT_ID,
        org_id: ORG_ID,
        agent_id: AGENT_ID,
      },
    }, 'wrong-secret'));

    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHORIZED', message: 'Invalid webhook secret' },
    });
  });

  it('returns a webhook error when the resumed run cannot be found', async () => {
    createClient.mockReturnValue(createSupabaseStub({ run: null }));

    const response = await POST(makeRequest({
      event: 'agent_run.retry_requested',
      data: {
        new_run_id: RETRY_RUN_ID,
        agent_id: AGENT_ID,
      },
    }));

    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'WEBHOOK_ERROR', message: 'retry_run_not_found' },
    });
  });
});
