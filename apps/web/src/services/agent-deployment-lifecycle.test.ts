import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fireWebhooks,
  agentExecutionExecute,
  createSupabaseAdminClientMock,
  validateProjectMcpConnectionsMock,
} = vi.hoisted(() => ({
  fireWebhooks: vi.fn(),
  agentExecutionExecute: vi.fn(),
  createSupabaseAdminClientMock: vi.fn(() => ({ tag: 'admin' })),
  validateProjectMcpConnectionsMock: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; errors: string[] }>>(async () => ({ ok: true, errors: [] })),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: createSupabaseAdminClientMock,
}));
vi.mock('./project-mcp', () => ({
  validateProjectMcpConnections: validateProjectMcpConnectionsMock,
}));
vi.mock('./webhook-notify', () => ({ fireWebhooks }));
vi.mock('./agent-execution-loop', () => ({
  AgentExecutionLoop: class {
    execute = agentExecutionExecute;
  },
}));

import { AgentDeploymentLifecycleService } from './agent-deployment-lifecycle';

type DeploymentStatus = 'DEPLOYING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' | 'DEPLOY_FAILED';
type RunStatus = 'queued' | 'held' | 'running' | 'completed' | 'failed';

type DeploymentRecord = {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  persona_id: string | null;
  name: string;
  runtime: string;
  model: string | null;
  version: string | null;
  status: DeploymentStatus;
  config: Record<string, unknown>;
  last_deployed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_detail: Record<string, unknown> | null;
  failed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type RunRecord = {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  deployment_id: string;
  memo_id: string | null;
  status: RunStatus;
  result_summary: string | null;
  last_error_code: string | null;
  error_message: string | null;
  finished_at: string | null;
  created_at: string;
};

function makeDeployment(status: DeploymentStatus): DeploymentRecord {
  return {
    id: 'deployment-1',
    org_id: 'org-1',
    project_id: 'project-1',
    agent_id: 'agent-1',
    persona_id: 'persona-1',
    name: 'Agent runtime',
    runtime: 'webhook',
    model: 'gpt-4o-mini',
    version: 'v1',
    status,
    config: {},
    last_deployed_at: null,
    failure_code: null,
    failure_message: null,
    failure_detail: null,
    failed_at: null,
    created_by: 'admin-1',
    created_at: '2026-04-06T10:00:00.000Z',
    updated_at: '2026-04-06T10:00:00.000Z',
    deleted_at: null,
  };
}

function makeRuns(status: RunStatus, count: number): RunRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `run-${index + 1}`,
    org_id: 'org-1',
    project_id: 'project-1',
    agent_id: 'agent-1',
    deployment_id: 'deployment-1',
    memo_id: `memo-${index + 1}`,
    status,
    result_summary: null,
    last_error_code: null,
    error_message: null,
    finished_at: null,
    created_at: `2026-04-06T10:0${index}:00.000Z`,
  }));
}

