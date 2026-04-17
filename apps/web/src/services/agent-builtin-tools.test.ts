import { describe, expect, it, vi } from 'vitest';
import { AgentBuiltinToolService, BUILTIN_AGENT_TOOL_NAMES } from './agent-builtin-tools';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function createSupabaseStub(seed?: Partial<Tables>) {
  const tables: Tables = {
    projects: [
      { id: 'project-1', org_id: 'org-1', name: 'Alpha', description: 'Alpha project' },
      { id: 'project-2', org_id: 'org-1', name: 'Beta', description: 'Beta project' },
    ],
    team_members: [
      { id: '11111111-1111-4111-8111-111111111111', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Didi', role: 'member', is_active: true },
      { id: '22222222-2222-4222-8222-222222222222', org_id: 'org-1', project_id: 'project-1', type: 'human', name: 'Ortega', role: 'owner', is_active: true },
      { id: '33333333-3333-4333-8333-333333333333', org_id: 'org-1', project_id: 'project-2', type: 'human', name: 'Beta Owner', role: 'owner', is_active: true },
    ],
    memos: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Current memo',
        content: 'Current memo body',
        memo_type: 'task',
        status: 'open',
        assigned_to: '11111111-1111-4111-8111-111111111111',
        created_by: '22222222-2222-4222-8222-222222222222',
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:00:00.000Z',
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Long memo',
        content: 'L'.repeat(2000),
        memo_type: 'memo',
        status: 'open',
        assigned_to: null,
        created_by: '22222222-2222-4222-8222-222222222222',
        created_at: '2026-04-06T11:00:00.000Z',
        updated_at: '2026-04-06T11:00:00.000Z',
      },
    ],
    memo_replies: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        memo_id: '44444444-4444-4444-8444-444444444444',
        content: 'Earlier context',
        created_by: '22222222-2222-4222-8222-222222222222',
        created_at: '2026-04-06T10:05:00.000Z',
      },
    ],
    memo_assignees: [],
    epics: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Alpha epic',
        status: 'open',
        priority: 'high',
        description: 'Alpha epic description',
        created_at: '2026-04-06T09:00:00.000Z',
        updated_at: '2026-04-06T09:00:00.000Z',
        deleted_at: null,
      },
      {
        id: '88888888-8888-4888-8888-888888888888',
        org_id: 'org-1',
        project_id: 'project-2',
        title: 'Beta epic',
        status: 'open',
        priority: 'medium',
        description: 'Beta epic description',
        created_at: '2026-04-06T09:00:00.000Z',
        updated_at: '2026-04-06T09:00:00.000Z',
        deleted_at: null,
      },
    ],
    sprints: [
      { id: '99999999-9999-4999-8999-999999999999', org_id: 'org-1', project_id: 'project-1' },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', org_id: 'org-1', project_id: 'project-2' },
    ],
    stories: [
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Story one',
        status: 'backlog',
        priority: 'medium',
        story_points: 3,
        description: 'Existing story',
        epic_id: '77777777-7777-4777-8777-777777777777',
        sprint_id: null,
        assignee_id: null,
        meeting_id: null,
        created_at: '2026-04-06T08:00:00.000Z',
        updated_at: '2026-04-06T08:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        org_id: 'org-1',
        project_id: 'project-2',
        title: 'Other project story',
        status: 'backlog',
        priority: 'medium',
        story_points: 2,
        description: 'Other story',
        epic_id: '88888888-8888-4888-8888-888888888888',
        sprint_id: null,
        assignee_id: '33333333-3333-4333-8333-333333333333',
        meeting_id: null,
        created_at: '2026-04-06T08:00:00.000Z',
        updated_at: '2026-04-06T08:00:00.000Z',
        deleted_at: null,
      },
    ],
    messaging_bridge_channels: [
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        org_id: 'org-1',
        project_id: 'project-1',
        platform: 'slack',
        channel_id: 'C12345678',
        channel_name: 'team-updates',
        config: {},
        is_active: true,
        created_at: '2026-04-06T12:00:00.000Z',
        updated_at: '2026-04-06T12:00:00.000Z',
      },
    ],
    messaging_bridge_org_auths: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        org_id: 'org-1',
        platform: 'slack',
        access_token_ref: 'env:SLACK_OAUTH_TOKEN_ORG_1',
        expires_at: '2099-01-01T00:00:00.000Z',
        created_by: '22222222-2222-4222-8222-222222222222',
        created_at: '2026-04-06T12:00:00.000Z',
        updated_at: '2026-04-06T12:00:00.000Z',
      },
    ],
    ...(seed ?? {}),
  };

  const makeId = (count: number) => `${String(count).padStart(8, '0')}-0000-4000-8000-${String(count).padStart(12, '0')}`;

  const executeQuery = (table: string, state: {
    filters: Array<(row: Row) => boolean>;
    limitCount: number | null;
    orderBy: { field: string; ascending: boolean } | null;
  }) => {
    let rows = [...(tables[table] ?? [])].filter((row) => state.filters.every((filter) => filter(row)));
    if (state.orderBy) {
      const { field, ascending } = state.orderBy;
      rows.sort((left, right) => {
        const a = left[field];
        const b = right[field];
        if (a === b) return 0;
        return (String(a ?? '').localeCompare(String(b ?? ''))) * (ascending ? 1 : -1);
      });
    }
    if (state.limitCount != null) rows = rows.slice(0, state.limitCount);
    return rows;
  };

  const supabase = {
    from(table: string) {
      const state = {
        filters: [] as Array<(row: Row) => boolean>,
        limitCount: null as number | null,
        orderBy: null as { field: string; ascending: boolean } | null,
        pendingInsert: null as Row | null,
        pendingUpdate: null as Row | null,
      };

      const query = {
        select() { return query; },
        insert(payload: Row) { state.pendingInsert = payload; return query; },
        update(payload: Row) { state.pendingUpdate = payload; return query; },
        eq(field: string, value: unknown) { state.filters.push((row) => row[field] === value); return query; },
        neq(field: string, value: unknown) { state.filters.push((row) => row[field] !== value); return query; },
        is(field: string, value: unknown) { state.filters.push((row) => row[field] === value); return query; },
        in(field: string, values: unknown[]) { state.filters.push((row) => values.includes(row[field])); return query; },
        order(field: string, options?: { ascending?: boolean }) { state.orderBy = { field, ascending: options?.ascending ?? true }; return query; },
        limit(count: number) { state.limitCount = count; return query; },
        async maybeSingle() {
          if (state.pendingInsert) {
            const row = { id: makeId(tables[table].length + 1), created_at: '2026-04-07T00:00:00.000Z', updated_at: '2026-04-07T00:00:00.000Z', ...state.pendingInsert };
            tables[table].push(row);
            return { data: row, error: null };
          }
          const rows = executeQuery(table, state);
          return { data: rows[0] ?? null, error: null };
        },
        async single() {
          if (state.pendingInsert) {
            const row = { id: makeId(tables[table].length + 1), created_at: '2026-04-07T00:00:00.000Z', updated_at: '2026-04-07T00:00:00.000Z', ...state.pendingInsert };
            tables[table].push(row);
            return { data: row, error: null };
          }

          const rows = executeQuery(table, state);
          const target = rows[0];
          if (!target) return { data: null, error: { message: `${table} not found` } };

          if (state.pendingUpdate) {
            Object.assign(target, state.pendingUpdate, { updated_at: '2026-04-07T00:05:00.000Z' });
          }

          return { data: target, error: null };
        },
        then(resolve: (value: { data: Row[]; error: null }) => unknown) {
          if (state.pendingUpdate) {
            executeQuery(table, state).forEach((row) => Object.assign(row, state.pendingUpdate, { updated_at: '2026-04-07T00:05:00.000Z' }));
          }
          return Promise.resolve({ data: executeQuery(table, state), error: null }).then(resolve);
        },
      };

      return query;
    },
  };

  return { supabase, tables };
}

