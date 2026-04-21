import { describe, expect, it, vi } from 'vitest';
import {
  AgentRoutingRuleService,
  buildDisabledRoutingRuleItems,
  createRoutingRuleSnapshotItem,
  getRollbackSnapshotFromRules,
  normalizeRoutingAction,
  normalizeRoutingConditions,
} from './agent-routing-rule';

function createSupabaseStub(
  rules: Array<Record<string, unknown>>,
  options?: { teamMembers?: Array<Record<string, unknown>> },
) {
  const defaultTeamMembers = Array.from(new Set(rules.flatMap((rule) => {
    const ids = [rule.agent_id];
    const action = rule.action && typeof rule.action === 'object' ? rule.action as Record<string, unknown> : null;
    if (action?.forward_to_agent_id) ids.push(action.forward_to_agent_id);
    return ids.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }))).map((id) => ({
    id,
    type: 'agent',
    is_active: true,
  }));
  const teamMembers = options?.teamMembers ?? defaultTeamMembers;

  return {
    from(table: string) {
      if (table === 'agent_routing_rules') {
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          order() { return this; },
          then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
            const ordered = [...rules].sort((a, b) => {
              const priorityCompare = Number(a.priority ?? 0) - Number(b.priority ?? 0);
              if (priorityCompare !== 0) return priorityCompare;
              return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
            });
            return Promise.resolve({ data: ordered, error: null }).then(resolve);
          },
        };
      }

      if (table === 'team_members') {
        let idFilter: string | null = null;
        return {
          select() { return this; },
          eq(column: string, value: unknown) {
            if (column === 'id') idFilter = String(value);
            return this;
          },
          single: async () => {
            const member = teamMembers.find((row) => !idFilter || row.id === idFilter) ?? null;
            return member ? { data: member, error: null } : { data: null, error: new Error('not_found') };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}


function createDisableRulesSupabaseStub({
  rules,
}: {
  rules: Array<Record<string, unknown>>;
}) {
  const update = vi.fn(() => ({
    eq() { return this; },
    is: async () => ({ error: null }),
  }));

  return {
    update,
    supabase: {
      from(table: string) {
        if (table === 'agent_routing_rules') {
          return {
            update,
            select() { return this; },
            eq() { return this; },
            is() { return this; },
            order() { return this; },
            then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
              const disabled = rules.map((rule) => ({ ...rule, is_enabled: false }));
              return Promise.resolve({ data: disabled, error: null }).then(resolve);
            },
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    },
  };
}

function createReplaceRulesSupabaseStub({
  rules,
  rpc,
}: {
  rules: Array<Record<string, unknown>>;
  rpc: ReturnType<typeof vi.fn>;
}) {
  return {
    rpc,
    from(table: string) {
      if (table === 'agent_routing_rules') {
        const state = { id: undefined as string | undefined };
        return {
          select() { return this; },
          eq(column: string, value: string) {
            if (column === 'id') state.id = value;
            return this;
          },
          is() { return this; },
          order() { return this; },
          single: async () => {
            const rule = rules.find((entry) => entry.id === state.id);
            return rule ? { data: rule, error: null } : { data: null, error: new Error('not_found') };
          },
          then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
            const ordered = [...rules].sort((a, b) => {
              const priorityCompare = Number(a.priority ?? 0) - Number(b.priority ?? 0);
              if (priorityCompare !== 0) return priorityCompare;
              return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
            });
            return Promise.resolve({ data: ordered, error: null }).then(resolve);
          },
        };
      }

      if (table === 'team_members') {
        const state = { id: undefined as string | undefined };
        return {
          select() { return this; },
          eq(column: string, value: string) {
            if (column === 'id') state.id = value;
            return this;
          },
          single: async () => ({
            data: state.id ? { id: state.id, type: 'agent', is_active: true } : null,
            error: state.id ? null : new Error('not_found'),
          }),
        };
      }

      if (table === 'agent_personas' || table === 'agent_deployments') {
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          single: async () => ({ data: { id: 'scoped-id' }, error: null }),
        };
      }

      if (table === 'workflow_versions') {
        return {
          insert: async () => ({ error: null }),
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

describe('agent-routing-rule helpers', () => {
  it('normalizes empty conditions and action payloads', () => {
    expect(normalizeRoutingConditions(undefined)).toEqual({ memo_type: [] });
    expect(normalizeRoutingAction(undefined)).toEqual({
      auto_reply_mode: 'process_and_report',
      forward_to_agent_id: null,
    });
  });

  it('drops forward_to_agent_id when auto_reply_mode is process_and_report', () => {
    expect(normalizeRoutingAction({
      auto_reply_mode: 'process_and_report',
      forward_to_agent_id: 'agent-next',
    })).toEqual({
      auto_reply_mode: 'process_and_report',
      forward_to_agent_id: null,
    });
  });

  it('keeps invalid forward mode payloads normalized so policy validation can fail them closed', () => {
    expect(normalizeRoutingAction({
      auto_reply_mode: 'process_and_forward',
    })).toEqual({
      auto_reply_mode: 'process_and_forward',
      forward_to_agent_id: null,
    });
  });
});

describe('AgentRoutingRuleService.reorderPriorities', () => {
  it('uses the atomic reorder rpc and returns the refreshed priority order', async () => {
    const rules = [
      {
        id: 'rule-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'rule-1',
        priority: 5,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_report' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        metadata: {},
        created_by: 'member-1',
        created_at: '2026-04-07T10:00:00.000Z',
        updated_at: '2026-04-07T10:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'rule-2',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-2',
        persona_id: null,
        deployment_id: null,
        name: 'rule-2',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['bug'] },
        action: { auto_reply_mode: 'process_and_report' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        metadata: {},
        created_by: 'member-1',
        created_at: '2026-04-07T10:01:00.000Z',
        updated_at: '2026-04-07T10:01:00.000Z',
        deleted_at: null,
      },
    ];
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const service = new AgentRoutingRuleService({
      rpc,
      from: createSupabaseStub(rules).from,
    } as never);

    const result = await service.reorderPriorities({ orgId: 'org-1', projectId: 'project-1' }, [
      { id: 'rule-1', priority: 5 },
      { id: 'rule-2', priority: 10 },
    ]);

    expect(rpc).toHaveBeenCalledWith('reorder_agent_routing_rules', {
      _org_id: 'org-1',
      _project_id: 'project-1',
      _updates: [
        { id: 'rule-1', priority: 5 },
        { id: 'rule-2', priority: 10 },
      ],
    });
    expect(result.map((rule) => rule.id)).toEqual(['rule-1', 'rule-2']);
  });

  it('surfaces atomic reorder failures without applying a partial service-side patch loop', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: new Error('routing_rule_reorder_scope_mismatch') }));
    const service = new AgentRoutingRuleService({
      rpc,
      from: createSupabaseStub([]).from,
    } as never);

    await expect(service.reorderPriorities({ orgId: 'org-1', projectId: 'project-1' }, [
      { id: 'rule-1', priority: 5 },
      { id: 'rule-2', priority: 10 },
    ])).rejects.toThrow('routing_rule_reorder_scope_mismatch');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('AgentRoutingRuleService.replaceRules', () => {
  it('uses the atomic replace rpc and returns the refreshed workflow snapshot', async () => {
    const rules = [
      {
        id: 'rule-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'rule-1',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        metadata: { auto_generated: true, template_id: 'po-dev' },
        created_by: 'member-1',
        created_at: '2026-04-09T03:00:00.000Z',
        updated_at: '2026-04-09T03:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'rule-2',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-2',
        persona_id: null,
        deployment_id: null,
        name: 'rule-2',
        priority: 20,
        match_type: 'event',
        conditions: { memo_type: [] },
        action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        metadata: {},
        created_by: 'member-1',
        created_at: '2026-04-09T03:01:00.000Z',
        updated_at: '2026-04-09T03:01:00.000Z',
        deleted_at: null,
      },
    ];
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const service = new AgentRoutingRuleService(createReplaceRulesSupabaseStub({ rules, rpc }) as never);

    const result = await service.replaceRules({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      items: [
        {
          id: 'rule-1',
          agent_id: 'agent-1',
          name: 'rule-1',
          priority: 10,
          conditions: { memo_type: ['task'] },
          action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
        },
        {
          agent_id: 'agent-2',
          name: 'rule-2',
          priority: 20,
          conditions: { memo_type: [] },
          action: { auto_reply_mode: 'process_and_report' },
        },
      ],
    });

    expect(rpc).toHaveBeenCalledWith('replace_agent_routing_rules', {
      _org_id: 'org-1',
      _project_id: 'project-1',
      _actor_id: 'member-1',
      _rules: [
        {
          id: 'rule-1',
          agent_id: 'agent-1',
          persona_id: null,
          deployment_id: null,
          name: 'rule-1',
          priority: 10,
          match_type: 'event',
          conditions: { memo_type: ['task'] },
          action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
          target_runtime: 'openclaw',
          target_model: null,
          is_enabled: true,
          metadata: expect.objectContaining({
            auto_generated: false,
            template_id: 'po-dev',
            rollout_saved_at: expect.any(String),
            rollback_snapshot: expect.objectContaining({
              item_count: 2,
              items: [
                createRoutingRuleSnapshotItem(rules[0] as never),
                createRoutingRuleSnapshotItem(rules[1] as never),
              ],
            }),
          }),
        },
        {
          id: null,
          agent_id: 'agent-2',
          persona_id: null,
          deployment_id: null,
          name: 'rule-2',
          priority: 20,
          match_type: 'event',
          conditions: { memo_type: [] },
          action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
          target_runtime: 'openclaw',
          target_model: null,
          is_enabled: true,
          metadata: expect.objectContaining({
            rollout_saved_at: expect.any(String),
            rollback_snapshot: expect.objectContaining({ item_count: 2 }),
          }),
        },
      ],
    });
    expect(result.map((rule) => rule.id)).toEqual(['rule-1', 'rule-2']);
  });

  it('surfaces atomic replace failures without leaving client-side partial mutation loops', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: new Error('routing_rule_replace_scope_mismatch') }));
    const service = new AgentRoutingRuleService(createReplaceRulesSupabaseStub({ rules: [], rpc }) as never);

    await expect(service.replaceRules({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      items: [],
    })).rejects.toThrow('routing_rule_replace_scope_mismatch');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects process_and_forward replacements that omit a forward target instead of silently falling back later', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const service = new AgentRoutingRuleService(createReplaceRulesSupabaseStub({ rules: [], rpc }) as never);

    await expect(service.replaceRules({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      items: [
        {
          agent_id: 'agent-1',
          name: 'broken-forward',
          action: { auto_reply_mode: 'process_and_forward' },
        },
      ],
    })).rejects.toThrow('process_and_forward requires forward_to_agent_id');
    expect(rpc).not.toHaveBeenCalled();
  });
});


describe('routing rollout helpers', () => {
  it('extracts the last rollback snapshot from live rules', () => {
    const snapshot = getRollbackSnapshotFromRules([
      { metadata: {} },
      {
        metadata: {
          rollback_snapshot: {
            saved_at: '2026-04-12T09:00:00.000Z',
            item_count: 1,
            items: [
              {
                agent_id: 'agent-1',
                name: 'restore me',
                priority: 10,
                match_type: 'event',
                conditions: { memo_type: ['task'] },
                action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
                target_runtime: 'openclaw',
                target_model: null,
                is_enabled: true,
              },
            ],
          },
        },
      },
    ]);

    expect(snapshot).toEqual({
      saved_at: '2026-04-12T09:00:00.000Z',
      item_count: 1,
      items: [
        {
          agent_id: 'agent-1',
          persona_id: null,
          deployment_id: null,
          name: 'restore me',
          priority: 10,
          match_type: 'event',
          conditions: { memo_type: ['task'] },
          action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
          target_runtime: 'openclaw',
          target_model: null,
          is_enabled: true,
        },
      ],
    });
  });

  it('creates a disabled clone payload without mutating routing targets', () => {
    const items = buildDisabledRoutingRuleItems([
      {
        id: 'rule-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'triage',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        metadata: { template_id: 'po-dev' },
        created_by: 'member-1',
        created_at: '2026-04-12T09:00:00.000Z',
        updated_at: '2026-04-12T09:00:00.000Z',
      },
    ]);

    expect(items).toEqual([
      {
        id: 'rule-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'triage',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: false,
        metadata: { template_id: 'po-dev' },
      },
    ]);
  });
});

describe('AgentRoutingRuleService.disableRules', () => {
  it('disables all live rules in place so rollback metadata stays intact', async () => {
    const { supabase, update } = createDisableRulesSupabaseStub({
      rules: [
        {
          id: 'rule-1',
          org_id: 'org-1',
          project_id: 'project-1',
          agent_id: 'agent-1',
          persona_id: null,
          deployment_id: null,
          name: 'triage',
          priority: 10,
          match_type: 'event',
          conditions: { memo_type: ['task'] },
          action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
          target_runtime: 'openclaw',
          target_model: null,
          is_enabled: true,
          metadata: {
            rollback_snapshot: {
              saved_at: '2026-04-12T09:00:00.000Z',
              item_count: 1,
              items: [createRoutingRuleSnapshotItem({
                agent_id: 'agent-9',
                name: 'previous',
                priority: 10,
                conditions: { memo_type: [] },
                action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
              })],
            },
          },
          created_by: 'member-1',
          created_at: '2026-04-12T09:30:00.000Z',
          updated_at: '2026-04-12T09:30:00.000Z',
          deleted_at: null,
        },
      ],
    });
    const service = new AgentRoutingRuleService(supabase as never);

    const result = await service.disableRules({ orgId: 'org-1', projectId: 'project-1' });

    expect(update).toHaveBeenCalledWith({ is_enabled: false });
    expect(result).toEqual([
      expect.objectContaining({
        id: 'rule-1',
        is_enabled: false,
        metadata: expect.objectContaining({
          rollback_snapshot: expect.objectContaining({ item_count: 1 }),
        }),
      }),
    ]);
  });
});

describe('AgentRoutingRuleService.evaluateMemo', () => {
  it('picks the first matching rule after sorting by priority ASC', async () => {
    const service = new AgentRoutingRuleService(createSupabaseStub([
      {
        id: 'rule-low',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-low',
        persona_id: null,
        deployment_id: null,
        name: 'low',
        priority: 50,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_report' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        created_by: 'member-1',
        created_at: '2026-04-07T10:00:00.000Z',
        updated_at: '2026-04-07T10:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'rule-high',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-high',
        persona_id: null,
        deployment_id: null,
        name: 'high',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-next' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        created_by: 'member-1',
        created_at: '2026-04-07T10:01:00.000Z',
        updated_at: '2026-04-07T10:01:00.000Z',
        deleted_at: null,
      },
    ]) as never);

    const result = await service.evaluateMemo({
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      memo_type: 'task',
      assigned_to: 'agent-original',
    });

    expect(result.dispatchAgentId).toBe('agent-high');
    expect(result.autoReplyMode).toBe('process_and_forward');
    expect(result.forwardToAgentId).toBe('agent-next');
    expect(result.matchedRule?.id).toBe('rule-high');
  });

  it('treats empty conditions.memo_type as match-all', async () => {
    const service = new AgentRoutingRuleService(createSupabaseStub([
      {
        id: 'rule-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'match-all',
        priority: 10,
        match_type: 'event',
        conditions: {},
        action: { auto_reply_mode: 'process_and_report' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        created_by: 'member-1',
        created_at: '2026-04-07T10:00:00.000Z',
        updated_at: '2026-04-07T10:00:00.000Z',
        deleted_at: null,
      },
    ]) as never);

    const result = await service.evaluateMemo({
      id: 'memo-2',
      org_id: 'org-1',
      project_id: 'project-1',
      memo_type: 'bug',
      assigned_to: 'agent-original',
    });

    expect(result.dispatchAgentId).toBe('agent-1');
    expect(result.matchedRule?.name).toBe('match-all');
  });

  it('falls back to the original assignee when nothing matches', async () => {
    const service = new AgentRoutingRuleService(createSupabaseStub([
      {
        id: 'rule-1',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-1',
        persona_id: null,
        deployment_id: null,
        name: 'task-only',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_report' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        created_by: 'member-1',
        created_at: '2026-04-07T10:00:00.000Z',
        updated_at: '2026-04-07T10:00:00.000Z',
        deleted_at: null,
      },
    ]) as never);

    const result = await service.evaluateMemo({
      id: 'memo-3',
      org_id: 'org-1',
      project_id: 'project-1',
      memo_type: 'bug',
      assigned_to: 'agent-original',
    });

    expect(result.matchedRule).toBeNull();
    expect(result.dispatchAgentId).toBe('agent-original');
    expect(result.forwardToAgentId).toBeNull();
  });

  it('fails closed when a matched process_and_forward rule has no forward target', async () => {
    const service = new AgentRoutingRuleService(createSupabaseStub([
      {
        id: 'rule-broken',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-high',
        persona_id: null,
        deployment_id: null,
        name: 'broken-forward',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: null },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        created_by: 'member-1',
        created_at: '2026-04-07T10:01:00.000Z',
        updated_at: '2026-04-07T10:01:00.000Z',
        deleted_at: null,
      },
    ]) as never);

    await expect(service.evaluateMemo({
      id: 'memo-4',
      org_id: 'org-1',
      project_id: 'project-1',
      memo_type: 'task',
      assigned_to: 'agent-original',
    })).rejects.toThrow('process_and_forward requires forward_to_agent_id');
  });

  it('fails closed when a matched process_and_forward rule drifts to a human forward target', async () => {
    const service = new AgentRoutingRuleService(createSupabaseStub([
      {
        id: 'rule-human-target',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: 'agent-high',
        persona_id: null,
        deployment_id: null,
        name: 'human-forward',
        priority: 10,
        match_type: 'event',
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'human-target' },
        target_runtime: 'openclaw',
        target_model: null,
        is_enabled: true,
        created_by: 'member-1',
        created_at: '2026-04-07T10:02:00.000Z',
        updated_at: '2026-04-07T10:02:00.000Z',
        deleted_at: null,
      },
    ], {
      teamMembers: [
        { id: 'agent-high', type: 'agent', is_active: true },
        { id: 'human-target', type: 'human', is_active: true },
      ],
    }) as never);

    await expect(service.evaluateMemo({
      id: 'memo-5',
      org_id: 'org-1',
      project_id: 'project-1',
      memo_type: 'task',
      assigned_to: 'agent-original',
    })).rejects.toThrow('routing_forward_target_must_be_active_agent');
  });
});
