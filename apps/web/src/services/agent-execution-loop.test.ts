import { describe, expect, it, vi } from 'vitest';
import { AgentExecutionLoop, type AgentExecutionInput } from './agent-execution-loop';
import { buildHitlPolicySnapshot } from './agent-hitl-policy';
import type { LLMClient, LLMConfig } from '@/lib/llm';

function createDbStub(options?: { failHitlRequestUpdate?: boolean; failRunProgressPersist?: boolean }) {
  const failHitlRequestUpdate = options?.failHitlRequestUpdate ?? false;
  const failRunProgressPersist = options?.failRunProgressPersist ?? false;

  const state = {
    run: {
      id: '11111111-1111-4111-8111-111111111111',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      agent_id: '44444444-4444-4444-8444-444444444444',
      memo_id: '55555555-5555-4555-8555-555555555555',
      deployment_id: null as string | null,
      session_id: null,
      status: 'running',
      created_at: '2026-04-06T10:00:00.000Z',
      computed_cost_cents: 0,
      per_run_cap_cents: null as number | null,
      retry_count: 0,
      max_retries: 3,
    },
    memo: {
      id: '55555555-5555-4555-8555-555555555555',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      title: 'Agent task',
      content: 'Please summarize recent work',
      memo_type: 'task',
      status: 'open',
      assigned_to: '44444444-4444-4444-8444-444444444444',
      created_by: '66666666-6666-4666-8666-666666666666',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
    },
    replies: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        memo_id: '55555555-5555-4555-8555-555555555555',
        content: 'Earlier context',
        created_by: '66666666-6666-4666-8666-666666666666',
        created_at: '2026-04-06T10:01:00.000Z',
      },
    ] as Array<Record<string, unknown>>,
    agent: {
      id: '44444444-4444-4444-8444-444444444444',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      type: 'agent',
      name: 'Didi',
      role: 'member',
      is_active: true,
    },
    creator: {
      id: '66666666-6666-4666-8666-666666666666',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      type: 'human',
      name: 'Ortega',
      role: 'owner',
      user_id: 'user-ortega',
      is_active: true,
    },
    project: {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Sprintable Runtime',
      description: 'Agent runtime delivery project',
    },
    projectAiSettings: {
      llm_config: {},
    },
    hitlPolicyConfig: null as unknown,
    teamMembers: [] as Array<Record<string, unknown>>,
    orgMembers: [
      {
        org_id: '22222222-2222-4222-8222-222222222222',
        user_id: 'user-ortega',
        role: 'owner',
      },
    ] as Array<Record<string, unknown>>,
    recentMemos: [
      {
        id: '88888888-8888-4888-8888-888888888888',
        title: 'Recent memo',
        content: 'recent',
        memo_type: 'note',
        status: 'open',
        assigned_to: null,
        created_by: '66666666-6666-4666-8666-666666666666',
        updated_at: '2026-04-06T10:02:00.000Z',
      },
    ] as Array<Record<string, unknown>>,
    openEpics: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        title: 'Prompt runtime hardening',
        status: 'open',
        priority: 'high',
        description: 'Keep the runtime prompt assembly reliable',
        updated_at: '2026-04-06T10:03:00.000Z',
      },
    ],
    openStories: [
      {
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        title: 'Add project context loader',
        status: 'in-progress',
        priority: 'high',
        description: 'Load project memos and stories safely',
        updated_at: '2026-04-06T10:04:00.000Z',
      },
    ],
    persona: {
      id: '99999999-9999-4999-8999-999999999999',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      agent_id: '44444444-4444-4444-8444-444444444444',
      name: 'Developer',
      slug: 'developer',
      description: null,
      system_prompt: 'Be concise for {{org_id}} and {{allowed_project_ids}}',
      style_prompt: 'Answer in Korean',
      model: 'gpt-4o-mini',
      config: {},
      is_builtin: false,
      is_default: true,
      created_by: '66666666-6666-4666-8666-666666666666',
      created_at: '2026-04-06T09:00:00.000Z',
      updated_at: '2026-04-06T09:00:00.000Z',
      deleted_at: null,
    },
    deployments: [] as Array<Record<string, unknown>>,
    sessions: [] as Array<Record<string, unknown>>,
    sessionMemories: [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        org_id: '22222222-2222-4222-8222-222222222222',
        project_id: '33333333-3333-4333-8333-333333333333',
        agent_id: '44444444-4444-4444-8444-444444444444',
        session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        memory_type: 'summary',
        importance: 90,
        content: '최근 회의에서 배포 안정성을 최우선으로 보기로 함',
        created_at: '2026-04-06T09:50:00.000Z',
      },
    ] as Array<Record<string, unknown>>,
    longTermMemories: [
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        org_id: '22222222-2222-4222-8222-222222222222',
        project_id: '33333333-3333-4333-8333-333333333333',
        agent_id: '44444444-4444-4444-8444-444444444444',
        memory_type: 'fact',
        importance: 80,
        content: '이 프로젝트는 다중 프로젝트 컨텍스트 정합성이 중요함',
        created_at: '2026-04-05T10:00:00.000Z',
      },
    ] as Array<Record<string, unknown>>,
    hitlRequests: [] as Array<Record<string, unknown>>,
    auditLogs: [] as Array<Record<string, unknown>>,
    runUpdates: [] as Array<Record<string, unknown>>,
    billingLimits: {
      org_id: '22222222-2222-4222-8222-222222222222',
      monthly_cap_cents: null,
      daily_cap_cents: null,
      alert_threshold_pct: 80,
    },
  };

  state.teamMembers = [state.creator, state.agent];

  const applyRecordFilters = (
    rows: Array<Record<string, unknown>>,
    filters: Array<{ kind: 'eq' | 'is'; column: string; value: unknown }>,
  ) => rows.filter((row) => filters.every((filter) => {
    const current = row[filter.column];
    if (filter.kind === 'eq') return current === filter.value;
    return (current ?? null) === filter.value;
  }));

  const sortRows = (
    rows: Array<Record<string, unknown>>,
    sorters: Array<{ column: string; ascending: boolean }>,
  ) => [...rows].sort((left, right) => {
    for (const sorter of sorters) {
      const a = left[sorter.column];
      const b = right[sorter.column];
      if (a === b) continue;
      if (a == null) return sorter.ascending ? 1 : -1;
      if (b == null) return sorter.ascending ? -1 : 1;
      if (a > b) return sorter.ascending ? 1 : -1;
      if (a < b) return sorter.ascending ? -1 : 1;
    }
    return 0;
  });

  const db = {
    from(table: string) {
      if (table === 'billing_limits') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: state.billingLimits, error: null }),
          upsert: async (payload: Record<string, unknown>) => {
            state.billingLimits = { ...state.billingLimits, ...payload };
            return { error: null };
          },
        };
      }

      if (table === 'subscriptions') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }

      if (table === 'agent_runs') {
        const filters: Array<{ kind: 'eq' | 'in' | 'gte' | 'lt'; column: string; value: unknown }> = [];
        return {
          select() { return this; },
          eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return this; },
          in(column: string, value: unknown[]) { filters.push({ kind: 'in', column, value }); return this; },
          gte(column: string, value: unknown) { filters.push({ kind: 'gte', column, value }); return this; },
          lt(column: string, value: unknown) { filters.push({ kind: 'lt', column, value }); return this; },
          single: async () => ({ data: state.run, error: null }),
          update(payload: Record<string, unknown>) {
            state.run = { ...state.run, ...payload };
            state.runUpdates.push(payload);
            return {
              eq: async () => ({ error: failRunProgressPersist ? { message: 'write failed' } : null }),
            };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            const rows = [state.run].filter((row) => filters.every((filter) => {
              const current = row[filter.column as keyof typeof row] as unknown;
              if (filter.kind === 'eq') return current === filter.value;
              if (filter.kind === 'in') return Array.isArray(filter.value) && filter.value.includes(current);
              if (filter.kind === 'gte') return String(current ?? '') >= String(filter.value);
              if (filter.kind === 'lt') return String(current ?? '') < String(filter.value);
              return true;
            }));
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
      }

      if (table === 'memos') {
        let queryOrder = false;
        let limitCount = 5;
        let pendingInsert: Record<string, unknown> | null = null;
        let pendingUpdate: Record<string, unknown> | null = null;
        let idFilter: string | null = null;
        return {
          select() { return this; },
          insert(payload: Record<string, unknown>) { pendingInsert = payload; return this; },
          update(payload: Record<string, unknown>) { pendingUpdate = payload; return this; },
          delete() {
            return {
              eq: async (_column: string, value: unknown) => {
                idFilter = String(value);
                state.recentMemos = state.recentMemos.filter((memo) => memo.id !== idFilter);
                return { error: null };
              },
            };
          },
          eq(column: string, value: unknown) { if (column === 'id') idFilter = String(value); return this; },
          is() { return this; },
          order() { queryOrder = true; return this; },
          limit(count: number) { limitCount = count; return this; },
          maybeSingle: async () => ({ data: (idFilter ? ([state.memo, ...state.recentMemos].find((memo) => memo.id === idFilter) ?? null) : state.memo), error: null }),
          single: async () => {
            if (pendingInsert) {
              const created = { id: `memo-${state.recentMemos.length + 10}`, created_at: '2026-04-06T10:10:00.000Z', updated_at: '2026-04-06T10:10:00.000Z', ...pendingInsert };
              state.recentMemos.unshift(created);
              return { data: created, error: null };
            }
            if (pendingUpdate) {
              const target = [state.memo, ...state.recentMemos].find((memo) => !idFilter || memo.id === idFilter) ?? state.memo;
              Object.assign(target, pendingUpdate, { updated_at: '2026-04-06T10:20:00.000Z' });
              return { data: target, error: null };
            }
            return { data: (idFilter ? ([state.memo, ...state.recentMemos].find((memo) => memo.id === idFilter) ?? null) : state.memo), error: null };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            const data = queryOrder ? state.recentMemos.slice(0, limitCount) : [];
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
      }

      if (table === 'memo_replies') {
        let memoId: string | null = null;
        let pendingInsert: Record<string, unknown> | null = null;
        return {
          select() { return this; },
          insert(payload: Record<string, unknown>) { pendingInsert = payload; return this; },
          eq(column: string, value: unknown) { if (column === 'memo_id') memoId = String(value); return this; },
          order() { return this; },
          single: async () => {
            const created = { id: `reply-${state.replies.length + 10}`, created_at: '2026-04-06T10:15:00.000Z', ...pendingInsert };
            state.replies.push(created);
            return { data: created, error: null };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            const replies = memoId ? state.replies.filter((reply) => reply.memo_id === memoId) : state.replies;
            return Promise.resolve({ data: replies, error: null }).then(resolve);
          },
        };
      }

      if (table === 'team_members') {
        let typeFilter: string | null = null;
        let idFilter: string | null = null;
        let orgFilter: string | null = null;
        let projectFilter: string | null = null;
        let activeFilter: boolean | null = null;
        let userIdFilter: string[] | null = null;
        let limitCount: number | null = null;
        return {
          select() { return this; },
          eq(column: string, value: unknown) {
            if (column === 'id') idFilter = String(value);
            if (column === 'type') typeFilter = String(value);
            if (column === 'org_id') orgFilter = String(value);
            if (column === 'project_id') projectFilter = String(value);
            if (column === 'is_active') activeFilter = Boolean(value);
            return this;
          },
          in(column: string, value: unknown[]) {
            if (column === 'user_id') userIdFilter = value.map((entry) => String(entry));
            return this;
          },
          is() { return this; },
          order() { return this; },
          limit(count: number) { limitCount = count; return this; },
          maybeSingle: async () => {
            const members = state.teamMembers.filter((member) => {
              if (idFilter && member.id !== idFilter) return false;
              if (typeFilter && member.type !== typeFilter) return false;
              if (orgFilter && member.org_id !== orgFilter) return false;
              if (projectFilter && member.project_id !== projectFilter) return false;
              if (activeFilter !== null && Boolean(member.is_active) !== activeFilter) return false;
              if (userIdFilter && !userIdFilter.includes(String(member.user_id ?? ''))) return false;
              return true;
            });
            return { data: members[0] ?? null, error: null };
          },
          single: async () => {
            const member = state.teamMembers.find((entry) => entry.id === idFilter) ?? state.agent;
            return { data: member, error: null };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            let members = state.teamMembers.filter((member) => {
              if (idFilter && member.id !== idFilter) return false;
              if (typeFilter && member.type !== typeFilter) return false;
              if (orgFilter && member.org_id !== orgFilter) return false;
              if (projectFilter && member.project_id !== projectFilter) return false;
              if (activeFilter !== null && Boolean(member.is_active) !== activeFilter) return false;
              if (userIdFilter && !userIdFilter.includes(String(member.user_id ?? ''))) return false;
              return true;
            });
            if (limitCount !== null) members = members.slice(0, limitCount);
            return Promise.resolve({ data: members, error: null }).then(resolve);
          },
        };
      }

      if (table === 'projects') {
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          maybeSingle: async () => ({ data: state.project, error: null }),
        };
      }

      if (table === 'project_ai_settings') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: state.projectAiSettings, error: null }),
        };
      }

      if (table === 'agent_hitl_policies') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({
            data: state.hitlPolicyConfig ? { config: state.hitlPolicyConfig } : null,
            error: null,
          }),
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
            return Promise.resolve({ data: state.openEpics.slice(0, limitCount), error: null }).then(resolve);
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
            return Promise.resolve({ data: state.openStories.slice(0, limitCount), error: null }).then(resolve);
          },
        };
      }

      if (table === 'agent_long_term_memories') {
        let limitCount = 8;
        const filters: Array<{ kind: 'eq' | 'is'; column: string; value: unknown }> = [];
        const sorters: Array<{ column: string; ascending: boolean }> = [];
        return {
          select() { return this; },
          eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return this; },
          is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return this; },
          order(column: string, options?: { ascending?: boolean }) { sorters.push({ column, ascending: options?.ascending ?? true }); return this; },
          limit(count: number) { limitCount = count; return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            const rows = sortRows(applyRecordFilters(state.longTermMemories, filters), sorters).slice(0, limitCount);
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
      }

      if (table === 'agent_personas') {
        return {
          select() { return this; },
          eq() { return this; },
          is() { return this; },
          order() { return this; },
          limit() { return this; },
          maybeSingle: async () => ({ data: state.persona, error: null }),
          single: async () => ({ data: state.persona, error: null }),
        };
      }

      if (table === 'agent_deployments') {
        let personaId: string | null = null;
        let deploymentId: string | null = null;
        let orgId: string | null = null;
        let projectId: string | null = null;
        let agentId: string | null = null;
        return {
          select() { return this; },
          eq(column: string, value: unknown) {
            if (column === 'persona_id') personaId = String(value);
            if (column === 'id') deploymentId = String(value);
            if (column === 'org_id') orgId = String(value);
            if (column === 'project_id') projectId = String(value);
            if (column === 'agent_id') agentId = String(value);
            return this;
          },
          is() { return this; },
          maybeSingle: async () => ({
            data: state.deployments.find((deployment) => (!deploymentId || deployment.id === deploymentId)
              && (!personaId || deployment.persona_id === personaId)
              && (!orgId || deployment.org_id === orgId)
              && (!projectId || deployment.project_id === projectId)
              && (!agentId || deployment.agent_id === agentId)) ?? null,
            error: null,
          }),
          single: async () => ({
            data: state.deployments.find((deployment) => (!deploymentId || deployment.id === deploymentId)
              && (!personaId || deployment.persona_id === personaId)
              && (!orgId || deployment.org_id === orgId)
              && (!projectId || deployment.project_id === projectId)
              && (!agentId || deployment.agent_id === agentId)) ?? null,
            error: null,
          }),
          then(resolve: (value: { data: null; count: number; error: null }) => void) {
            const count = state.deployments.filter((deployment) => (!personaId || deployment.persona_id === personaId)
              && (!deploymentId || deployment.id === deploymentId)
              && (!orgId || deployment.org_id === orgId)
              && (!projectId || deployment.project_id === projectId)
              && (!agentId || deployment.agent_id === agentId)).length;
            return Promise.resolve({ data: null, count, error: null }).then(resolve);
          },
        };
      }

      if (table === 'agent_sessions') {
        let personaId: string | null = null;
        return {
          select() { return this; },
          eq(column?: string, value?: unknown) {
            if (column === 'persona_id') personaId = String(value);
            return this;
          },
          is() { return this; },
          maybeSingle: async () => ({ data: state.sessions[0] ?? null, error: null }),
          update(payload: Record<string, unknown>) {
            state.sessions[0] = { ...(state.sessions[0] ?? {}), ...payload };
            return { eq: async () => ({ error: null }) };
          },
          insert(payload: Record<string, unknown>) {
            const session = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...payload };
            state.sessions[0] = session;
            return {
              select() { return this; },
              single: async () => ({ data: { id: session.id }, error: null }),
            };
          },
          then(resolve: (value: { data: null; count: number; error: null }) => void) {
            const count = state.sessions.filter((session) => !personaId || session.persona_id === personaId).length;
            return Promise.resolve({ data: null, count, error: null }).then(resolve);
          },
        };
      }

      if (table === 'agent_session_memories') {
        let limitCount = 8;
        const filters: Array<{ kind: 'eq' | 'is'; column: string; value: unknown }> = [];
        const sorters: Array<{ column: string; ascending: boolean }> = [];
        return {
          select() { return this; },
          eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return this; },
          is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return this; },
          order(column: string, options?: { ascending?: boolean }) { sorters.push({ column, ascending: options?.ascending ?? true }); return this; },
          limit(count: number) { limitCount = count; return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            const rows = sortRows(applyRecordFilters(state.sessionMemories, filters), sorters).slice(0, limitCount);
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
          insert: async (payload: Record<string, unknown>) => {
            state.sessionMemories.push(payload);
            return { error: null };
          },
        };
      }

      if (table === 'org_members') {
        let orgFilter: string | null = null;
        let userFilter: string | null = null;
        let rolesFilter: string[] | null = null;
        return {
          select() { return this; },
          eq(column: string, value: unknown) {
            if (column === 'org_id') orgFilter = String(value);
            if (column === 'user_id') userFilter = String(value);
            return this;
          },
          in(column: string, value: unknown[]) {
            if (column === 'role') rolesFilter = value.map((entry) => String(entry));
            return this;
          },
          maybeSingle: async () => {
            const row = state.orgMembers.find((member) => {
              if (orgFilter && member.org_id !== orgFilter) return false;
              if (userFilter && member.user_id !== userFilter) return false;
              if (rolesFilter && !rolesFilter.includes(String(member.role ?? ''))) return false;
              return true;
            }) ?? null;
            return { data: row, error: null };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            const rows = state.orgMembers.filter((member) => {
              if (orgFilter && member.org_id !== orgFilter) return false;
              if (userFilter && member.user_id !== userFilter) return false;
              if (rolesFilter && !rolesFilter.includes(String(member.role ?? ''))) return false;
              return true;
            });
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
      }

      if (table === 'agent_hitl_requests') {
        let idFilter: string | null = null;
        return {
          insert(payload: Record<string, unknown>) {
            const request = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ...payload };
            state.hitlRequests.push(request);
            return {
              select() { return this; },
              single: async () => ({ data: { id: request.id }, error: null }),
            };
          },
          update(payload: Record<string, unknown>) {
            return {
              eq: async (_column: string, value: unknown) => {
                idFilter = String(value);
                if (failHitlRequestUpdate) {
                  return { error: { message: 'hitl_update_failed' } };
                }
                const target = state.hitlRequests.find((request) => request.id === idFilter);
                if (target) Object.assign(target, payload);
                return { error: null };
              },
            };
          },
          delete() {
            return {
              eq: async (_column: string, value: unknown) => {
                idFilter = String(value);
                state.hitlRequests = state.hitlRequests.filter((request) => request.id !== idFilter);
                return { error: null };
              },
            };
          },
        };
      }

      if (table === 'agent_audit_logs') {
        const filters: Array<(record: Record<string, unknown>) => boolean> = [];
        let limitCount: number | null = null;
        let pendingInsert: Record<string, unknown> | null = null;
        let isInsertMode = false;
        const builder = {
          select() { return builder; },
          insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
            isInsertMode = true;
            if (Array.isArray(payload)) {
              for (const item of payload) state.auditLogs.push(item);
            } else {
              pendingInsert = payload;
            }
            return builder;
          },
          eq(column: string, value: unknown) {
            filters.push((record) => record[column] === value);
            return builder;
          },
          order() { return builder; },
          limit(count: number) {
            limitCount = count;
            return builder;
          },
          then(resolve: (value: { data: unknown[] | null; error: null }) => void) {
            if (isInsertMode) {
              if (pendingInsert) {
                state.auditLogs.push(pendingInsert);
                pendingInsert = null;
              }
              isInsertMode = false;
              return Promise.resolve({ data: null, error: null }).then(resolve);
            }

            let rows = state.auditLogs.filter((record) => filters.every((filter) => filter(record)));
            rows = [...rows].sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')));
            if (limitCount != null) rows = rows.slice(0, limitCount);
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return builder;
      }

      if (table === 'llm_pricing_config') {
        let providerFilter: string | null = null;
        let modelFilter: string | null = null;
        let activeFilter: boolean | null = null;
        return {
          select() { return this; },
          eq(column: string, value: unknown) {
            if (column === 'provider') providerFilter = String(value);
            if (column === 'model') modelFilter = String(value);
            if (column === 'is_active') activeFilter = Boolean(value);
            return this;
          },
          maybeSingle: async () => ({
            data: providerFilter === 'anthropic' && modelFilter === 'claude-opus-4' && activeFilter === true
              ? {
                  provider: 'anthropic',
                  model: 'claude-opus-4',
                  input_cost_per_million_tokens_usd: 15,
                  output_cost_per_million_tokens_usd: 75,
                }
              : null,
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  return { db, state };
}

function createMockClient(responses: Array<Record<string, unknown>>): LLMClient {
  let call = 0;
  return {
    generate: vi.fn(async () => ({
      text: JSON.stringify(responses[call++] ?? responses[responses.length - 1]),
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
  };
}

function createLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'openai',
    billingMode: 'byom',
    apiKey: 'key',
    model: 'gpt-4o-mini',
    timeoutMs: 1000,
    maxRetries: 0,
    ...overrides,
  };
}

function createInput(overrides?: Partial<AgentExecutionInput>): AgentExecutionInput {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    memoId: '55555555-5555-4555-8555-555555555555',
    orgId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    agentId: '44444444-4444-4444-8444-444444444444',
    triggerEvent: 'memo.assigned',
    ...overrides,
  };
}

describe('AgentExecutionLoop', () => {
  it('handles tool_call -> respond loop and persists tool history/output memo ids', async () => {
    const { db, state } = createDbStub();
    const addReply = vi.fn(async () => ({ id: 'reply-final' }));
    const resolve = vi.fn();
    const retryService = { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) };
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([
        { action: 'tool_call', tool_name: 'list_recent_project_memos', tool_arguments: { limit: 1 } },
        { action: 'respond', message: '최근 메모를 확인했고 요약하면 recent 입니다.', summary: 'memo reply created' },
      ]),
      memoService: { addReply, resolve } as never,
      retryService,
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('completed');
    expect(result.llmCallCount).toBe(2);
    expect(result.toolCallHistory).toHaveLength(1);
    expect(result.outputMemoIds).toEqual(['55555555-5555-4555-8555-555555555555']);
    expect(addReply).toHaveBeenCalledWith('55555555-5555-4555-8555-555555555555', expect.stringContaining('recent'), '44444444-4444-4444-8444-444444444444');
    expect(state.runUpdates.some((update) => update.status === 'running' && typeof update.started_at === 'string' && update.result_summary === 'Execution started')).toBe(true);
    expect(state.runUpdates.some((update) => update.restored_memory_count === 0)).toBe(true);
    expect(state.runUpdates.some((update) => update.model === 'gpt-4o-mini' && update.llm_provider === 'byom' && update.llm_provider_key === 'openai')).toBe(true);
    expect(state.runUpdates.some((update) => update.memory_diagnostics
      && typeof update.memory_diagnostics === 'object'
      && (update.memory_diagnostics as { totalInjected?: number }).totalInjected === 2)).toBe(true);
    expect(state.runUpdates.some((update) => update.status === 'completed' && update.last_error_code === null && update.session_id === state.sessions[0]?.id)).toBe(true);
    expect(state.auditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        run_id: '11111111-1111-4111-8111-111111111111',
        session_id: expect.any(String),
        event_type: 'agent_tool.executed',
        summary: 'builtin tool list_recent_project_memos executed',
        created_by: '44444444-4444-4444-8444-444444444444',
        payload: expect.objectContaining({
          tool_name: 'list_recent_project_memos',
          tool_source: 'builtin',
          outcome: 'allowed',
        }),
      }),
    ]));
    expect(state.sessionMemories.length).toBeGreaterThan(0);
    expect(retryService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('uses the deployment contract for provider, billing mode, allowed projects, and session binding', async () => {
    const { db, state } = createDbStub();
    state.run.deployment_id = 'deployment-1';
    state.deployments = [{
      id: 'deployment-1',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      agent_id: '44444444-4444-4444-8444-444444444444',
      persona_id: '99999999-9999-4999-8999-999999999999',
      model: 'claude-opus-4',
      status: 'ACTIVE',
      config: {
        schema_version: 1,
        llm_mode: 'managed',
        provider: 'anthropic',
        scope_mode: 'projects',
        project_ids: [
          '33333333-3333-4333-8333-333333333333',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ],
      },
    }];
    const resolveLLMConfigFn = vi.fn(async () => createLLMConfig({
      provider: 'anthropic',
      billingMode: 'managed',
      model: 'claude-opus-4',
    }));
    const addReply = vi.fn(async () => ({ id: 'reply-deployment-contract' }));
    const llmClient: LLMClient = {
      generate: vi.fn(async () => ({
        text: JSON.stringify({ action: 'respond', message: '배포 계약 경로 확인 완료', summary: 'done' }),
        usage: { inputTokens: 10, outputTokens: 5 },
      })),
    };
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn,
      createLLMClientFn: () => llmClient,
      memoService: { addReply, resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('completed');
    expect(resolveLLMConfigFn).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333', {
      provider: 'anthropic',
      billingMode: 'managed',
      model: 'claude-opus-4',
    });
    expect(state.sessions[0]).toMatchObject({
      deployment_id: 'deployment-1',
      persona_id: '99999999-9999-4999-8999-999999999999',
    });
    expect(addReply).toHaveBeenCalled();
    const [messages] = vi.mocked(llmClient.generate).mock.calls[0] ?? [];
    expect(JSON.stringify(messages)).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('fails closed when a deployment-scoped run cannot load its deployment contract', async () => {
    const { db, state } = createDbStub();
    state.run.deployment_id = 'deployment-missing';

    const resolveLLMConfigFn = vi.fn(async () => createLLMConfig());
    const createLLMClientFn = vi.fn(() => createMockClient([{ action: 'respond', message: '작업 완료', summary: 'done' }]));
    const toolExecutionEngine = {
      loadRegistry: vi.fn(),
      execute: vi.fn(),
    };

    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn,
      createLLMClientFn,
      memoService: { addReply: vi.fn(async () => ({ id: 'reply-missing-deployment' })), resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
      toolExecutionEngine: toolExecutionEngine as never,
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('failed');
    expect(resolveLLMConfigFn).not.toHaveBeenCalled();
    expect(createLLMClientFn).not.toHaveBeenCalled();
    expect(toolExecutionEngine.loadRegistry).not.toHaveBeenCalled();
    expect(state.sessions).toHaveLength(0);
    expect(state.runUpdates.some((update) => update.status === 'failed' && update.last_error_code === 'deployment_contract_missing')).toBe(true);
  });

  it('fails closed when a deployment-scoped run has an invalid deployment contract config', async () => {
    const { db, state } = createDbStub();
    state.run.deployment_id = 'deployment-1';
    state.deployments = [{
      id: 'deployment-1',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      agent_id: '44444444-4444-4444-8444-444444444444',
      persona_id: '99999999-9999-4999-8999-999999999999',
      model: 'gpt-4o-mini',
      status: 'ACTIVE',
      config: {
        schema_version: 99,
        llm_mode: 'managed',
      },
    }];

    const resolveLLMConfigFn = vi.fn(async () => createLLMConfig());
    const createLLMClientFn = vi.fn(() => createMockClient([{ action: 'respond', message: '작업 완료', summary: 'done' }]));
    const toolExecutionEngine = {
      loadRegistry: vi.fn(),
      execute: vi.fn(),
    };

    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn,
      createLLMClientFn,
      memoService: { addReply: vi.fn(async () => ({ id: 'reply-invalid-deployment' })), resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
      toolExecutionEngine: toolExecutionEngine as never,
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('failed');
    expect(resolveLLMConfigFn).not.toHaveBeenCalled();
    expect(createLLMClientFn).not.toHaveBeenCalled();
    expect(toolExecutionEngine.loadRegistry).not.toHaveBeenCalled();
    expect(state.sessions).toHaveLength(0);
    expect(state.runUpdates.some((update) => update.status === 'failed' && update.last_error_code === 'deployment_contract_invalid')).toBe(true);
  });

  it('fails loudly when run progress cannot be persisted', async () => {
    const { db } = createDbStub({ failRunProgressPersist: true });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([
        { action: 'respond', message: '작업 완료', summary: 'done' },
      ]),
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    }, logger);

    await expect(loop.execute(createInput())).rejects.toThrow('agent_run_persist_failed:write failed');
    expect(logger.error).toHaveBeenCalledWith(
      '[AgentExecutionLoop] Failed to persist run progress:',
      'write failed',
      expect.objectContaining({ runId: '11111111-1111-4111-8111-111111111111' }),
    );
  });

  it('supports newly added builtin MCP tool calls', async () => {
    const { db } = createDbStub();
    const addReply = vi.fn(async () => ({ id: 'reply-created' }));
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([
        { action: 'tool_call', tool_name: 'list_memos', tool_arguments: { limit: 2 } },
        { action: 'respond', message: '프로젝트 메모 목록을 확인했는.', summary: 'listed memos' },
      ]),
      memoService: { addReply, resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('completed');
    expect(result.toolCallHistory[0]?.toolName).toBe('list_memos');
    expect(result.toolCallHistory[0]?.toolSource).toBe('builtin');
    expect(result.toolCallHistory[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result.toolCallHistory[0]?.result)).toContain('Recent memo');
  });

  it('builds the staged system prompt pipeline before calling the model', async () => {
    const { db } = createDbStub();
    const client = createMockClient([{ action: 'respond', message: '작업 완료', summary: 'done' }]);
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => client,
      memoService: { addReply: vi.fn(async () => ({ id: 'reply-pipeline' })), resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    await loop.execute(createInput());

    const firstCallMessages = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemPrompt = String(firstCallMessages[0].content);
    expect(systemPrompt).toContain('## Base Persona');
    expect(systemPrompt).toContain('## Team Context');
    expect(systemPrompt).toContain('## Memory Injection');
    expect(systemPrompt).toContain('## Safety Layer');
    expect(systemPrompt).toContain('Be concise for 22222222-2222-4222-8222-222222222222 and ["33333333-3333-4333-8333-333333333333"]');
    expect(systemPrompt).toContain('최근 회의에서 배포 안정성을 최우선으로 보기로 함');
    expect(systemPrompt).toContain('project_context_loader:');
    expect(systemPrompt).toContain('Prompt runtime hardening');
    expect(systemPrompt).toContain('Add project context loader');
  });

  it('keeps out-of-scope memories out of the execution prompt and records blocked diagnostics', async () => {
    const { db, state } = createDbStub();
    state.sessionMemories.push({
      id: 'session-other-project',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      agent_id: '44444444-4444-4444-8444-444444444444',
      session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      memory_type: 'summary',
      importance: 100,
      content: '다른 프로젝트 세션 메모리',
      created_at: '2026-04-06T09:55:00.000Z',
    });
    state.sessionMemories.push({
      id: 'session-same-project-other-session',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      agent_id: '44444444-4444-4444-8444-444444444444',
      session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      memory_type: 'summary',
      importance: 95,
      content: '같은 프로젝트의 다른 세션 메모리',
      created_at: '2026-04-06T09:54:00.000Z',
    });
    state.longTermMemories.push({
      id: 'long-term-other-project',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      agent_id: '44444444-4444-4444-8444-444444444444',
      memory_type: 'fact',
      importance: 100,
      content: '다른 프로젝트 장기 메모리',
      created_at: '2026-04-05T10:05:00.000Z',
    });
    state.longTermMemories.push({
      id: 'long-term-same-project-other-agent',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      agent_id: '55555555-5555-4555-8555-555555555556',
      memory_type: 'fact',
      importance: 95,
      content: '같은 프로젝트의 다른 에이전트 장기 메모리',
      created_at: '2026-04-05T10:04:00.000Z',
    });

    const client = createMockClient([{ action: 'respond', message: '작업 완료', summary: 'done' }]);
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => client,
      memoService: { addReply: vi.fn(async () => ({ id: 'reply-memory-scope' })), resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    await loop.execute(createInput());

    const firstCallMessages = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemPrompt = String(firstCallMessages[0].content);
    expect(systemPrompt).toContain('최근 회의에서 배포 안정성을 최우선으로 보기로 함');
    expect(systemPrompt).toContain('이 프로젝트는 다중 프로젝트 컨텍스트 정합성이 중요함');
    expect(systemPrompt).not.toContain('다른 프로젝트 세션 메모리');
    expect(systemPrompt).not.toContain('다른 프로젝트 장기 메모리');
    expect(systemPrompt).not.toContain('같은 프로젝트의 다른 세션 메모리');
    expect(systemPrompt).not.toContain('같은 프로젝트의 다른 에이전트 장기 메모리');
    expect(state.runUpdates.some((update) => {
      const diagnostics = update.memory_diagnostics as {
        session?: { blockedCount?: number };
        longTerm?: { blockedCount?: number };
      } | undefined;
      return diagnostics?.session?.blockedCount === 1 && diagnostics.longTerm?.blockedCount === 1;
    })).toBe(true);
    expect(state.auditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'agent_memory.cross_scope_blocked',
        payload: expect.objectContaining({ memory_kind: 'session_memory', blocked_count: 1 }),
      }),
      expect.objectContaining({
        event_type: 'agent_memory.cross_scope_blocked',
        payload: expect.objectContaining({ memory_kind: 'long_term_memory', blocked_count: 1 }),
      }),
    ]));
  });

  it('preserves exact-scope memory injection even when blocked diagnostics candidates dominate the ranking', async () => {
    const { db, state } = createDbStub();
    state.sessionMemories = [
      {
        id: 'session-in-scope-low-rank',
        org_id: '22222222-2222-4222-8222-222222222222',
        project_id: '33333333-3333-4333-8333-333333333333',
        agent_id: '44444444-4444-4444-8444-444444444444',
        session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        memory_type: 'summary',
        importance: 10,
        content: '현재 세션 메모리는 diagnostics보다 우선 보존되어야 함',
        created_at: '2026-04-06T09:10:00.000Z',
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `session-blocked-${index + 1}`,
        org_id: '22222222-2222-4222-8222-222222222222',
        project_id: '33333333-3333-4333-8333-333333333333',
        agent_id: '44444444-4444-4444-8444-444444444444',
        session_id: `blocked-session-${index + 1}`,
        memory_type: 'summary',
        importance: 200 - index,
        content: `같은 프로젝트의 다른 세션 메모리 ${index + 1}`,
        created_at: `2026-04-06T09:${String(59 - index).padStart(2, '0')}:00.000Z`,
      })),
    ];
    state.longTermMemories = [
      {
        id: 'long-term-in-scope-low-rank',
        org_id: '22222222-2222-4222-8222-222222222222',
        project_id: '33333333-3333-4333-8333-333333333333',
        agent_id: '44444444-4444-4444-8444-444444444444',
        memory_type: 'fact',
        importance: 10,
        content: '현재 에이전트 장기 메모리는 candidate starvation 없이 주입되어야 함',
        created_at: '2026-04-05T09:10:00.000Z',
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `long-term-blocked-${index + 1}`,
        org_id: '22222222-2222-4222-8222-222222222222',
        project_id: '33333333-3333-4333-8333-333333333333',
        agent_id: `blocked-agent-${index + 1}`,
        memory_type: 'fact',
        importance: 200 - index,
        content: `같은 프로젝트의 다른 에이전트 장기 메모리 ${index + 1}`,
        created_at: `2026-04-05T09:${String(59 - index).padStart(2, '0')}:00.000Z`,
      })),
    ];

    const client = createMockClient([{ action: 'respond', message: '작업 완료', summary: 'done' }]);
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => client,
      memoService: { addReply: vi.fn(async () => ({ id: 'reply-memory-starvation' })), resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    await loop.execute(createInput());

    const firstCallMessages = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemPrompt = String(firstCallMessages[0].content);
    expect(systemPrompt).toContain('현재 세션 메모리는 diagnostics보다 우선 보존되어야 함');
    expect(systemPrompt).toContain('현재 에이전트 장기 메모리는 candidate starvation 없이 주입되어야 함');
    expect(systemPrompt).not.toContain('같은 프로젝트의 다른 세션 메모리 1');
    expect(systemPrompt).not.toContain('같은 프로젝트의 다른 에이전트 장기 메모리 1');
    expect(state.runUpdates.some((update) => {
      const diagnostics = update.memory_diagnostics as {
        session?: { blockedCount?: number; injectedIds?: string[] };
        longTerm?: { blockedCount?: number; injectedIds?: string[] };
      } | undefined;
      return diagnostics?.session?.blockedCount === 24
        && diagnostics.longTerm?.blockedCount === 24
        && diagnostics.session.injectedIds?.includes('session-in-scope-low-rank')
        && diagnostics.longTerm.injectedIds?.includes('long-term-in-scope-low-rank');
    })).toBe(true);
  });

  it('keeps persona-disallowed external tools out of the execution prompt by using the effective registry boundary', async () => {
    const { db, state } = createDbStub();
    state.persona.config = { tool_allowlist: ['get_source_memo'] };

    const client = createMockClient([{ action: 'respond', message: '작업 완료', summary: 'done' }]);
    const toolExecutionEngine = {
      loadRegistry: vi.fn(async () => ({
        builtinToolNames: ['get_source_memo'],
        externalServers: [],
        availableToolNames: ['get_source_memo'],
        aclBoundary: {
          project_id: '33333333-3333-4333-8333-333333333333',
          allowed_project_ids: ['33333333-3333-4333-8333-333333333333'],
          agent_id: '44444444-4444-4444-8444-444444444444',
          project_in_scope: true,
          explicit_tool_names: ['get_source_memo'],
        },
      })),
      execute: vi.fn(),
    };

    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => client,
      memoService: { addReply: vi.fn(async () => ({ id: 'reply-boundary' })), resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
      toolExecutionEngine,
    });

    await loop.execute(createInput());

    expect(toolExecutionEngine.loadRegistry).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333', ['get_source_memo'], {
      allowedProjectIds: ['33333333-3333-4333-8333-333333333333'],
      agentId: '44444444-4444-4444-8444-444444444444',
    });
    const firstCallMessages = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemPrompt = String(firstCallMessages[0].content);
    expect(systemPrompt).toContain('Available tools: get_source_memo.');
    expect(systemPrompt).not.toContain('external.search_docs');
  });

  it('keeps tools out of the execution prompt when the deployment project scope excludes the current project', async () => {
    const { db, state } = createDbStub();
    state.run.deployment_id = 'deployment-1';
    state.deployments = [{
      id: 'deployment-1',
      org_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
      agent_id: '44444444-4444-4444-8444-444444444444',
      persona_id: '99999999-9999-4999-8999-999999999999',
      model: 'gpt-4o-mini',
      status: 'ACTIVE',
      config: {
        schema_version: 1,
        llm_mode: 'managed',
        provider: 'openai',
        scope_mode: 'projects',
        project_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      },
    }];

    const client = createMockClient([{ action: 'respond', message: '작업 완료', summary: 'done' }]);
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig({
        provider: 'openai',
        billingMode: 'managed',
        model: 'gpt-4o-mini',
      })),
      createLLMClientFn: () => client,
      memoService: { addReply: vi.fn(async () => ({ id: 'reply-project-scope' })), resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    await loop.execute(createInput());

    const firstCallMessages = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemPrompt = String(firstCallMessages[0].content);
    expect(systemPrompt).toContain('Available tools: none.');
  });

  it('creates HITL request and memo reply when the model asks for human input', async () => {
    const { db, state } = createDbStub();
    const addReply = vi.fn(async () => ({ id: 'reply-hitl' }));
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([
        { action: 'hitl', title: 'Need approval', question: 'Should I close this memo?', reason: 'Closing impacts project scope' },
      ]),
      memoService: {
        addReply,
        create: vi.fn(async (payload: Record<string, unknown>) => {
          const created = {
            id: 'memo-hitl-generated',
            title: payload.title,
            created_at: '2026-04-06T10:10:00.000Z',
            updated_at: '2026-04-06T10:10:00.000Z',
            ...payload,
          };
          state.recentMemos.unshift(created);
          return created;
        }),
        resolve: vi.fn(),
      } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('hitl');
    expect(result.hitlRequestId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(addReply).toHaveBeenCalledWith(
      '55555555-5555-4555-8555-555555555555',
      expect.stringContaining('HITL로 전환'),
      '44444444-4444-4444-8444-444444444444',
    );
    expect(state.hitlRequests).toHaveLength(1);
    expect(state.hitlRequests[0]).toMatchObject({
      request_type: 'approval',
      requested_for: '66666666-6666-4666-8666-666666666666',
      metadata: expect.objectContaining({
        memo_id: '55555555-5555-4555-8555-555555555555',
        hitl_memo_id: expect.any(String),
        approval_rule: 'manual_hitl_request',
        timeout_class: 'standard',
        escalation_mode: 'timeout_memo',
      }),
    });
    expect(state.recentMemos[0]).toMatchObject({
      title: 'HITL 요청 · Agent task',
      assigned_to: '66666666-6666-4666-8666-666666666666',
      created_by: '44444444-4444-4444-8444-444444444444',
      metadata: expect.objectContaining({
        kind: 'hitl_request',
        source_memo_id: '55555555-5555-4555-8555-555555555555',
        request_type: 'approval',
        approval_rule: 'manual_hitl_request',
        timeout_class: 'standard',
      }),
    });
    expect(state.runUpdates.some((update) => update.status === 'hitl_pending' && update.last_error_code === null)).toBe(true);
  });

  it('rolls back the pending HITL request when HITL memo creation fails', async () => {
    const { db, state } = createDbStub();
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([
        { action: 'hitl', title: 'Need approval', question: 'Should I close this memo?', reason: 'Closing impacts project scope' },
      ]),
      memoService: {
        addReply: vi.fn(),
        create: vi.fn(async () => {
          throw new Error('memo_create_failed');
        }),
        resolve: vi.fn(),
      } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('failed');
    expect(state.hitlRequests).toHaveLength(0);
    expect(state.recentMemos).toEqual([
      expect.objectContaining({ id: '88888888-8888-4888-8888-888888888888' }),
    ]);
    expect(state.runUpdates.some((update) => update.status === 'failed')).toBe(true);
  });

  it('rolls back the HITL request and memo when request metadata update fails', async () => {
    const { db, state } = createDbStub({ failHitlRequestUpdate: true });
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([
        { action: 'hitl', title: 'Need approval', question: 'Should I close this memo?', reason: 'Closing impacts project scope' },
      ]),
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('failed');
    expect(state.hitlRequests).toHaveLength(0);
    expect(state.recentMemos).toEqual([
      expect.objectContaining({ id: '88888888-8888-4888-8888-888888888888' }),
    ]);
    expect(state.runUpdates.some((update) => update.status === 'failed')).toBe(true);
  });

  it('reassigns HITL to another active admin when the creator admin is inactive', async () => {
    const { db, state } = createDbStub();
    state.creator.is_active = false;
    state.teamMembers = [
      state.creator,
      state.agent,
      {
        id: '99990000-0000-4000-8000-000000000001',
        org_id: state.memo.org_id,
        project_id: state.memo.project_id,
        type: 'human',
        name: 'Qasim',
        role: 'admin',
        user_id: 'user-qasim',
        is_active: true,
      },
    ];
    state.orgMembers = [
      ...state.orgMembers,
      {
        org_id: state.memo.org_id,
        user_id: 'user-qasim',
        role: 'admin',
      },
    ];

    const addReply = vi.fn(async () => ({ id: 'reply-hitl-reassign' }));
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([
        { action: 'hitl', title: 'Need approval', question: 'Should I close this memo?', reason: 'Closing impacts project scope' },
      ]),
      memoService: {
        addReply,
        create: vi.fn(async (payload: Record<string, unknown>) => {
          const created = {
            id: 'memo-hitl-reassigned',
            title: payload.title,
            created_at: '2026-04-06T10:16:00.000Z',
            updated_at: '2026-04-06T10:16:00.000Z',
            ...payload,
          };
          state.recentMemos.unshift(created);
          return created;
        }),
        resolve: vi.fn(),
      } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('hitl');
    expect(state.hitlRequests).toHaveLength(1);
    expect(state.hitlRequests[0]).toMatchObject({
      requested_for: '99990000-0000-4000-8000-000000000001',
    });
  });

  it('fails HITL handoff when no active admin human is available', async () => {
    const { db, state } = createDbStub();
    state.orgMembers = [];

    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([
        { action: 'hitl', title: 'Need approval', question: 'Should I close this memo?', reason: 'Closing impacts project scope' },
      ]),
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('failed');
    expect(state.hitlRequests).toHaveLength(0);
    expect(state.runUpdates.some((update) => update.status === 'failed')).toBe(true);
  });

  it.skip('[OSS-stubbed billing] normalizes legacy billing HITL request types back to approval when managed cost exceeds the per-run cap', async () => {
    const { db, state } = createDbStub();
    state.run.per_run_cap_cents = 100;
    const hitlPolicy = buildHitlPolicySnapshot({
      schema_version: 1,
      approval_rules: [
        {
          key: 'billing_cap_exceeded',
          request_type: 'escalation',
          timeout_class: 'fast',
          approval_required: true,
        },
      ],
      timeout_classes: [
        {
          key: 'fast',
          duration_minutes: 120,
          reminder_minutes_before: 30,
          escalation_mode: 'timeout_memo_and_escalate',
        },
      ],
    });

    const expensiveClient: LLMClient = {
      generate: vi.fn(async () => ({
        text: JSON.stringify({ action: 'respond', message: '비용 계산 완료', summary: 'done' }),
        usage: { inputTokens: 100000, outputTokens: 50000 },
      })),
    };

    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig({
        provider: 'openai',
        billingMode: 'managed',
        perRunCapCents: 100,
      })),
      getManagedPricingRowFn: vi.fn(async () => ({
        provider: 'openai' as const,
        model: 'gpt-4o-mini',
        input_cost_per_million_tokens_usd: 10,
        output_cost_per_million_tokens_usd: 30,
      })),
      createLLMClientFn: () => expensiveClient,
      memoService: {
        addReply: vi.fn(async () => ({ id: 'reply-billing' })),
        create: vi.fn(async (payload: Record<string, unknown>) => {
          const created = {
            id: 'memo-hitl-billing',
            title: payload.title,
            created_at: '2026-04-06T10:12:00.000Z',
            updated_at: '2026-04-06T10:12:00.000Z',
            ...payload,
          };
          state.recentMemos.unshift(created);
          return created;
        }),
        resolve: vi.fn(),
      } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
      hitlPolicyService: { getProjectPolicy: vi.fn(async () => hitlPolicy) },
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('completed');
    expect(result.hitlRequestId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(state.hitlRequests).toHaveLength(1);
    expect(state.hitlRequests[0]).toMatchObject({
      request_type: 'approval',
      metadata: expect.objectContaining({
        approval_rule: 'billing_cap_exceeded',
        timeout_class: 'fast',
        reminder_minutes_before: 30,
        escalation_mode: 'timeout_memo_and_escalate',
      }),
    });
    expect(state.runUpdates.some((update) => update.computed_cost_cents === 325)).toBe(true);
    expect(state.runUpdates.some((update) => Array.isArray(update.billing_notes) && update.billing_notes.includes('per_run_cap_exceeded'))).toBe(true);
  });

  it.skip('[OSS-stubbed billing] uses fallback managed pricing and warns when a model is missing from llm_pricing_config', async () => {
    const { db, state } = createDbStub();
    const warn = vi.fn();

    const expensiveClient: LLMClient = {
      generate: vi.fn(async () => ({
        text: JSON.stringify({ action: 'respond', message: 'fallback pricing', summary: 'done' }),
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      })),
    };

    const loop = new AgentExecutionLoop(
      db as never,
      {
        resolveLLMConfigFn: vi.fn(async () => createLLMConfig({
          provider: 'openai',
          billingMode: 'managed',
          model: 'unseeded-model' as LLMConfig['model'],
          perRunCapCents: 5000,
        })),
        getManagedPricingRowFn: vi.fn(async () => null),
        createLLMClientFn: () => expensiveClient,
        memoService: { addReply: vi.fn(async () => ({ id: 'reply-fallback' })), resolve: vi.fn() } as never,
        retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
        fireWebhooksFn: vi.fn(),
      },
      { info: vi.fn(), warn, error: vi.fn() },
    );

    const result = await loop.execute(createInput());

    expect(result.status).toBe('completed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('using fallback input=$5/1M output=$15/1M'));
    expect(state.runUpdates.some((update) => update.computed_cost_cents === 2600)).toBe(true);
    expect(state.runUpdates.some((update) => Array.isArray(update.billing_notes) && update.billing_notes.includes('managed_pricing_fallback'))).toBe(true);
  });

  it('forwards the processed memo to the next agent when routing mode is process_and_forward', async () => {
    const { db } = createDbStub();
    const addReply = vi.fn();
    const createMemo = vi.fn(async () => ({ id: 'memo-forwarded' }));
    const resolve = vi.fn();
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([{ action: 'respond', message: '다음 에이전트에게 넘길 내용', summary: 'forwarded' }]),
      memoService: { addReply, create: createMemo, resolve } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput({
      agentId: '44444444-4444-4444-8444-444444444444',
      routing: {
        ruleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        autoReplyMode: 'process_and_forward',
        forwardToAgentId: '99999999-9999-4999-8999-999999999998',
        originalAssignedTo: '44444444-4444-4444-8444-444444444444',
      },
    }));

    expect(result.status).toBe('completed');
    expect(result.replyId).toBeUndefined();
    expect(result.outputMemoIds).toEqual(['memo-forwarded']);
    expect(createMemo).toHaveBeenCalledWith(expect.objectContaining({
      supersedes_id: '55555555-5555-4555-8555-555555555555',
      assigned_to: '99999999-9999-4999-8999-999999999998',
      content: '다음 에이전트에게 넘길 내용',
      metadata: expect.objectContaining({
        routing: expect.objectContaining({
          source_memo_id: '55555555-5555-4555-8555-555555555555',
          matched_rule_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          auto_reply_mode: 'process_and_forward',
        }),
      }),
    }));
    expect(addReply).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('fails closed when a process_and_forward run reaches finalize without an explicit forward target', async () => {
    const { db, state } = createDbStub();
    const createMemo = vi.fn(async () => ({ id: 'memo-forwarded' }));
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([{ action: 'respond', message: '다음 에이전트에게 넘길 내용', summary: 'forward' }]),
      memoService: { addReply: vi.fn(), create: createMemo, resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput({
      routing: {
        ruleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        autoReplyMode: 'process_and_forward',
        originalAssignedTo: '44444444-4444-4444-8444-444444444444',
      },
    }));

    expect(result.status).toBe('failed');
    expect(createMemo).not.toHaveBeenCalled();
    expect(state.runUpdates.some((update) => update.last_error_code === 'process_and_forward_requires_forward_to_agent_id')).toBe(true);
  });

  it('fails closed when a process_and_forward runtime payload targets an inactive agent', async () => {
    const { db, state } = createDbStub();
    state.teamMembers = [
      state.creator,
      state.agent,
      {
        id: '99999999-9999-4999-8999-999999999998',
        org_id: state.memo.org_id,
        project_id: state.memo.project_id,
        type: 'agent',
        name: 'Inactive Reviewer',
        role: 'member',
        is_active: false,
      },
    ];
    const createMemo = vi.fn(async () => ({ id: 'memo-forwarded' }));
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([{ action: 'respond', message: '다음 에이전트에게 넘길 내용', summary: 'forward' }]),
      memoService: { addReply: vi.fn(), create: createMemo, resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput({
      routing: {
        ruleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        autoReplyMode: 'process_and_forward',
        forwardToAgentId: '99999999-9999-4999-8999-999999999998',
        originalAssignedTo: '44444444-4444-4444-8444-444444444444',
      },
    }));

    expect(result.status).toBe('failed');
    expect(createMemo).not.toHaveBeenCalled();
    expect(state.runUpdates.some((update) => update.last_error_code === 'routing_forward_target_must_be_active_agent')).toBe(true);
  });

  it('resolves the memo after replying when routing mode is process_and_report', async () => {
    const { db } = createDbStub();
    const addReply = vi.fn(async () => ({ id: 'reply-report' }));
    const resolve = vi.fn(async () => ({ id: '55555555-5555-4555-8555-555555555555', status: 'resolved' }));
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([{ action: 'respond', message: '완료 보고', summary: 'reported' }]),
      memoService: { addReply, create: vi.fn(), resolve } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput({
      routing: {
        ruleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        autoReplyMode: 'process_and_report',
        originalAssignedTo: '44444444-4444-4444-8444-444444444444',
      },
    }));

    expect(result.status).toBe('completed');
    expect(result.replyId).toBe('reply-report');
    expect(addReply).toHaveBeenCalledWith('55555555-5555-4555-8555-555555555555', '완료 보고', '44444444-4444-4444-8444-444444444444');
    expect(resolve).toHaveBeenCalledWith('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444');
  });

  it('short-circuits execution when the daily billing cap is exceeded', async () => {
    const { db, state } = createDbStub();
    const llmClient = createMockClient([{ action: 'respond', message: 'should not happen' }]);
    const billingLimitEnforcer = {
      enforceBeforeRun: vi.fn(async () => ({ status: 'daily_cap_exceeded' as const, reason: '일일 한도 초과, 내일 재개' })),
      enforceAfterRun: vi.fn(async () => ({ thresholdAlertSent: false, monthlyCapExceeded: false, suspendedDeploymentCount: 0 })),
    };
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => llmClient,
      memoService: { addReply: vi.fn(), resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
      billingLimitEnforcer,
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('failed');
    expect(billingLimitEnforcer.enforceBeforeRun).toHaveBeenCalledTimes(1);
    expect(state.runUpdates.some((update) => update.last_error_code === 'billing_daily_cap_exceeded')).toBe(true);
    expect(state.runUpdates.some((update) => update.model === null && update.llm_provider === null && update.llm_provider_key === null)).toBe(true);
    expect(llmClient.generate).not.toHaveBeenCalled();
  });

  it('blocks cross-org/project mismatches and schedules retry after failure', async () => {
    const { db, state } = createDbStub();
    const retryService = { scheduleRetry: vi.fn(async () => ({ scheduled: true, nextRetryAt: '2026-04-06T11:00:00.000Z' })) };
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([{ action: 'respond', message: 'should not happen' }]),
      memoService: { addReply: vi.fn(), resolve: vi.fn() } as never,
      retryService,
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput({ orgId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }));

    expect(result.status).toBe('failed');
    expect(state.auditLogs.some((log) => log.event_type === 'agent_execution.cross_org_blocked')).toBe(true);
    expect(state.runUpdates.some((update) => update.status === 'failed' && update.last_error_code === 'cross_org_blocked')).toBe(true);
    expect(retryService.scheduleRetry).not.toHaveBeenCalled();
  });

  it('blocks cross-project scope mismatches with an explicit scope audit event', async () => {
    const { db, state } = createDbStub();
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient([{ action: 'respond', message: 'should not happen' }]),
      memoService: { addReply: vi.fn(), resolve: vi.fn() } as never,
      retryService: { scheduleRetry: vi.fn(async () => ({ scheduled: false, nextRetryAt: null })) },
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput({ projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));

    expect(result.status).toBe('failed');
    expect(state.auditLogs.some((log) => log.event_type === 'agent_execution.cross_scope_blocked')).toBe(true);
    expect(state.runUpdates.some((update) => update.status === 'failed' && update.last_error_code === 'scope_mismatch')).toBe(true);
  });

  it('fails and schedules retry when llm call limit is exceeded', async () => {
    const { db, state } = createDbStub();
    const retryService = { scheduleRetry: vi.fn(async () => ({ scheduled: true, nextRetryAt: '2026-04-06T11:00:00.000Z' })) };
    const loop = new AgentExecutionLoop(db as never, {
      resolveLLMConfigFn: vi.fn(async () => createLLMConfig()),
      createLLMClientFn: () => createMockClient(Array.from({ length: 20 }, () => ({ action: 'tool_call', tool_name: 'get_source_memo', tool_arguments: {} }))),
      memoService: { addReply: vi.fn(), resolve: vi.fn() } as never,
      retryService,
      fireWebhooksFn: vi.fn(),
    });

    const result = await loop.execute(createInput());

    expect(result.status).toBe('failed');
    expect(result.llmCallCount).toBe(20);
    expect(retryService.scheduleRetry).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(state.runUpdates.some((update) => update.error_message === 'llm_call_limit_exceeded' && update.last_error_code === 'llm_call_limit_exceeded')).toBe(true);
  });
});