function createContext() {
  return {
    memo: {
      id: '44444444-4444-4444-8444-444444444444',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Current memo',
      content: 'Current memo body',
      memo_type: 'task',
      status: 'open',
      assigned_to: '11111111-1111-4111-8111-111111111111',
      created_by: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
    },
    agent: {
      id: '11111111-1111-4111-8111-111111111111',
      org_id: 'org-1',
      project_id: 'project-1',
      name: 'Didi',
    },
    runId: 'run-1',
    sessionId: 'session-1',
  };
}

describe('AgentBuiltinToolService', () => {
  it('creates a memo and records execution audit metadata', async () => {
    const { supabase, tables } = createSupabaseStub();
    const auditLogger = vi.fn(async () => undefined);
    const service = new AgentBuiltinToolService(supabase as never, { auditLogger });

    const result = await service.execute('create_memo', {
      title: 'New memo',
      content: 'Please follow up on this action item.',
      assigned_to: '22222222-2222-4222-8222-222222222222',
    }, createContext());

    expect(result).toEqual({
      memo: expect.objectContaining({ title: 'New memo', assigned_to: '22222222-2222-4222-8222-222222222222', memo_type: 'memo' }),
    });
    expect(tables.memos).toHaveLength(3);
    expect(auditLogger).toHaveBeenCalledWith(
      'agent_tool.executed',
      'info',
      expect.objectContaining({
        tool_name: 'create_memo',
        tool_source: 'builtin',
        outcome: 'allowed',
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: '11111111-1111-4111-8111-111111111111',
      }),
    );
  });

  it('calls notify_slack with org auth, registered channel, and audit metadata', async () => {
    process.env.SLACK_OAUTH_TOKEN_ORG_1 = 'xoxb-org-token';
    const { supabase } = createSupabaseStub();
    const auditLogger = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, channel: 'C12345678', ts: '1710000000.000100' }), { status: 200 }));
    const service = new AgentBuiltinToolService(supabase as never, { auditLogger, fetchFn: fetchFn as never });

    const result = await service.execute('notify_slack', {
      channel_id: 'C12345678',
      message: 'Deploy finished',
      thread_ts: '1710000000.000001',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Deploy finished*' } }],
    }, createContext());

    expect(result).toEqual({
      ok: true,
      channel_id: 'C12345678',
      message_ts: '1710000000.000100',
      thread_ts: '1710000000.000001',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('https://slack.com/api/chat.postMessage', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer xoxb-org-token' }),
    }));
    expect(auditLogger).toHaveBeenCalledWith(
      'mcp_tool.call',
      'info',
      expect.objectContaining({
        org_id: 'org-1',
        project_id: 'project-1',
        agent_id: '11111111-1111-4111-8111-111111111111',
        action_type: 'mcp_tool.call',
        resource_type: 'slack_channel',
        resource_id: 'C12345678',
      }),
    );
    delete process.env.SLACK_OAUTH_TOKEN_ORG_1;
  });

  it('returns channel_not_registered when notify_slack targets an unregistered channel', async () => {
    process.env.SLACK_OAUTH_TOKEN_ORG_1 = 'xoxb-org-token';
    const { supabase } = createSupabaseStub({ messaging_bridge_channels: [] });
    const fetchFn = vi.fn();
    const service = new AgentBuiltinToolService(supabase as never, { fetchFn: fetchFn as never });

    const result = await service.execute('notify_slack', {
      channel_id: 'C404',
      message: 'hello',
    }, createContext());

    expect(result).toEqual({ error: 'channel_not_registered' });
    expect(fetchFn).not.toHaveBeenCalled();
    delete process.env.SLACK_OAUTH_TOKEN_ORG_1;
  });

  it('returns slack_auth_required when org slack auth is missing or expired', async () => {
    const { supabase: missingAuthSupabase } = createSupabaseStub({ messaging_bridge_org_auths: [] });
    const missingAuthService = new AgentBuiltinToolService(missingAuthSupabase as never, { fetchFn: vi.fn() as never });

    await expect(missingAuthService.execute('notify_slack', {
      channel_id: 'C12345678',
      message: 'hello',
    }, createContext())).resolves.toEqual({ error: 'slack_auth_required' });

    process.env.SLACK_OAUTH_TOKEN_ORG_1 = 'xoxb-expired';
    const { supabase: expiredAuthSupabase } = createSupabaseStub({
      messaging_bridge_org_auths: [{
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        org_id: 'org-1',
        platform: 'slack',
        access_token_ref: 'env:SLACK_OAUTH_TOKEN_ORG_1',
        expires_at: '2000-01-01T00:00:00.000Z',
        created_by: '22222222-2222-4222-8222-222222222222',
        created_at: '2026-04-06T12:00:00.000Z',
        updated_at: '2026-04-06T12:00:00.000Z',
      }],
    });
    const expiredAuthService = new AgentBuiltinToolService(expiredAuthSupabase as never, { fetchFn: vi.fn() as never });

    await expect(expiredAuthService.execute('notify_slack', {
      channel_id: 'C12345678',
      message: 'hello',
    }, createContext())).resolves.toEqual({ error: 'slack_auth_required' });
    delete process.env.SLACK_OAUTH_TOKEN_ORG_1;
  });

  it('returns Slack API errors when the bot is not in the target channel', async () => {
    process.env.SLACK_OAUTH_TOKEN_ORG_1 = 'xoxb-org-token';
    const { supabase } = createSupabaseStub();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), { status: 200 }));
    const service = new AgentBuiltinToolService(supabase as never, { fetchFn: fetchFn as never });

    const result = await service.execute('notify_slack', {
      channel_id: 'C12345678',
      message: 'hello',
    }, createContext());

    expect(result).toEqual({ error: 'not_in_channel' });
    delete process.env.SLACK_OAUTH_TOKEN_ORG_1;
  });

  it('lists memos with truncated content previews', async () => {
    const { supabase } = createSupabaseStub();
    const service = new AgentBuiltinToolService(supabase as never);

    const result = await service.execute('list_memos', { limit: 2 }, createContext());

    expect(Array.isArray(result.memos)).toBe(true);
    expect(result.memos).toHaveLength(2);
    expect(String((result.memos as Array<Record<string, unknown>>)[0].content).length).toBeDefined();
    expect(String((result.memos as Array<Record<string, unknown>>)[0].content).length).not.toBe('2000');
    expect(String((result.memos as Array<Record<string, unknown>>)[0].content).length).toBeLessThanOrEqual(480);
  });

  it('applies list_memos filters before limit so filtered rows are not dropped', async () => {
    const { supabase } = createSupabaseStub({
      memos: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          org_id: 'org-1',
          project_id: 'project-1',
          title: 'Newest open memo',
          content: 'open memo 1',
          memo_type: 'task',
          status: 'open',
          assigned_to: null,
          created_by: '22222222-2222-4222-8222-222222222222',
          created_at: '2026-04-06T12:00:00.000Z',
          updated_at: '2026-04-06T12:00:00.000Z',
        },
        {
          id: '55555555-5555-4555-8555-555555555555',
          org_id: 'org-1',
          project_id: 'project-1',
          title: 'Second open memo',
          content: 'open memo 2',
          memo_type: 'task',
          status: 'open',
          assigned_to: null,
          created_by: '22222222-2222-4222-8222-222222222222',
          created_at: '2026-04-06T11:00:00.000Z',
          updated_at: '2026-04-06T11:00:00.000Z',
        },
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          org_id: 'org-1',
          project_id: 'project-1',
          title: 'Older resolved memo',
          content: 'resolved memo',
          memo_type: 'task',
          status: 'resolved',
          assigned_to: null,
          created_by: '22222222-2222-4222-8222-222222222222',
          created_at: '2026-04-06T10:00:00.000Z',
          updated_at: '2026-04-06T10:00:00.000Z',
        },
      ],
    });
    const service = new AgentBuiltinToolService(supabase as never);

    const result = await service.execute('list_memos', { limit: 2, status: 'resolved' }, createContext());

    expect(result.memos).toEqual([
      expect.objectContaining({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'resolved', title: 'Older resolved memo' }),
    ]);
  });

  it('blocks cross-project references and logs a security audit event', async () => {
    const { supabase } = createSupabaseStub();
    const auditLogger = vi.fn(async () => undefined);
    const service = new AgentBuiltinToolService(supabase as never, { auditLogger });

    const result = await service.execute('create_story', {
      title: 'Cross project attempt',
      epic_id: '88888888-8888-4888-8888-888888888888',
    }, createContext());

    expect(result).toEqual({ error: 'epic_id outside current project scope' });
    expect(auditLogger).toHaveBeenCalledWith(
      'agent_tool.cross_scope_blocked',
      'security',
      expect.objectContaining({
        tool_name: 'epic_scope_check',
        tool_source: 'builtin',
        outcome: 'denied',
        epic_id: '88888888-8888-4888-8888-888888888888',
        operator_reason: 'The builtin tool referenced an epic whose org/project scope does not match the active memo context.',
      }),
    );
  });

  it('creates and assigns a story within the current project scope', async () => {
    const { supabase, tables } = createSupabaseStub();
    const service = new AgentBuiltinToolService(supabase as never);

    const created = await service.execute('create_story', {
      title: 'Implement MCP tool',
      epic_id: '77777777-7777-4777-8777-777777777777',
      assignee_id: '22222222-2222-4222-8222-222222222222',
      priority: 'high',
      status: 'backlog',
      story_points: 5,
    }, createContext());

    const createdStoryId = (created.story as Record<string, unknown>).id as string;
    const assigned = await service.execute('assign_story', {
      story_id: createdStoryId,
      assignee_id: '11111111-1111-4111-8111-111111111111',
    }, createContext());

    expect(created.story).toEqual(expect.objectContaining({ title: 'Implement MCP tool', assignee_id: '22222222-2222-4222-8222-222222222222' }));
    expect(assigned.story).toEqual(expect.objectContaining({ assignee_id: '11111111-1111-4111-8111-111111111111' }));
    expect(tables.stories.some((story) => story.id === createdStoryId && story.assignee_id === '11111111-1111-4111-8111-111111111111')).toBe(true);
  });

  it('forward_memo is in BUILTIN_AGENT_TOOL_NAMES', () => {
    expect(BUILTIN_AGENT_TOOL_NAMES).toContain('forward_memo');
  });

  it('forwards a memo to another agent successfully', async () => {
    const { supabase, tables } = createSupabaseStub({
      team_members: [
        { id: '11111111-1111-4111-8111-111111111111', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Didi', role: 'member', is_active: true },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Kiki', role: 'member', is_active: true },
        { id: '22222222-2222-4222-8222-222222222222', org_id: 'org-1', project_id: 'project-1', type: 'human', name: 'Ortega', role: 'owner', is_active: true },
      ],
    });
    const auditLogger = vi.fn(async () => undefined);
    const service = new AgentBuiltinToolService(supabase as never, { auditLogger });

    const result = await service.execute('forward_memo', {
      target_agent_display_name: 'Kiki',
      content: 'Please handle this task.',
      memo_type: 'task',
    }, createContext());

    expect(result).toEqual({
      memo: expect.objectContaining({
        assigned_to: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        content: 'Please handle this task.',
        memo_type: 'task',
      }),
    });
    const created = tables.memos.find((m) => m.assigned_to === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(created).toBeDefined();
    expect(created?.metadata).toEqual({ forwarded_from_memo_id: '44444444-4444-4444-8444-444444444444' });
    expect(created?.created_by).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('returns self_forward_not_allowed when forwarding to self', async () => {
    const { supabase } = createSupabaseStub();
    const service = new AgentBuiltinToolService(supabase as never);

    const result = await service.execute('forward_memo', {
      target_agent_display_name: 'Didi',
      content: 'Self forward attempt.',
    }, createContext());

    expect(result).toEqual({ error: 'self_forward_not_allowed' });
  });

  it('forwards correctly when duplicate name includes self and one other agent', async () => {
    const { supabase, tables } = createSupabaseStub({
      team_members: [
        { id: '11111111-1111-4111-8111-111111111111', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Didi', role: 'member', is_active: true },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Didi', role: 'member', is_active: true },
        { id: '22222222-2222-4222-8222-222222222222', org_id: 'org-1', project_id: 'project-1', type: 'human', name: 'Ortega', role: 'owner', is_active: true },
      ],
    });
    const service = new AgentBuiltinToolService(supabase as never);

    const result = await service.execute('forward_memo', {
      target_agent_display_name: 'Didi',
      content: 'Forward to the other Didi.',
    }, createContext());

    // Should forward to the non-self Didi, not return self_forward_not_allowed
    expect(result).toEqual({
      memo: expect.objectContaining({
        assigned_to: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        content: 'Forward to the other Didi.',
      }),
    });
    const created = tables.memos.find((m) => m.assigned_to === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(created).toBeDefined();
  });

  it('returns target_agent_not_found when multiple non-self agents share the same name', async () => {
    const { supabase } = createSupabaseStub({
      team_members: [
        { id: '11111111-1111-4111-8111-111111111111', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Didi', role: 'member', is_active: true },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Kiki', role: 'member', is_active: true },
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Kiki', role: 'member', is_active: true },
      ],
    });
    const service = new AgentBuiltinToolService(supabase as never);

    const result = await service.execute('forward_memo', {
      target_agent_display_name: 'Kiki',
      content: 'Ambiguous forward.',
    }, createContext());

    // Ambiguous: two different agents named Kiki — refuse to route
    expect(result).toEqual({ error: 'target_agent_not_found' });
  });

  it('returns target_agent_not_found when no matching agent exists', async () => {
    const { supabase } = createSupabaseStub();
    const service = new AgentBuiltinToolService(supabase as never);

    const result = await service.execute('forward_memo', {
      target_agent_display_name: 'NonexistentAgent',
      content: 'Forward to unknown.',
    }, createContext());

    expect(result).toEqual({ error: 'target_agent_not_found' });
  });

  it('blocks forwarding when chain exceeds 10 hops and records audit log', async () => {
    // Build a chain of 10 forwarded memos
    const chainMemos = Array.from({ length: 10 }, (_, i) => ({
      id: `chain-${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`,
      org_id: 'org-1',
      project_id: 'project-1',
      title: `Chain memo ${i}`,
      content: `chain ${i}`,
      memo_type: 'task',
      status: 'open',
      assigned_to: '11111111-1111-4111-8111-111111111111',
      created_by: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
      metadata: i > 0
        ? { forwarded_from_memo_id: `chain-${String(i - 1).padStart(4, '0')}-0000-4000-8000-000000000000` }
        : {},
    }));
    // The "current" memo is the last in the chain, also with forwarded_from pointing to previous
    const currentMemo = {
      id: '44444444-4444-4444-8444-444444444444',
      org_id: 'org-1',
      project_id: 'project-1',
      title: 'Current memo',
      content: 'Current memo body',
      memo_type: 'task',
      status: 'open',
      assigned_to: '11111111-1111-4111-8111-111111111111',
      created_by: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
      metadata: { forwarded_from_memo_id: chainMemos[9].id },
    };

    const { supabase } = createSupabaseStub({
      memos: [...chainMemos, currentMemo],
      team_members: [
        { id: '11111111-1111-4111-8111-111111111111', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Didi', role: 'member', is_active: true },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', org_id: 'org-1', project_id: 'project-1', type: 'agent', name: 'Kiki', role: 'member', is_active: true },
      ],
    });
    const auditLogger = vi.fn(async () => undefined);
    const service = new AgentBuiltinToolService(supabase as never, { auditLogger });

    const result = await service.execute('forward_memo', {
      target_agent_display_name: 'Kiki',
      content: 'This should be blocked.',
    }, createContext());

    expect(result).toEqual({ error: 'forward_chain_limit_exceeded' });
    expect(auditLogger).toHaveBeenCalledWith(
      'forward_chain_exceeded',
      'warn',
      expect.objectContaining({
        tool_name: 'forward_memo',
        memo_id: '44444444-4444-4444-8444-444444444444',
        chain_length: 10,
      }),
    );
  });

  it('updates memo content and lists epics in scope', async () => {
    const { supabase, tables } = createSupabaseStub();
    const service = new AgentBuiltinToolService(supabase as never);

    const updated = await service.execute('update_memo', {
      memo_id: '44444444-4444-4444-8444-444444444444',
      content: 'Updated memo body for the current project.',
      status: 'resolved',
    }, createContext());
    const epics = await service.execute('list_epics', { limit: 5 }, createContext());

    expect(updated.memo).toEqual(expect.objectContaining({ status: 'resolved', content: 'Updated memo body for the current project.' }));
    expect(tables.memos.find((memo) => memo.id === '44444444-4444-4444-8444-444444444444')?.status).toBe('resolved');
    expect(epics.epics).toEqual([expect.objectContaining({ id: '77777777-7777-4777-8777-777777777777', title: 'Alpha epic' })]);
  });
});
