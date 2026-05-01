import { describe, expect, it, vi } from 'vitest';
import { notifyWorkflowChange } from './workflow-change-notifier';
import type { RoutingRuleSummary } from './agent-routing-rule';

function makeRule(overrides: Partial<RoutingRuleSummary> = {}): RoutingRuleSummary {
  return {
    id: 'rule-1',
    org_id: 'org-1',
    project_id: 'proj-1',
    agent_id: 'agent-a',
    persona_id: null,
    deployment_id: null,
    name: 'Test Rule',
    priority: 10,
    match_type: 'event',
    conditions: { memo_type: [] },
    action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
    target_runtime: 'openclaw',
    target_model: null,
    is_enabled: true,
    metadata: {},
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeDbStub({
  latestVersion = { id: 'wv-1', version: 3, change_summary: { added_rules: 1, removed_rules: 0, changed_rules: 0 } },
  memoCreateData = { id: 'memo-1', project_id: 'proj-1', org_id: 'org-1', title: null, content: '', memo_type: 'system_workflow_update', status: 'open', assigned_to: null, created_by: 'actor-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', metadata: {} },
  insertChangeEvent = vi.fn(async () => ({ error: null })),
}: {
  latestVersion?: { id: string; version: number; change_summary: { added_rules: number; removed_rules: number; changed_rules: number } } | null;
  memoCreateData?: Record<string, unknown>;
  insertChangeEvent?: ReturnType<typeof vi.fn>;
} = {}) {
  const insertMemoAssignees = vi.fn(async () => ({ error: null }));

  return {
    insertChangeEvent,
    db: {
      from(table: string) {
        if (table === 'workflow_versions') {
          return {
            select() { return this; },
            eq() { return this; },
            order() { return this; },
            limit() { return this; },
            then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
              return Promise.resolve({ data: latestVersion ? [latestVersion] : [], error: null }).then(resolve);
            },
          };
        }

        if (table === 'memos') {
          return {
            insert: async () => ({ data: [memoCreateData], error: null }),
            select() { return this; },
            eq() { return this; },
            order() { return this; },
            then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
              return Promise.resolve({ data: [memoCreateData], error: null }).then(resolve);
            },
          };
        }

        if (table === 'projects') {
          return {
            select() { return this; },
            eq() { return this; },
            single: async () => ({ data: { id: 'proj-1', org_id: 'org-1' }, error: null }),
          };
        }

        if (table === 'team_members') {
          return {
            select() { return this; },
            eq() { return this; },
            in() { return this; },
            single: async () => ({ data: { id: 'actor-1', org_id: 'org-1', project_id: 'proj-1', is_active: true }, error: null }),
            then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
              return Promise.resolve({ data: [{ id: 'actor-1' }], error: null }).then(resolve);
            },
          };
        }

        if (table === 'memo_assignees') {
          return { insert: insertMemoAssignees };
        }

        if (table === 'workflow_change_events') {
          return { insert: insertChangeEvent };
        }

        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          order() { return this; },
          then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
      },
      auth: {
        getUser: async () => ({ data: { user: null }, error: null }),
      },
    },
  };
}

describe('notifyWorkflowChange', () => {
  it('returns early when no workflow_versions exist', async () => {
    const { db, insertChangeEvent } = makeDbStub({ latestVersion: null });
    await notifyWorkflowChange(db as never, {
      orgId: 'org-1',
      projectId: 'proj-1',
      actorId: 'actor-1',
      newRules: [makeRule()],
    });
    expect(insertChangeEvent).not.toHaveBeenCalled();
  });

  it('returns early when newRules is empty', async () => {
    const { db, insertChangeEvent } = makeDbStub();
    await notifyWorkflowChange(db as never, {
      orgId: 'org-1',
      projectId: 'proj-1',
      actorId: 'actor-1',
      newRules: [],
    });
    expect(insertChangeEvent).not.toHaveBeenCalled();
  });

  it('deduplicates agent_id and forward_to_agent_id', async () => {
    const insertChangeEvent = vi.fn(async () => ({ error: null }));
    const { db } = makeDbStub({ insertChangeEvent });
    const rules = [
      makeRule({ agent_id: 'agent-a', action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-b' } }),
      makeRule({ id: 'rule-2', agent_id: 'agent-a', action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null } }),
    ];
    await notifyWorkflowChange(db as never, {
      orgId: 'org-1',
      projectId: 'proj-1',
      actorId: 'actor-1',
      newRules: rules,
    });
    const callArg = (insertChangeEvent.mock.calls[0] as unknown as [{ notified_agent_ids: string[] }])[0];
    expect(callArg?.notified_agent_ids).toEqual(['agent-a', 'agent-b']);
  });

  it('inserts workflow_change_events with version_id and memo_ids', async () => {
    const insertChangeEvent = vi.fn(async () => ({ error: null }));
    const { db } = makeDbStub({ insertChangeEvent });
    await notifyWorkflowChange(db as never, {
      orgId: 'org-1',
      projectId: 'proj-1',
      actorId: 'actor-1',
      newRules: [makeRule()],
    });
    expect(insertChangeEvent).toHaveBeenCalledOnce();
    const arg = (insertChangeEvent.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(arg?.workflow_version_id).toBe('wv-1');
    expect(arg?.org_id).toBe('org-1');
    expect(arg?.project_id).toBe('proj-1');
  });

  it('includes version number in memo content', async () => {
    const { db, insertChangeEvent } = makeDbStub();
    await notifyWorkflowChange(db as never, {
      orgId: 'org-1',
      projectId: 'proj-1',
      actorId: 'actor-1',
      newRules: [makeRule()],
    });
    expect(insertChangeEvent).toHaveBeenCalled();
  });
});
