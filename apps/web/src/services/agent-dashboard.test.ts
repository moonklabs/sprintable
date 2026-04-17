import { describe, expect, it } from 'vitest';
import { buildDeploymentCards } from './agent-dashboard';
import { getDeploymentHealthState, getDeploymentRecoveryCueKeys } from './agent-deployment-console';

function createSupabaseStub(options?: {
  deployments?: Array<Record<string, unknown>>;
  agents?: Array<{ id: string; name: string }>;
  personas?: Array<{ id: string; name: string }>;
  runsToday?: Array<Record<string, unknown>>;
  latestRuns?: Array<Record<string, unknown>>;
  latestSuccessfulRuns?: Array<Record<string, unknown>>;
  latestFailedRuns?: Array<Record<string, unknown>>;
  pendingHitlRequests?: Array<Record<string, unknown>>;
  hitlRuns?: Array<Record<string, unknown>>;
}) {
  const deployments = options?.deployments ?? [];
  const agents = options?.agents ?? [];
  const personas = options?.personas ?? [];
  const runsToday = options?.runsToday ?? [];
  const latestRuns = options?.latestRuns ?? [];
  const latestSuccessfulRuns = options?.latestSuccessfulRuns ?? [];
  const latestFailedRuns = options?.latestFailedRuns ?? [];
  const pendingHitlRequests = options?.pendingHitlRequests ?? [];
  const hitlRuns = options?.hitlRuns ?? [];

  const supabase = {
    from(table: string) {
      if (table === 'agent_deployments') {
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          in() { return this; },
          order() { return this; },
          then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: deployments, error: null }).then(resolve);
          },
        };
      }
      if (table === 'team_members') {
        return {
          select() { return this; },
          in() { return this; },
          then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: agents, error: null }).then(resolve);
          },
        };
      }
      if (table === 'agent_personas') {
        return {
          select() { return this; },
          in() { return this; },
          then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: personas, error: null }).then(resolve);
          },
        };
      }
      if (table === 'agent_runs') {
        const state = { isTodayQuery: false, idQuery: false, failedOnly: false, completedOnly: false };
        return {
          select() { return this; },
          in(column: string) {
            if (column === 'id') state.idQuery = true;
            return this;
          },
          eq(column: string, value: unknown) {
            if (column === 'status' && value === 'failed') state.failedOnly = true;
            if (column === 'status' && value === 'completed') state.completedOnly = true;
            return this;
          },
          gte() {
            state.isTodayQuery = true;
            return this;
          },
          order() { return this; },
          then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
            const data = state.idQuery
              ? hitlRuns
              : state.failedOnly
                ? latestFailedRuns
                : state.completedOnly
                  ? latestSuccessfulRuns
                  : (state.isTodayQuery ? runsToday : latestRuns);
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
      }

      if (table === 'agent_hitl_requests') {
        let requestedForFilter: string | null = null;
        return {
          select() { return this; },
          eq(column: string, value: unknown) {
            if (column === 'requested_for') requestedForFilter = String(value);
            return this;
          },
          then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
            const data = requestedForFilter
              ? pendingHitlRequests.filter((request) => request.requested_for === requestedForFilter)
              : pendingHitlRequests;
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return supabase;
}

describe('buildDeploymentCards', () => {
  it('returns empty array when no deployments exist', async () => {
    const supabase = createSupabaseStub();
    const cards = await buildDeploymentCards(supabase as never, 'org-1', 'project-1');
    expect(cards).toEqual([]);
  });

  it('builds cards with agent names, persona names, execution summary, and last run time', async () => {
    const supabase = createSupabaseStub({
      deployments: [
        {
          id: 'dep-1',
          name: 'Support agent',
          status: 'ACTIVE',
          model: 'gpt-4o-mini',
          runtime: 'webhook',
          updated_at: '2026-04-07T08:00:00.000Z',
          agent_id: 'agent-1',
          persona_id: 'persona-1',
        },
        {
          id: 'dep-2',
          name: 'Review agent',
          status: 'SUSPENDED',
          model: 'claude-sonnet-4',
          runtime: 'webhook',
          updated_at: '2026-04-07T07:00:00.000Z',
          agent_id: 'agent-2',
          persona_id: null,
        },
      ],
      agents: [
        { id: 'agent-1', name: 'Sentinel' },
        { id: 'agent-2', name: 'Reviewer' },
      ],
      personas: [
        { id: 'persona-1', name: 'Helpful assistant' },
      ],
      runsToday: [
        { deployment_id: 'dep-1', status: 'completed', input_tokens: 1000, output_tokens: 500 },
        { deployment_id: 'dep-1', status: 'running', input_tokens: 200, output_tokens: 100 },
        { deployment_id: 'dep-2', status: 'completed', input_tokens: 600, output_tokens: 200 },
      ],
      latestRuns: [
        { deployment_id: 'dep-1', finished_at: '2026-04-07T08:30:00.000Z', started_at: '2026-04-07T08:20:00.000Z', created_at: '2026-04-07T08:19:00.000Z' },
        { deployment_id: 'dep-2', finished_at: null, started_at: '2026-04-07T07:10:00.000Z', created_at: '2026-04-07T07:09:00.000Z' },
      ],
    });

    const cards = await buildDeploymentCards(supabase as never, 'org-1', 'project-1');

    expect(cards).toHaveLength(2);

    expect(cards[0]).toMatchObject({
      id: 'dep-1',
      name: 'Support agent',
      status: 'ACTIVE',
      agent_name: 'Sentinel',
      persona_name: 'Helpful assistant',
      executions_today: 2,
      tokens_today: 1800,
      last_run_at: '2026-04-07T08:30:00.000Z',
      latest_successful_run_at: null,
      pending_hitl_count: 0,
      next_hitl_deadline_at: null,
    });

    expect(cards[1]).toMatchObject({
      id: 'dep-2',
      name: 'Review agent',
      status: 'SUSPENDED',
      agent_name: 'Reviewer',
      persona_name: null,
      executions_today: 1,
      tokens_today: 800,
      last_run_at: '2026-04-07T07:10:00.000Z',
      latest_successful_run_at: null,
    });
  });

  it('handles deployments with no runs today', async () => {
    const supabase = createSupabaseStub({
      deployments: [
        {
          id: 'dep-1',
          name: 'Idle agent',
          status: 'ACTIVE',
          model: 'gpt-4o-mini',
          runtime: 'webhook',
          updated_at: '2026-04-07T08:00:00.000Z',
          agent_id: 'agent-1',
          persona_id: null,
        },
      ],
      agents: [{ id: 'agent-1', name: 'Sentinel' }],
      runsToday: [],
      latestRuns: [],
    });

    const cards = await buildDeploymentCards(supabase as never, 'org-1', 'project-1');

    expect(cards[0]).toMatchObject({
      executions_today: 0,
      tokens_today: 0,
      last_run_at: null,
      latest_successful_run_at: null,
    });
  });

  it('aggregates pending HITL requests per deployment', async () => {
    const supabase = createSupabaseStub({
      deployments: [
        {
          id: 'dep-1',
          name: 'Support agent',
          status: 'ACTIVE',
          model: 'gpt-4o-mini',
          runtime: 'webhook',
          updated_at: '2026-04-07T08:00:00.000Z',
          agent_id: 'agent-1',
          persona_id: null,
        },
      ],
      agents: [{ id: 'agent-1', name: 'Sentinel' }],
      pendingHitlRequests: [
        { run_id: 'run-1', requested_for: 'admin-1', expires_at: '2026-04-08T12:00:00.000Z' },
        { run_id: 'run-2', requested_for: 'admin-1', expires_at: '2026-04-08T11:00:00.000Z' },
      ],
      hitlRuns: [
        { id: 'run-1', deployment_id: 'dep-1' },
        { id: 'run-2', deployment_id: 'dep-1' },
      ],
    });

    const cards = await buildDeploymentCards(supabase as never, 'org-1', 'project-1', 'admin-1');

    expect(cards[0]).toMatchObject({
      pending_hitl_count: 2,
      next_hitl_deadline_at: '2026-04-08T11:00:00.000Z',
    });
  });

  it('limits HITL dashboard aggregates to the current admin queue', async () => {
    const supabase = createSupabaseStub({
      deployments: [
        {
          id: 'dep-1',
          name: 'Support agent',
          status: 'ACTIVE',
          model: 'gpt-4o-mini',
          runtime: 'webhook',
          updated_at: '2026-04-07T08:00:00.000Z',
          agent_id: 'agent-1',
          persona_id: null,
        },
      ],
      agents: [{ id: 'agent-1', name: 'Sentinel' }],
      pendingHitlRequests: [
        { run_id: 'run-1', requested_for: 'admin-1', expires_at: '2026-04-08T12:00:00.000Z' },
        { run_id: 'run-2', requested_for: 'admin-2', expires_at: '2026-04-08T11:00:00.000Z' },
      ],
      hitlRuns: [
        { id: 'run-1', deployment_id: 'dep-1' },
        { id: 'run-2', deployment_id: 'dep-1' },
      ],
    });

    const cards = await buildDeploymentCards(supabase as never, 'org-1', 'project-1', 'admin-1');

    expect(cards[0]).toMatchObject({
      pending_hitl_count: 1,
      next_hitl_deadline_at: '2026-04-08T12:00:00.000Z',
    });
  });

  it('keeps retry-exhausted failures active when only a later queued run exists', async () => {
    const supabase = createSupabaseStub({
      deployments: [
        {
          id: 'dep-1',
          name: 'Support agent',
          status: 'ACTIVE',
          model: 'gpt-4o-mini',
          runtime: 'webhook',
          updated_at: '2026-04-12T06:20:00.000Z',
          agent_id: 'agent-1',
          persona_id: null,
        },
      ],
      agents: [{ id: 'agent-1', name: 'Sentinel' }],
      latestRuns: [
        { deployment_id: 'dep-1', finished_at: null, started_at: '2026-04-12T06:10:00.000Z', created_at: '2026-04-12T06:09:00.000Z' },
      ],
      latestSuccessfulRuns: [],
      latestFailedRuns: [
        {
          id: 'run-1',
          deployment_id: 'dep-1',
          memo_id: 'memo-1',
          error_message: 'request timeout',
          last_error_code: 'external_mcp_timeout',
          result_summary: 'Timed out during MCP execution',
          retry_count: 3,
          max_retries: 3,
          next_retry_at: null,
          failure_disposition: 'retry_exhausted',
          finished_at: '2026-04-12T06:00:00.000Z',
          started_at: '2026-04-12T05:55:00.000Z',
          created_at: '2026-04-12T05:54:00.000Z',
        },
      ],
    });

    const cards = await buildDeploymentCards(supabase as never, 'org-1', 'project-1');

    expect(cards[0]).toMatchObject({
      last_run_at: '2026-04-12T06:10:00.000Z',
      latest_successful_run_at: null,
    });
    expect(cards[0]?.latest_failed_run).toMatchObject({
      run_id: 'run-1',
      memo_id: 'memo-1',
      failure_disposition: 'retry_exhausted',
      can_manual_retry: true,
    });
    expect(getDeploymentHealthState(cards[0]!)).toBe('attention');
    expect(getDeploymentRecoveryCueKeys(cards[0]!)).toEqual(['manual_retry']);
  });

  it('clears the failure signal only after a later successful run exists', async () => {
    const supabase = createSupabaseStub({
      deployments: [
        {
          id: 'dep-1',
          name: 'Support agent',
          status: 'ACTIVE',
          model: 'gpt-4o-mini',
          runtime: 'webhook',
          updated_at: '2026-04-12T06:35:00.000Z',
          agent_id: 'agent-1',
          persona_id: null,
        },
      ],
      agents: [{ id: 'agent-1', name: 'Sentinel' }],
      latestRuns: [
        { deployment_id: 'dep-1', finished_at: '2026-04-12T06:30:00.000Z', started_at: '2026-04-12T06:20:00.000Z', created_at: '2026-04-12T06:19:00.000Z' },
      ],
      latestSuccessfulRuns: [
        { deployment_id: 'dep-1', finished_at: '2026-04-12T06:30:00.000Z', started_at: '2026-04-12T06:20:00.000Z', created_at: '2026-04-12T06:19:00.000Z' },
      ],
      latestFailedRuns: [
        {
          id: 'run-2',
          deployment_id: 'dep-1',
          memo_id: 'memo-2',
          error_message: 'older failure',
          last_error_code: 'older_failure',
          result_summary: 'Recovered later',
          retry_count: 3,
          max_retries: 3,
          next_retry_at: null,
          failure_disposition: 'retry_exhausted',
          finished_at: '2026-04-12T06:00:00.000Z',
          started_at: '2026-04-12T05:55:00.000Z',
          created_at: '2026-04-12T05:54:00.000Z',
        },
      ],
    });

    const cards = await buildDeploymentCards(supabase as never, 'org-1', 'project-1');

    expect(cards[0]).toMatchObject({
      last_run_at: '2026-04-12T06:30:00.000Z',
      latest_successful_run_at: '2026-04-12T06:30:00.000Z',
    });
    expect(getDeploymentHealthState(cards[0]!)).toBe('healthy');
    expect(getDeploymentRecoveryCueKeys(cards[0]!)).toEqual([]);
  });

  it('falls back to Agent when agent name not found', async () => {
    const supabase = createSupabaseStub({
      deployments: [
        {
          id: 'dep-1',
          name: 'Orphan',
          status: 'DEPLOY_FAILED',
          model: 'gpt-4o-mini',
          runtime: 'webhook',
          updated_at: '2026-04-07T08:00:00.000Z',
          agent_id: 'deleted-agent',
          persona_id: null,
        },
      ],
      agents: [],
      runsToday: [],
      latestRuns: [],
    });

    const cards = await buildDeploymentCards(supabase as never, 'org-1', 'project-1');
    expect(cards[0]?.agent_name).toBe('Agent');
  });
});