function createSupabaseStub(options?: {
  includeBaseDeployment?: boolean;
  duplicateLiveDeployment?: boolean;
  deploymentStatus?: DeploymentStatus;
  queuedRunCount?: number;
  heldRunCount?: number;
  deployments?: DeploymentRecord[];
  teamMembers?: Array<{
    id: string;
    org_id: string;
    project_id: string;
    type: string;
    is_active: boolean;
    name: string;
  }>;
  personas?: Array<{
    id: string;
    org_id: string;
    project_id: string;
    agent_id: string;
    slug: string;
    config: Record<string, unknown> | null;
    is_builtin: boolean;
    deleted_at: string | null;
  }>;
  routingRules?: Array<Record<string, unknown>>;
  persona?: {
    id: string;
    org_id: string;
    project_id: string;
    agent_id: string;
    slug?: string;
    config?: Record<string, unknown> | null;
    is_builtin: boolean;
    deleted_at: string | null;
  };
}) {
  const state = {
    deployments: options?.deployments ?? (options?.includeBaseDeployment ? [makeDeployment(options?.deploymentStatus ?? 'DEPLOYING')] : [] as DeploymentRecord[]),
    runs: [
      ...makeRuns('queued', options?.queuedRunCount ?? 0),
      ...makeRuns('held', options?.heldRunCount ?? 0).map((run, index) => ({ ...run, id: `held-run-${index + 1}`, memo_id: `held-memo-${index + 1}` })),
    ] as RunRecord[],
    createdDeployments: [] as Array<Record<string, unknown>>,
    updatedDeployments: [] as Array<Record<string, unknown>>,
    updatedRuns: [] as Array<Record<string, unknown>>,
    auditLogs: [] as Array<Record<string, unknown>>,
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  };

  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return { data: null, error: null };
    },
    from(table: string) {
      if (table === 'team_members') {
        const members = options?.teamMembers ?? [{
          id: 'agent-1',
          org_id: 'org-1',
          project_id: 'project-1',
          type: 'agent',
          is_active: true,
          name: 'Didi',
        }];
        const filters: { id?: string; orgId?: string; projectId?: string; type?: string; isActive?: boolean } = {};
        const builder = {
          select() { return builder; },
          eq(column: string, value: unknown) {
            if (column === 'id') filters.id = String(value);
            if (column === 'org_id') filters.orgId = String(value);
            if (column === 'project_id') filters.projectId = String(value);
            if (column === 'type') filters.type = String(value);
            if (column === 'is_active') filters.isActive = Boolean(value);
            return builder;
          },
          single: async () => {
            const match = members.find((member) => (!filters.id || member.id === filters.id)
              && (!filters.orgId || member.org_id === filters.orgId)
              && (!filters.projectId || member.project_id === filters.projectId)
              && (!filters.type || member.type === filters.type)
              && (filters.isActive === undefined || member.is_active === filters.isActive));
            return match ? { data: match, error: null } : { data: null, error: new Error('not_found') };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            const data = members.filter((member) => (!filters.id || member.id === filters.id)
              && (!filters.orgId || member.org_id === filters.orgId)
              && (!filters.projectId || member.project_id === filters.projectId)
              && (!filters.type || member.type === filters.type)
              && (filters.isActive === undefined || member.is_active === filters.isActive));
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return builder;
      }

      if (table === 'agent_personas') {
        const personas = options?.personas ?? [{
          id: options?.persona?.id ?? 'persona-1',
          org_id: options?.persona?.org_id ?? 'org-1',
          project_id: options?.persona?.project_id ?? 'project-1',
          agent_id: options?.persona?.agent_id ?? 'agent-1',
          slug: options?.persona?.slug ?? 'developer',
          config: options?.persona?.config ?? {},
          is_builtin: options?.persona?.is_builtin ?? false,
          deleted_at: options?.persona?.deleted_at ?? null,
        }];
        const filters: { id?: string; orgId?: string; deletedAtNull?: boolean; ids?: string[] } = {};

        const builder = {
          select() { return builder; },
          eq(column: string, value: unknown) {
            if (column === 'id') filters.id = String(value);
            if (column === 'org_id') filters.orgId = String(value);
            return builder;
          },
          in(column: string, values: string[]) {
            if (column === 'id') filters.ids = values;
            return builder;
          },
          is(column: string, value: unknown) {
            if (column === 'deleted_at' && value === null) filters.deletedAtNull = true;
            return builder;
          },
          maybeSingle: async () => {
            const match = personas.find((persona) => (!filters.id || filters.id === persona.id)
              && (!filters.orgId || filters.orgId === persona.org_id)
              && (!filters.deletedAtNull || persona.deleted_at === null));
            return { data: match ?? null, error: null };
          },
          single: async () => {
            const result = await builder.maybeSingle();
            return result.data ? result : { data: null, error: new Error('not_found') };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            const data = personas.filter((persona) => (!filters.id || filters.id === persona.id)
              && (!filters.orgId || filters.orgId === persona.org_id)
              && (!filters.deletedAtNull || persona.deleted_at === null)
              && (!filters.ids || filters.ids.includes(persona.id)));
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };

        return builder;
      }

      if (table === 'agent_deployments') {
        let pendingInsert: Record<string, unknown> | null = null;
        let pendingUpdate: Record<string, unknown> | null = null;
        const filters: { id?: string; agentId?: string; excludedId?: string } = {};

        const builder = {
          select() { return builder; },
          insert(payload: Record<string, unknown>) {
            pendingInsert = payload;
            state.createdDeployments.push(payload);
            return builder;
          },
          update(payload: Record<string, unknown>) {
            pendingUpdate = payload;
            state.updatedDeployments.push(payload);
            return builder;
          },
          eq(column: string, value: unknown) {
            if (column === 'id') filters.id = String(value);
            if (column === 'agent_id') filters.agentId = String(value);
            return builder;
          },
          in() { return builder; },
          is() { return builder; },
          neq(column: string, value: unknown) {
            if (column === 'id') filters.excludedId = String(value);
            return builder;
          },
          single: async () => {
            if (pendingInsert) {
              const created = {
                ...makeDeployment('DEPLOYING'),
                ...pendingInsert,
                id: 'deployment-created',
                status: 'DEPLOYING' as DeploymentStatus,
              } satisfies DeploymentRecord;
              state.deployments.push(created);
              return { data: created, error: null };
            }

            const target = filters.id
              ? state.deployments.find((deployment) => deployment.id === filters.id)
              : state.deployments[0];
            if (!target) return { data: null, error: { message: 'not found' } };

            if (pendingUpdate) {
              Object.assign(target, pendingUpdate, { updated_at: '2026-04-06T11:00:00.000Z' });
            }

            return { data: target, error: null };
          },
          then(resolve: (value: { data: DeploymentRecord[]; error: null }) => unknown) {
            const liveDuplicates = options?.duplicateLiveDeployment
              ? [makeDeployment('ACTIVE')].filter((deployment) => deployment.id !== filters.excludedId)
              : state.deployments.filter((deployment) => {
                  const matchesAgent = filters.agentId ? deployment.agent_id === filters.agentId : true;
                  const notExcluded = filters.excludedId ? deployment.id !== filters.excludedId : true;
                  return matchesAgent && notExcluded && deployment.deleted_at === null && ['DEPLOYING', 'ACTIVE', 'SUSPENDED'].includes(deployment.status);
                });
            return Promise.resolve({ data: liveDuplicates, error: null }).then(resolve);
          },
        };

        return builder;
      }

      if (table === 'agent_routing_rules') {
        const routingRules = options?.routingRules ?? [];
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          order() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: routingRules, error: null }).then(resolve);
          },
        };
      }

      if (table === 'agent_runs') {
        let pendingUpdate: Record<string, unknown> | null = null;
        const filters: { deploymentId?: string; statusEq?: RunStatus; statusIn?: RunStatus[] } = {};

        const builder = {
          update(payload: Record<string, unknown>) {
            pendingUpdate = payload;
            state.updatedRuns.push(payload);
            return builder;
          },
          select() { return builder; },
          eq(column: string, value: unknown) {
            if (column === 'deployment_id') filters.deploymentId = String(value);
            if (column === 'status') filters.statusEq = value as RunStatus;
            return builder;
          },
          in(column: string, values: unknown[]) {
            if (column === 'status') filters.statusIn = values as RunStatus[];
            return builder;
          },
          order() { return builder; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            const matches = state.runs.filter((run) => {
              if (filters.deploymentId && run.deployment_id !== filters.deploymentId) return false;
              if (filters.statusEq && run.status !== filters.statusEq) return false;
              if (filters.statusIn && !filters.statusIn.includes(run.status)) return false;
              return true;
            });

            if (pendingUpdate) {
              for (const run of matches) {
                Object.assign(run, pendingUpdate);
              }
              return Promise.resolve({ data: matches.map((run) => ({ id: run.id })), error: null }).then(resolve);
            }

            return Promise.resolve({ data: matches, error: null }).then(resolve);
          },
        };

        return builder;
      }

      if (table === 'agent_audit_logs') {
        return {
          insert: async (payload: Record<string, unknown>) => {
            state.auditLogs.push(payload);
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  return { supabase, state };
}

describe('AgentDeploymentLifecycleService', () => {
  beforeEach(() => {
    fireWebhooks.mockReset();
    fireWebhooks.mockResolvedValue(undefined);
    agentExecutionExecute.mockReset();
    agentExecutionExecute.mockResolvedValue({ status: 'completed', llmCallCount: 1, toolCallHistory: [], outputMemoIds: [] });
    createSupabaseAdminClientMock.mockClear();
    validateProjectMcpConnectionsMock.mockReset();
    validateProjectMcpConnectionsMock.mockResolvedValue({ ok: true, errors: [] });
  });

  it('creates a deployment and activates it after preflight passes', async () => {
    const { supabase, state } = createSupabaseStub();
    const service = new AgentDeploymentLifecycleService(supabase as never);

    const result = await service.createDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      agentId: 'agent-1',
      personaId: 'persona-1',
      name: 'Primary agent deployment',
      runtime: 'webhook',
      model: 'gpt-4o-mini',
      version: 'v1',
      config: {
        schema_version: 1,
        llm_mode: 'managed',
        provider: 'openai',
        scope_mode: 'projects',
        project_ids: ['project-1'],
      },
    });

    expect(state.createdDeployments[0]).toMatchObject({
      status: 'DEPLOYING',
      agent_id: 'agent-1',
      persona_id: 'persona-1',
      name: 'Primary agent deployment',
    });
    expect(result.deployment.status).toBe('ACTIVE');
    expect(result.deployment.last_deployed_at).toEqual(expect.any(String));
    expect(fireWebhooks).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({
      event: 'agent_deployment.initializing',
    }));
    expect(fireWebhooks).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({
      event: 'agent_deployment.activated',
    }));
    expect(state.auditLogs.some((log) => log.event_type === 'agent_deployment.initializing')).toBe(true);
    expect(state.auditLogs.some((log) => log.event_type === 'agent_deployment.activated')).toBe(true);
  });

  it('records post-deploy verification completion on an active deployment', async () => {
    const { supabase, state } = createSupabaseStub({
      includeBaseDeployment: true,
      deploymentStatus: 'ACTIVE',
      deployments: [{
        ...makeDeployment('ACTIVE'),
        config: {
          schema_version: 1,
          llm_mode: 'managed',
          provider: 'openai',
          scope_mode: 'projects',
          project_ids: ['project-1'],
          verification: {
            status: 'pending',
            required_checkpoints: ['dashboard_active', 'routing_reviewed', 'mcp_reviewed'],
            completed_at: null,
            completed_by: null,
          },
        },
      }],
    });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    const result = await service.completeDeploymentVerification({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      deploymentId: 'deployment-1',
    });

    expect(result.deployment.config).toMatchObject({
      verification: expect.objectContaining({
        status: 'completed',
        completed_by: 'admin-1',
        completed_at: expect.any(String),
      }),
    });
    expect(state.auditLogs).toContainEqual(expect.objectContaining({
      event_type: 'agent_deployment.verification_completed',
      payload: expect.objectContaining({
        deployment_id: 'deployment-1',
        verification_status: 'completed',
      }),
    }));
    expect(fireWebhooks).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({
      event: 'agent_deployment.verification_completed',
      data: expect.objectContaining({
        deployment_id: 'deployment-1',
        verification_status: 'completed',
      }),
    }));
  });

  it('applies the automatic PO and Dev routing template when the project mix matches', async () => {
    const { supabase, state } = createSupabaseStub({
      deployments: [{
        id: 'deployment-po',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-2',
        persona_id: 'persona-po',
        name: 'PO deployment',
        runtime: 'webhook',
        model: 'gpt-4o-mini',
        version: 'v1',
        status: 'ACTIVE',
        config: {},
        last_deployed_at: null,
        failure_code: null,
        failure_message: null,
        failure_detail: null,
        failed_at: null,
        created_by: 'admin-1',
        created_at: '2026-04-06T09:00:00.000Z',
        updated_at: '2026-04-06T09:00:00.000Z',
        deleted_at: null,
      }],
      teamMembers: [
        { id: 'agent-1', org_id: 'org-1', project_id: 'project-1', type: 'agent', is_active: true, name: 'Didi' },
        { id: 'agent-2', org_id: 'org-1', project_id: 'project-1', type: 'agent', is_active: true, name: 'Ortega' },
      ],
      personas: [
        { id: 'persona-dev', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', slug: 'developer', config: {}, is_builtin: true, deleted_at: null },
        { id: 'persona-po', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-2', slug: 'product-owner', config: {}, is_builtin: true, deleted_at: null },
      ],
    });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    await service.createDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      agentId: 'agent-1',
      personaId: 'persona-dev',
      name: 'Developer deployment',
    });

    expect(state.rpcCalls).toContainEqual({
      fn: 'replace_agent_routing_rules',
      args: {
        _org_id: 'org-1',
        _project_id: 'project-1',
        _actor_id: 'admin-1',
        _rules: [
          expect.objectContaining({
            agent_id: 'agent-2',
            conditions: { memo_type: ['requirement', 'user_story'] },
            metadata: expect.objectContaining({ auto_generated: true, template_id: 'po-dev' }),
          }),
          expect.objectContaining({
            agent_id: 'agent-1',
            conditions: { memo_type: ['task', 'dev_task'] },
            deployment_id: 'deployment-created',
            metadata: expect.objectContaining({ auto_generated: true, template_id: 'po-dev' }),
          }),
        ],
      },
    });
  });

  it('blocks deployment until overwrite confirmation is provided for automatic routing replacement', async () => {
    const { supabase, state } = createSupabaseStub({
      deployments: [{
        id: 'deployment-po',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-2',
        persona_id: 'persona-po',
        name: 'PO deployment',
        runtime: 'webhook',
        model: 'gpt-4o-mini',
        version: 'v1',
        status: 'ACTIVE',
        config: {},
        last_deployed_at: null,
        failure_code: null,
        failure_message: null,
        failure_detail: null,
        failed_at: null,
        created_by: 'admin-1',
        created_at: '2026-04-06T09:00:00.000Z',
        updated_at: '2026-04-06T09:00:00.000Z',
        deleted_at: null,
      }],
      teamMembers: [
        { id: 'agent-1', org_id: 'org-1', project_id: 'project-1', type: 'agent', is_active: true, name: 'Didi' },
        { id: 'agent-2', org_id: 'org-1', project_id: 'project-1', type: 'agent', is_active: true, name: 'Ortega' },
      ],
      personas: [
        { id: 'persona-dev', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', slug: 'developer', config: {}, is_builtin: true, deleted_at: null },
        { id: 'persona-po', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-2', slug: 'product-owner', config: {}, is_builtin: true, deleted_at: null },
      ],
      routingRules: [{ id: 'rule-1' }],
    });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    await expect(service.createDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      agentId: 'agent-1',
      personaId: 'persona-dev',
      name: 'Developer deployment',
    })).rejects.toMatchObject({
      code: 'DEPLOYMENT_PREFLIGHT_FAILED',
      status: 409,
      details: {
        preflight: {
          ok: false,
          blocking_reasons: ['Existing routing rules require explicit overwrite confirmation before applying an automatic template'],
        },
      },
    });
    expect(state.createdDeployments).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('allows org-scoped custom personas from a different project and agent', async () => {
    const { supabase, state } = createSupabaseStub({
      persona: {
        id: 'persona-org-wide',
        org_id: 'org-1',
        project_id: 'project-2',
        agent_id: 'agent-2',
        is_builtin: false,
        deleted_at: null,
      },
    });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    const result = await service.createDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      agentId: 'agent-1',
      personaId: 'persona-org-wide',
      name: 'Org custom persona deployment',
    });

    expect(state.createdDeployments[0]).toMatchObject({ persona_id: 'persona-org-wide' });
    expect(result.deployment.persona_id).toBe('persona-org-wide');
  });

  it('blocks deployment when a builtin persona is outside the current project or agent scope', async () => {
    const { supabase } = createSupabaseStub({
      persona: {
        id: 'builtin-other-agent',
        org_id: 'org-1',
        project_id: 'project-2',
        agent_id: 'agent-2',
        is_builtin: true,
        deleted_at: null,
      },
    });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    await expect(service.createDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      agentId: 'agent-1',
      personaId: 'builtin-other-agent',
      name: 'Wrong builtin scope deployment',
    })).rejects.toMatchObject({
      code: 'DEPLOYMENT_PREFLIGHT_FAILED',
      status: 409,
      details: {
        preflight: {
          ok: false,
          blocking_reasons: ['Persona not found for this agent in the current project'],
        },
      },
    });
  });

  it('blocks deployment when a live deployment already exists for the agent', async () => {
    const { supabase } = createSupabaseStub({ duplicateLiveDeployment: true });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    await expect(service.createDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      agentId: 'agent-1',
      name: 'Duplicate deployment',
    })).rejects.toMatchObject({
      code: 'DEPLOYMENT_PREFLIGHT_FAILED',
      status: 409,
      details: {
        preflight: {
          ok: false,
          blocking_reasons: ['A live deployment already exists for this agent in the current project'],
        },
      },
    });
  });

  it('blocks deployment creation when preflight MCP validation fails', async () => {
    const { supabase, state } = createSupabaseStub();
    const service = new AgentDeploymentLifecycleService(supabase as never);
    validateProjectMcpConnectionsMock.mockResolvedValue({ ok: false, errors: ['GitHub: external_mcp_http_401'] });

    await expect(service.createDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      agentId: 'agent-1',
      name: 'Broken MCP deployment',
    })).rejects.toMatchObject({
      code: 'DEPLOYMENT_PREFLIGHT_FAILED',
      status: 409,
      details: {
        preflight: {
          ok: false,
          blocking_reasons: ['Managed deployment validation failed for one or more MCP connections'],
          mcp_validation_errors: ['GitHub: external_mcp_http_401'],
        },
      },
    });

    expect(validateProjectMcpConnectionsMock).toHaveBeenCalledWith({ tag: 'admin' }, { projectId: 'project-1' });
    expect(state.createdDeployments).toHaveLength(0);
  });

  it('marks the deployment as DEPLOY_FAILED when activation work fails after insert', async () => {
    const { supabase } = createSupabaseStub();
    const service = new AgentDeploymentLifecycleService(supabase as never);
    fireWebhooks.mockRejectedValueOnce(new Error('webhook_delivery_failed'));

    const result = await service.createDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      agentId: 'agent-1',
      name: 'Activation failure deployment',
    });

    expect(result.deployment.status).toBe('DEPLOY_FAILED');
    expect(result.deployment.failure_code).toBe('deployment_activation_failed');
    expect(result.deployment.failure_message).toBe('Managed deployment activation failed');
    expect(result.deployment.failure_detail).toEqual({ error: 'webhook_delivery_failed' });
    expect(result.deployment.failed_at).toEqual(expect.any(String));
  });

  it('holds queued runs when a deployment is suspended', async () => {
    const { supabase, state } = createSupabaseStub({
      includeBaseDeployment: true,
      deploymentStatus: 'ACTIVE',
      queuedRunCount: 3,
    });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    const result = await service.transitionDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      deploymentId: 'deployment-1',
      status: 'SUSPENDED',
    });

    expect(result.queueHeldCount).toBe(3);
    expect(state.runs.every((run) => run.status === 'held')).toBe(true);
    expect(agentExecutionExecute).not.toHaveBeenCalled();
    expect(fireWebhooks).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({
      event: 'agent_deployment.suspended',
    }));
  });

  it('resumes held runs into actual execution when a suspended deployment becomes active', async () => {
    const { supabase, state } = createSupabaseStub({
      includeBaseDeployment: true,
      deploymentStatus: 'SUSPENDED',
      heldRunCount: 2,
    });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    const result = await service.transitionDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      deploymentId: 'deployment-1',
      status: 'ACTIVE',
    });

    expect(result.queueResumedCount).toBe(2);
    expect(agentExecutionExecute).toHaveBeenCalledTimes(2);
    expect(state.runs.every((run) => run.status === 'running' || run.status === 'completed')).toBe(true);
    expect(fireWebhooks).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({
      event: 'agent_deployment.resumed',
    }));
  });

  it('resumes queued runs created during DEPLOYING when the deployment becomes active', async () => {
    const { supabase } = createSupabaseStub({
      includeBaseDeployment: true,
      deploymentStatus: 'DEPLOYING',
      queuedRunCount: 2,
    });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    const result = await service.transitionDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      deploymentId: 'deployment-1',
      status: 'ACTIVE',
    });

    expect(result.queueResumedCount).toBe(2);
    expect(agentExecutionExecute).toHaveBeenCalledTimes(2);
    expect(fireWebhooks).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({
      event: 'agent_deployment.activated',
    }));
  });

  it('fails queued and held runs when the deployment is terminated', async () => {
    const { supabase, state } = createSupabaseStub({
      includeBaseDeployment: true,
      deploymentStatus: 'ACTIVE',
      queuedRunCount: 2,
      heldRunCount: 1,
    });
    const service = new AgentDeploymentLifecycleService(supabase as never);

    const result = await service.terminateDeployment({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'admin-1',
      deploymentId: 'deployment-1',
    });

    expect(result.queueFailedCount).toBe(3);
    expect(state.runs.every((run) => run.status === 'failed' && run.last_error_code === 'deployment_terminated')).toBe(true);
    expect(fireWebhooks).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({
      event: 'agent_deployment.terminated',
    }));
  });
});
