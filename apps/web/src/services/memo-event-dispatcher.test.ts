import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMemoDispatchKey, buildPollingCursorFilter, MemoEventDispatcher } from './memo-event-dispatcher';

function createDispatcherSupabaseStub(options?: {
  memos?: Array<Record<string, unknown>>;
  teamMembers?: Array<Record<string, unknown>>;
  deployment?: Record<string, unknown> | null;
  projectWebhook?: Record<string, unknown> | null;
  defaultWebhook?: Record<string, unknown> | null;
  runInsertError?: { code?: string; message: string } | null;
  memoQueryThrows?: Error | null;
  routingRules?: Array<Record<string, unknown>>;
}) {
  const state = {
    insertedRuns: [] as Array<Record<string, unknown>>,
    updatedRuns: [] as Array<Record<string, unknown>>,
    auditLogs: [] as Array<Record<string, unknown>>,
  };

  const teamMembers = options?.teamMembers ?? [{
    id: 'agent-1',
    org_id: 'org-1',
    project_id: 'project-1',
    type: 'agent',
    name: 'Didi',
    webhook_url: 'https://agent.example.com/webhook',
    is_active: true,
  }];

  const deployment = options?.deployment ?? {
    id: 'deployment-1',
    model: 'gpt-4o-mini',
    runtime: 'openclaw',
    status: 'ACTIVE',
    config: {},
  };

  const supabase = {
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
    removeChannel: vi.fn().mockResolvedValue(undefined),
    from: vi.fn((table: string) => {
      if (table === 'memos') {
        let cursorUpdatedAt = '0000-01-01T00:00:00.000Z';
        let cursorId = '00000000-0000-0000-0000-000000000000';
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          not: vi.fn(() => builder),
          or: vi.fn((filter: string) => {
            const match = filter.match(/updated_at\.gt\."([^"]+)",and\(updated_at\.eq\."([^"]+)",id\.gt\."([^"]+)"\)/);
            if (match) {
              cursorUpdatedAt = match[1] ?? cursorUpdatedAt;
              cursorId = match[3] ?? cursorId;
            }
            return builder;
          }),
          order: vi.fn(() => builder),
          limit: vi.fn(async (batchSize: number) => {
            if (options?.memoQueryThrows) {
              throw options.memoQueryThrows;
            }
            const data = (options?.memos ?? [])
              .filter((memo) => {
                const updatedAt = String(memo.updated_at ?? '');
                const id = String(memo.id ?? '');
                return updatedAt > cursorUpdatedAt || (updatedAt === cursorUpdatedAt && id > cursorId);
              })
              .sort((a, b) => {
                const updatedAtCompare = String(a.updated_at).localeCompare(String(b.updated_at));
                if (updatedAtCompare !== 0) return updatedAtCompare;
                return String(a.id).localeCompare(String(b.id));
              })
              .slice(0, batchSize);
            return { data, error: null };
          }),
        };
        return builder;
      }

      if (table === 'team_members') {
        let idFilter: string | null = null;
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn((column: string, value: unknown) => {
            if (column === 'id') idFilter = String(value);
            return builder;
          }),
          not: vi.fn(() => builder),
          single: vi.fn(async () => {
            const member = teamMembers.find((row) => !idFilter || row.id === idFilter) ?? null;
            return member ? { data: member, error: null } : { data: null, error: { message: 'not found' } };
          }),
        };
        return builder;
      }

      if (table === 'agent_routing_rules') {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          is: vi.fn(() => builder),
          order: vi.fn(() => builder),
          then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) => Promise.resolve({
            data: options?.routingRules ?? [],
            error: null,
          }).then(resolve),
        };
        return builder;
      }

      if (table === 'agent_deployments') {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          is: vi.fn(() => builder),
          order: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({ data: deployment, error: null })),
        };
        return builder;
      }

      if (table === 'webhook_configs') {
        let mode: 'project' | 'default' = 'project';
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn((column: string, value: unknown) => {
            if (column === 'project_id' && value === 'project-1') mode = 'project';
            return builder;
          }),
          is: vi.fn((column: string) => {
            if (column === 'project_id') mode = 'default';
            return builder;
          }),
          limit: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({
            data: mode === 'project' ? (options?.projectWebhook ?? null) : (options?.defaultWebhook ?? null),
            error: null,
          })),
        };
        return builder;
      }

      if (table === 'agent_runs') {
        return {
          insert: vi.fn((payload: Record<string, unknown>) => {
            state.insertedRuns.push(payload);
            const builder = {
              select: vi.fn(() => builder),
              single: vi.fn(async () => {
                if (options?.runInsertError) {
                  return { data: null, error: options.runInsertError };
                }
                return { data: { id: 'run-1' }, error: null };
              }),
            };
            return builder;
          }),
          update: vi.fn((payload: Record<string, unknown>) => {
            state.updatedRuns.push(payload);
            return {
              eq: vi.fn(async () => ({ error: null })),
            };
          }),
        };
      }

      if (table === 'agent_audit_logs') {
        return {
          insert: vi.fn(async (payload: Record<string, unknown>) => {
            state.auditLogs.push(payload);
            return { error: null };
          }),
        };
      }

      if (table === 'webhook_deliveries') {
        const builder = {
          insert: vi.fn(() => builder),
          select: vi.fn(() => builder),
          update: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          single: vi.fn(async () => ({ data: null, error: { message: 'test_no_delivery_tracking' } })),
          then(resolve: (value: { data: null; error: { message: string } }) => void) {
            return Promise.resolve({ data: null, error: { message: 'test_no_delivery_tracking' } }).then(resolve);
          },
        };
        return builder;
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return { supabase, state };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MemoEventDispatcher', () => {
  it('builds a stable dispatch key', () => {
    expect(buildMemoDispatchKey({ id: 'memo-1', assigned_to: 'agent-1', updated_at: '2026-04-06T10:00:00.000Z' }))
      .toBe('memo:memo-1:assignee:agent-1:updated:2026-04-06T10:00:00.000Z');
  });

  it('skips self-loop memo dispatches', async () => {
    const { supabase, state } = createDispatcherSupabaseStub();
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: vi.fn() as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Loop',
      content: 'self loop',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'agent-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'skipped', reason: 'self_loop_prevented' });
    expect(state.insertedRuns).toHaveLength(0);
  });

  it('dispatches assigned agent memos and completes the run', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const { supabase, state } = createDispatcherSupabaseStub({
      projectWebhook: { url: 'https://agent.example.com/project-webhook', secret: 'secret-1' },
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Do work',
      content: 'ship it',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'dispatched', runId: 'run-1' });
    expect(state.insertedRuns[0]).toMatchObject({
      memo_id: 'memo-1',
      trigger: 'memo_realtime_dispatch',
      dispatch_key: 'memo:memo-1:assignee:agent-1:updated:2026-04-06T10:00:00.000Z',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload).toMatchObject({
      event: 'memo.assigned',
      data: {
        memo_id: 'memo-1',
        agent_name: 'Didi',
      },
    });
    expect(state.updatedRuns).toContainEqual(expect.objectContaining({
      status: 'completed',
      result_summary: 'memo dispatch enqueued',
    }));
  });

  it('preserves runtime-owned execution status when the generic webhook returns an agent execution result', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        status: 'failed',
        llmCallCount: 1,
        toolCallHistory: [],
        outputMemoIds: [],
      },
      error: null,
      meta: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { supabase, state } = createDispatcherSupabaseStub({
      projectWebhook: { url: 'https://agent.example.com/project-webhook', secret: 'secret-1' },
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-runtime-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Do runtime work',
      content: 'ship it',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'failed', reason: 'agent_execution_failed', runId: 'run-1' });
    expect(state.updatedRuns).not.toContainEqual(expect.objectContaining({
      status: 'completed',
      result_summary: 'memo dispatch enqueued',
    }));
  });

  it('formats Discord webhook payloads with embeds', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const { supabase, state } = createDispatcherSupabaseStub({
      projectWebhook: { url: 'https://discord.com/api/webhooks/123/abc', secret: null },
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-discord-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'QA follow-up',
      content: 'Please re-check the latest fix.',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:05:00.000Z',
      created_at: '2026-04-06T10:05:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'dispatched', runId: 'run-1' });
    const payload = JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0]).toMatchObject({
      title: 'QA follow-up',
      description: 'Please re-check the latest fix.',
      color: 0x3B82F6,
      fields: [
        { name: 'Agent', value: 'Didi', inline: true },
        { name: 'Type', value: 'task', inline: true },
      ],
      timestamp: '2026-04-06T10:05:00.000Z',
    });
    expect(payload.sprintable).toBeUndefined();
    expect(state.updatedRuns).toContainEqual(expect.objectContaining({
      status: 'completed',
      result_summary: 'memo dispatch enqueued',
    }));
  });

  it('routes a memo with the first matched rule and includes routing metadata in the webhook payload', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const { supabase, state } = createDispatcherSupabaseStub({
      teamMembers: [
        {
          id: 'agent-1',
          org_id: 'org-1',
          project_id: 'project-1',
          type: 'agent',
          name: 'Original',
          webhook_url: 'https://agent.example.com/webhook',
          is_active: true,
        },
        {
          id: 'agent-2',
          org_id: 'org-1',
          project_id: 'project-1',
          type: 'agent',
          name: 'Router',
          webhook_url: 'https://agent-2.example.com/webhook',
          is_active: true,
        },
      ],
      projectWebhook: { url: 'https://agent.example.com/project-webhook', secret: 'secret-1' },
      routingRules: [
        {
          id: 'rule-1',
          org_id: 'org-1',
          project_id: 'project-1',
          agent_id: 'agent-2',
          persona_id: null,
          deployment_id: null,
          name: 'task-router',
          priority: 1,
          match_type: 'event',
          conditions: { memo_type: ['task'] },
          action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-1' },
          target_runtime: 'openclaw',
          target_model: 'gpt-4o',
          is_enabled: true,
          created_by: 'member-1',
          created_at: '2026-04-06T09:00:00.000Z',
          updated_at: '2026-04-06T09:00:00.000Z',
          deleted_at: null,
        },
      ],
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-2',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Route me',
      content: 'ship it',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'dispatched', runId: 'run-1' });
    expect(state.insertedRuns[0]).toMatchObject({ agent_id: 'agent-2', model: 'gpt-4o' });
    const payload = JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload.data.routing).toMatchObject({
      rule_id: 'rule-1',
      auto_reply_mode: 'process_and_forward',
      forward_to_agent_id: 'agent-1',
      original_assigned_to: 'agent-1',
      target_model: 'gpt-4o',
    });
  });

  it('dispatches a forwarded memo to its assigned next agent without re-matching the same routing rule', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const { supabase, state } = createDispatcherSupabaseStub({
      teamMembers: [
        {
          id: 'agent-1',
          org_id: 'org-1',
          project_id: 'project-1',
          type: 'agent',
          name: 'Original',
          webhook_url: 'https://agent.example.com/webhook',
          is_active: true,
        },
        {
          id: 'agent-2',
          org_id: 'org-1',
          project_id: 'project-1',
          type: 'agent',
          name: 'Router',
          webhook_url: 'https://agent-2.example.com/webhook',
          is_active: true,
        },
      ],
      projectWebhook: { url: 'https://agent.example.com/project-webhook', secret: 'secret-1' },
      routingRules: [
        {
          id: 'rule-1',
          org_id: 'org-1',
          project_id: 'project-1',
          agent_id: 'agent-2',
          persona_id: null,
          deployment_id: null,
          name: 'task-router',
          priority: 1,
          match_type: 'event',
          conditions: { memo_type: ['task'] },
          action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-1' },
          target_runtime: 'openclaw',
          target_model: 'gpt-4o',
          is_enabled: true,
          created_by: 'member-1',
          created_at: '2026-04-06T09:00:00.000Z',
          updated_at: '2026-04-06T09:00:00.000Z',
          deleted_at: null,
        },
      ],
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-forwarded',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Forwarded',
      content: 'next hop',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'agent-2',
      metadata: {
        routing: {
          source_memo_id: 'memo-2',
          matched_rule_id: 'rule-1',
          auto_reply_mode: 'process_and_forward',
        },
      },
      updated_at: '2026-04-06T10:01:00.000Z',
      created_at: '2026-04-06T10:01:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'dispatched', runId: 'run-1' });
    expect(state.insertedRuns[0]).toMatchObject({ agent_id: 'agent-1' });
    const payload = JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload.data.agent_id).toBe('agent-1');
    expect(payload.data.routing).toBeNull();
  });

  it('fails closed when routing resolves to an invalid forward rule instead of silently reporting back to the original assignee', async () => {
    const fetchFn = vi.fn();
    const { supabase, state } = createDispatcherSupabaseStub({
      routingRules: [
        {
          id: 'rule-broken',
          org_id: 'org-1',
          project_id: 'project-1',
          agent_id: 'agent-1',
          persona_id: null,
          deployment_id: null,
          name: 'broken-forward',
          priority: 1,
          match_type: 'event',
          conditions: { memo_type: ['task'] },
          action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: null },
          target_runtime: 'openclaw',
          target_model: null,
          is_enabled: true,
          created_by: 'member-1',
          created_at: '2026-04-06T09:00:00.000Z',
          updated_at: '2026-04-06T09:00:00.000Z',
          deleted_at: null,
        },
      ],
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-broken-forward',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Broken rule',
      content: 'should fail closed',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'skipped', reason: 'routing_forward_target_required' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(state.insertedRuns).toHaveLength(0);
    expect(state.auditLogs).toContainEqual(expect.objectContaining({
      event_type: 'memo_dispatch.routing_policy_blocked',
      severity: 'warn',
      payload: expect.objectContaining({
        error_code: 'routing_forward_target_required',
        rule_id: 'rule-broken',
      }),
    }));
  });

  it('fails closed when a drifted forward target resolves to a human instead of an active agent', async () => {
    const fetchFn = vi.fn();
    const { supabase, state } = createDispatcherSupabaseStub({
      teamMembers: [
        {
          id: 'agent-1',
          org_id: 'org-1',
          project_id: 'project-1',
          type: 'agent',
          name: 'Didi',
          webhook_url: 'https://agent.example.com/webhook',
          is_active: true,
        },
        {
          id: 'human-1',
          org_id: 'org-1',
          project_id: 'project-1',
          type: 'human',
          name: 'Paulo',
          webhook_url: null,
          is_active: true,
        },
      ],
      routingRules: [
        {
          id: 'rule-human-target',
          org_id: 'org-1',
          project_id: 'project-1',
          agent_id: 'agent-1',
          persona_id: null,
          deployment_id: null,
          name: 'human-forward',
          priority: 1,
          match_type: 'event',
          conditions: { memo_type: ['task'] },
          action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'human-1' },
          target_runtime: 'openclaw',
          target_model: null,
          is_enabled: true,
          created_by: 'member-1',
          created_at: '2026-04-06T09:00:00.000Z',
          updated_at: '2026-04-06T09:00:00.000Z',
          deleted_at: null,
        },
      ],
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-human-target',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Human target drift',
      content: 'should fail closed',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'skipped', reason: 'routing_forward_target_must_be_active_agent' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(state.insertedRuns).toHaveLength(0);
    expect(state.auditLogs).toContainEqual(expect.objectContaining({
      event_type: 'memo_dispatch.routing_policy_blocked',
      severity: 'warn',
      payload: expect.objectContaining({
        error_code: 'routing_forward_target_must_be_active_agent',
        rule_id: 'rule-human-target',
        target_agent_id: 'human-1',
      }),
    }));
  });

  it('falls back to the original assignee and logs audit when routing evaluation throws', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const routingRuleService = {
      evaluateMemo: vi.fn(async () => {
        throw new Error('broken_rule_payload');
      }),
    };
    const { supabase, state } = createDispatcherSupabaseStub();
    const dispatcher = new MemoEventDispatcher({
      supabase: supabase as never,
      fetchFn: fetchFn as never,
      routingRuleService,
    });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-3',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Fallback',
      content: 'fallback dispatch',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'dispatched', runId: 'run-1' });
    expect(state.auditLogs.some((log) => log.event_type === 'memo_dispatch.routing_rule_evaluation_failed')).toBe(true);
    expect(state.auditLogs.some((log) => log.event_type === 'memo_dispatch.routing_rule_fallback_to_original_assignee')).toBe(true);
    expect(state.insertedRuns[0]).toMatchObject({ agent_id: 'agent-1' });
  });

  it('logs fallback audit when no routing rule matches and dispatches to the original assignee', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const { supabase, state } = createDispatcherSupabaseStub({
      routingRules: [
        {
          id: 'rule-bug-only',
          org_id: 'org-1',
          project_id: 'project-1',
          agent_id: 'agent-2',
          persona_id: null,
          deployment_id: null,
          name: 'bug-router',
          priority: 1,
          match_type: 'event',
          conditions: { memo_type: ['bug'] },
          action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-1' },
          target_runtime: 'openclaw',
          target_model: null,
          is_enabled: true,
          created_by: 'member-1',
          created_at: '2026-04-06T09:00:00.000Z',
          updated_at: '2026-04-06T09:00:00.000Z',
          deleted_at: null,
        },
      ],
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-4',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'No match',
      content: 'should stay with original assignee',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'dispatched', runId: 'run-1' });
    expect(state.insertedRuns[0]).toMatchObject({ agent_id: 'agent-1' });
    expect(state.auditLogs).toContainEqual(expect.objectContaining({
      event_type: 'memo_dispatch.routing_rule_fallback_to_original_assignee',
      severity: 'info',
      payload: expect.objectContaining({ reason: 'no_matching_rule' }),
    }));
  });

  it('queues dispatch when the deployment is still deploying', async () => {
    const fetchFn = vi.fn();
    const { supabase, state } = createDispatcherSupabaseStub({
      deployment: {
        id: 'deployment-1',
        model: 'gpt-4o-mini',
        runtime: 'openclaw',
        status: 'DEPLOYING',
        config: {},
      },
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Queued',
      content: 'wait for deployment',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'skipped', reason: 'deployment_deploying_queued', runId: 'run-1' });
    expect(state.insertedRuns[0]).toMatchObject({ status: 'queued', started_at: null });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('holds dispatch when the deployment is suspended', async () => {
    const fetchFn = vi.fn();
    const { supabase, state } = createDispatcherSupabaseStub({
      deployment: {
        id: 'deployment-1',
        model: 'gpt-4o-mini',
        runtime: 'openclaw',
        status: 'SUSPENDED',
        config: {},
      },
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Held',
      content: 'wait for resume',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'skipped', reason: 'deployment_suspended_held', runId: 'run-1' });
    expect(state.insertedRuns[0]).toMatchObject({ status: 'held', started_at: null });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('treats unique dispatch key conflicts as duplicates', async () => {
    const { supabase } = createDispatcherSupabaseStub({
      runInsertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: vi.fn() as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Duplicate',
      content: 'already queued',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:00:00.000Z',
      created_at: '2026-04-06T10:00:00.000Z',
    }, 'polling');

    expect(result).toEqual({ status: 'duplicate', reason: 'dispatch_key_conflict' });
  });

  it('keeps generic webhooks on JSON response validation', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const { supabase, state } = createDispatcherSupabaseStub({
      projectWebhook: { url: 'https://agent.example.com/project-webhook', secret: null },
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-generic-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Generic webhook',
      content: 'still expects JSON',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'human-1',
      updated_at: '2026-04-06T10:06:00.000Z',
      created_at: '2026-04-06T10:06:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'failed', reason: 'agent_webhook_invalid_content_type', runId: 'run-1' });
    expect(state.updatedRuns).toContainEqual(expect.objectContaining({
      status: 'failed',
      last_error_code: 'agent_webhook_invalid_content_type',
      result_summary: 'Run failed because the agent webhook did not return JSON',
      error_message: 'ok',
    }));
  });

  it('builds a polling cursor filter that covers same-timestamp boundaries', () => {
    expect(buildPollingCursorFilter('2026-04-06T10:00:00.000Z', 'memo-050')).toBe(
      'updated_at.gt."2026-04-06T10:00:00.000Z",and(updated_at.eq."2026-04-06T10:00:00.000Z",id.gt."memo-050")',
    );
  });

  it('swallows polling exceptions so dispatcher keeps running through Supabase outages', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { supabase, state } = createDispatcherSupabaseStub({
      memoQueryThrows: new Error('Cloudflare 522'),
    });
    const dispatcher = new MemoEventDispatcher({
      supabase: supabase as never,
      fetchFn: vi.fn() as never,
      logger,
    });

    await expect(dispatcher.pollOnce()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith('[MemoEventDispatcher] Polling threw:', 'Cloudflare 522');
    expect(state.insertedRuns).toHaveLength(0);
  });

  it('processes 10 concurrent memo arrivals without blocking routing evaluation', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const routingRuleService = {
      evaluateMemo: vi.fn(async (memo: { assigned_to: string | null }) => ({
        matchedRule: null,
        dispatchAgentId: memo.assigned_to,
        originalAssignedTo: memo.assigned_to,
        autoReplyMode: 'process_and_report' as const,
        forwardToAgentId: null,
      })),
    };
    const { supabase } = createDispatcherSupabaseStub();
    const dispatcher = new MemoEventDispatcher({
      supabase: supabase as never,
      fetchFn: fetchFn as never,
      routingRuleService,
    });

    await Promise.all(Array.from({ length: 10 }, (_, index) => dispatcher.dispatchMemoIfNeeded({
      id: `memo-${index + 1}`,
      org_id: 'org-1',
      project_id: 'project-1',
      title: `Memo ${index + 1}`,
      content: 'concurrent',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: `human-${index + 1}`,
      updated_at: `2026-04-06T10:00:${String(index).padStart(2, '0')}.000Z`,
      created_at: `2026-04-06T10:00:${String(index).padStart(2, '0')}.000Z`,
    }, 'realtime')));

    expect(routingRuleService.evaluateMemo).toHaveBeenCalledTimes(10);
    expect(fetchFn).toHaveBeenCalledTimes(10);
  });

  it('polls missed memos across same-timestamp batch boundaries without dropping any', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const sharedUpdatedAt = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
    const { supabase } = createDispatcherSupabaseStub({
      memos: Array.from({ length: 60 }, (_, index) => ({
        id: `memo-${String(index + 1).padStart(3, '0')}`,
        org_id: 'org-1',
        project_id: 'project-1',
        title: `Memo ${index + 1}`,
        content: `content-${index + 1}`,
        memo_type: 'task',
        status: 'open',
        assigned_to: 'agent-1',
        created_by: `human-${index + 1}`,
        updated_at: sharedUpdatedAt,
        created_at: sharedUpdatedAt,
      })),
    });
    const dispatcher = new MemoEventDispatcher({
      supabase: supabase as never,
      fetchFn: fetchFn as never,
      pollBatchSize: 50,
      initialPollLookbackMs: 24 * 60 * 60 * 1000,
    });

    await dispatcher.pollOnce();
    await dispatcher.pollOnce();

    expect(fetchFn).toHaveBeenCalledTimes(60);
  });

  it('dispatches to BYOA member webhook_url directly without creating agent_runs', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const byoaMember = {
      id: 'byoa-member-1',
      org_id: 'org-1',
      project_id: 'project-1',
      type: 'human',
      name: 'Jay',
      webhook_url: 'https://discord.com/api/webhooks/123/abc',
      is_active: true,
    };
    const { supabase, state } = createDispatcherSupabaseStub({
      teamMembers: [byoaMember],
      deployment: null,
    });
    const dispatcher = new MemoEventDispatcher({ supabase: supabase as never, fetchFn: fetchFn as never });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-byoa-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'BYOA task',
      content: 'hello BYOA',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'byoa-member-1',
      created_by: 'human-sender',
      updated_at: '2026-04-22T10:00:00.000Z',
      created_at: '2026-04-22T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'dispatched' });
    expect(state.insertedRuns).toHaveLength(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('redirects to forwardToAgentId when self-loop is detected', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const routingRuleService = {
      evaluateMemo: vi.fn(async () => ({
        matchedRule: { id: 'rule-kickoff', agent_id: 'agent-po' },
        dispatchAgentId: 'agent-po',
        originalAssignedTo: 'agent-po',
        autoReplyMode: 'process_and_forward',
        forwardToAgentId: 'agent-dev',
      })),
    };
    const { supabase, state } = createDispatcherSupabaseStub({
      teamMembers: [
        {
          id: 'agent-dev',
          org_id: 'org-1',
          project_id: 'project-1',
          type: 'agent',
          name: 'Nwachukwu',
          webhook_url: 'https://agent-dev.example.com/webhook',
          is_active: true,
        },
      ],
    });
    const dispatcher = new MemoEventDispatcher({
      supabase: supabase as never,
      fetchFn: fetchFn as never,
      routingRuleService: routingRuleService as never,
    });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-kickoff-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: '[킥오프] self-loop redirect',
      content: 'kickoff from PO',
      memo_type: 'kickoff',
      status: 'open',
      assigned_to: 'agent-po',
      created_by: 'agent-po',
      updated_at: '2026-04-22T10:00:00.000Z',
      created_at: '2026-04-22T10:00:00.000Z',
    }, 'realtime');

    expect(result).toMatchObject({ status: 'dispatched' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://agent-dev.example.com/webhook',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(state.insertedRuns).toHaveLength(1);
    expect(state.insertedRuns[0]).toMatchObject({ agent_id: 'agent-dev' });
  });

  it('returns self_loop_prevented when self-loop detected and no forwardToAgentId', async () => {
    const fetchFn = vi.fn();
    const routingRuleService = {
      evaluateMemo: vi.fn(async () => ({
        matchedRule: { id: 'rule-no-forward' },
        dispatchAgentId: 'agent-1',
        originalAssignedTo: 'agent-1',
        autoReplyMode: 'process_and_report',
        forwardToAgentId: null,
      })),
    };
    const { supabase } = createDispatcherSupabaseStub();
    const dispatcher = new MemoEventDispatcher({
      supabase: supabase as never,
      fetchFn: fetchFn as never,
      routingRuleService: routingRuleService as never,
    });

    const result = await dispatcher.dispatchMemoIfNeeded({
      id: 'memo-self-loop-1',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'self loop no forward',
      content: 'self loop',
      memo_type: 'task',
      status: 'open',
      assigned_to: 'agent-1',
      created_by: 'agent-1',
      updated_at: '2026-04-22T10:00:00.000Z',
      created_at: '2026-04-22T10:00:00.000Z',
    }, 'realtime');

    expect(result).toEqual({ status: 'skipped', reason: 'self_loop_prevented' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
