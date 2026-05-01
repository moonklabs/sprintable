import { describe, expect, it } from 'vitest';
import { ProjectContextLoader } from './project-context-loader';

interface StubData {
  project?: Record<string, unknown> | null;
  teamMembers?: Array<Record<string, unknown>>;
  memos?: Array<Record<string, unknown>>;
  epics?: Array<Record<string, unknown>>;
  stories?: Array<Record<string, unknown>>;
}

function createContextDbStub(data: StubData, options: { pending?: boolean } = {}) {
  const calls: string[] = [];
  const pendingPromise = new Promise<never>(() => undefined);

  const resolveAsync = <T,>(value: T) => (options.pending ? pendingPromise : Promise.resolve(value));

  const db = {
    from(table: string) {
      calls.push(table);

      if (table === 'projects') {
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          maybeSingle: async () => resolveAsync({ data: data.project ?? null, error: null }),
        };
      }

      if (table === 'team_members') {
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          order() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            return resolveAsync({ data: data.teamMembers ?? [], error: null }).then(resolve);
          },
        };
      }

      if (table === 'memos') {
        let limitCount = 5;
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          order() { return this; },
          limit(count: number) { limitCount = count; return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            return resolveAsync({ data: (data.memos ?? []).slice(0, limitCount), error: null }).then(resolve);
          },
        };
      }

      if (table === 'epics') {
        let limitCount = 5;
        return {
          select() { return this; },
          eq() { return this; },
          neq() { return this; },
          is() { return this; },
          order() { return this; },
          limit(count: number) { limitCount = count; return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            return resolveAsync({ data: (data.epics ?? []).slice(0, limitCount), error: null }).then(resolve);
          },
        };
      }

      if (table === 'stories') {
        let limitCount = 8;
        return {
          select() { return this; },
          eq() { return this; },
          neq() { return this; },
          is() { return this; },
          order() { return this; },
          limit(count: number) { limitCount = count; return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            return resolveAsync({ data: (data.stories ?? []).slice(0, limitCount), error: null }).then(resolve);
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  return { db, calls };
}

describe('ProjectContextLoader', () => {
  it('loads recent memos, open epics/stories, and team composition from the replica client', async () => {
    const primary = createContextDbStub({
      project: { id: 'project-1', name: 'Primary project', description: 'Primary fallback' },
      teamMembers: [{ id: 'agent-1', name: 'Didi', type: 'agent', role: 'member', is_active: true }],
    });
    const replica = createContextDbStub({
      project: { id: 'project-1', name: 'Sprintable', description: 'Prompt runtime delivery project' },
      teamMembers: [
        { id: 'user-1', name: 'Ortega', type: 'human', role: 'owner', is_active: true },
        { id: 'agent-1', name: 'Didi', type: 'agent', role: 'member', is_active: true },
      ],
      memos: [
        { id: 'memo-1', title: 'Recent memo', content: 'Recent memo context', memo_type: 'task', status: 'open', updated_at: '2026-04-06T12:00:00.000Z' },
      ],
      epics: [
        { id: 'epic-1', title: 'Harness & Persona System', status: 'open', priority: 'high', description: 'Agent runtime epic', updated_at: '2026-04-06T12:00:00.000Z' },
      ],
      stories: [
        { id: 'story-1', title: 'Project context loader', status: 'in-progress', priority: 'high', description: 'Load project context safely', updated_at: '2026-04-06T12:00:00.000Z' },
      ],
    });

    const loader = new ProjectContextLoader(primary.db as never, {
      readClient: replica.db as never,
      timeoutMs: 50,
    });

    const result = await loader.load({ orgId: 'org-1', projectId: 'project-1', agentId: 'agent-1' });

    expect(result.meta.source).toBe('replica');
    expect(result.meta.usedFallback).toBe(false);
    expect(result.teamMembers).toHaveLength(2);
    expect(result.summary).toContain('Recent memo');
    expect(result.summary).toContain('Harness & Persona System');
    expect(result.summary).toContain('Project context loader');
    expect(result.meta.tokenCount).toBeLessThanOrEqual(2048);
    expect(replica.calls).toContain('memos');
    expect(replica.calls).toContain('epics');
    expect(replica.calls).toContain('stories');
  });

  it('redacts secrets from memo and summary content before returning prompt context', async () => {
    const primary = createContextDbStub({
      project: { id: 'project-1', name: 'Sprintable', description: 'Primary fallback' },
      teamMembers: [{ id: 'agent-1', name: 'Didi', type: 'agent', role: 'member', is_active: true }],
    });
    const replica = createContextDbStub({
      project: { id: 'project-1', name: 'Sprintable', description: 'Authorization: Bearer topsecret token=abc123' },
      teamMembers: [{ id: 'agent-1', name: 'Didi', type: 'agent', role: 'member', is_active: true }],
      memos: [
        { id: 'memo-1', title: 'Secrets', content: 'OPENAI sk-secretsecret and password=hunter2', memo_type: 'task', status: 'open', updated_at: '2026-04-06T12:00:00.000Z' },
      ],
      epics: [],
      stories: [],
    });

    const loader = new ProjectContextLoader(primary.db as never, {
      readClient: replica.db as never,
      timeoutMs: 50,
    });

    const result = await loader.load({ orgId: 'org-1', projectId: 'project-1', agentId: 'agent-1' });

    expect(result.summary).not.toContain('topsecret');
    expect(result.summary).not.toContain('sk-secretsecret');
    expect(result.summary).not.toContain('hunter2');
    expect(result.project?.description).not.toContain('topsecret');
    expect(result.summary).toContain('[REDACTED]');
  });

  it('falls back to the primary client when the replica times out', async () => {
    const primary = createContextDbStub({
      project: { id: 'project-1', name: 'Sprintable', description: 'Primary fallback project' },
      teamMembers: [{ id: 'agent-1', name: 'Didi', type: 'agent', role: 'member', is_active: true }],
    });
    const replica = createContextDbStub({}, { pending: true });

    const loader = new ProjectContextLoader(primary.db as never, {
      readClient: replica.db as never,
      timeoutMs: 1,
    });

    const result = await loader.load({ orgId: 'org-1', projectId: 'project-1', agentId: 'agent-1' });

    expect(result.meta.source).toBe('primary');
    expect(result.meta.usedFallback).toBe(true);
    expect(result.meta.timedOut).toBe(true);
    expect(result.project?.name).toBe('Sprintable');
    expect(result.summary).toContain('context_loader_fallback: true');
    expect(primary.calls).toContain('projects');
    expect(primary.calls).toContain('team_members');
  });
});
