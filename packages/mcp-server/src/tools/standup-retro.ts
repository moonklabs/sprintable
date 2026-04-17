import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }

export function registerStandupRetroTools(server: McpServer) {
  server.tool('get_standup_v2', 'Get standup entry for member+date', {
    project_id: z.string().optional().describe('Explicit project ID'),
    member_id: z.string(),
    date: z.string().describe('YYYY-MM-DD'),
  }, async ({ project_id, member_id, date }) => {
    try {
      const params = new URLSearchParams({ member_id, date });
      if (project_id) params.set('project_id', project_id);
      const data = await pmApi(`/api/standup?${params}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('save_standup_v2', 'Save/update standup entry (DB table)', {
    project_id: z.string().optional(),
    author_id: z.string(),
    date: z.string().describe('YYYY-MM-DD'),
    done: z.string().optional(),
    plan: z.string().optional(),
    blockers: z.string().optional(),
  }, async ({ project_id, author_id, date, done, plan, blockers }) => {
    try {
      const body: Record<string, unknown> = { author_id, date };
      if (project_id) body.project_id = project_id;
      if (done !== undefined) body.done = done;
      if (plan !== undefined) body.plan = plan;
      if (blockers !== undefined) body.blockers = blockers;
      const data = await pmApi('/api/standup', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('list_standup_entries_v2', 'List standup entries for date (DB)', {
    project_id: z.string().optional(),
    current_member_id: z.string().optional(),
    date: z.string().describe('YYYY-MM-DD'),
  }, async ({ project_id, current_member_id, date }) => {
    try {
      const params = new URLSearchParams({ date });
      if (project_id) params.set('project_id', project_id);
      if (current_member_id) params.set('current_member_id', current_member_id);
      const data = await pmApi(`/api/standup?${params}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('standup_missing', 'Get missing standup members for date', {
    project_id: z.string(),
    date: z.string().describe('YYYY-MM-DD'),
  }, async ({ project_id, date }) => {
    try {
      const data = await pmApi(`/api/standup/missing?project_id=${project_id}&date=${date}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('standup_history', 'Get standup history (recent)', {
    project_id: z.string(),
    limit: z.number().optional(),
  }, async ({ project_id, limit }) => {
    try {
      const params = new URLSearchParams({ project_id });
      if (limit !== undefined) params.set('limit', String(limit));
      const data = await pmApi(`/api/standup/history?${params}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('list_retro_sessions', 'List retro sessions', {
    project_id: z.string().optional(),
    current_member_id: z.string().optional(),
  }, async ({ project_id, current_member_id }) => {
    try {
      const params = new URLSearchParams();
      if (project_id) params.set('project_id', project_id);
      if (current_member_id) params.set('current_member_id', current_member_id);
      const query = params.toString();
      const data = await pmApi(`/api/retro-sessions${query ? `?${query}` : ''}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('create_retro_session', 'Create retro session', {
    project_id: z.string(),
    org_id: z.string(),
    title: z.string(),
    sprint_id: z.string().optional(),
    created_by: z.string(),
  }, async ({ project_id, org_id, title, sprint_id, created_by }) => {
    try {
      const body: Record<string, unknown> = { project_id, org_id, title, created_by };
      if (sprint_id) body.sprint_id = sprint_id;
      const data = await pmApi('/api/retro-sessions', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('change_retro_phase_v2', 'Change retro session phase', {
    project_id: z.string(),
    session_id: z.string(),
    phase: z.enum(['collect', 'group', 'vote', 'discuss', 'action', 'closed']),
  }, async ({ project_id, session_id, phase }) => {
    try {
      const data = await pmApi(`/api/retro-sessions/${session_id}?project_id=${project_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ phase }),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('add_retro_item_v2', 'Add retro item', {
    project_id: z.string(),
    session_id: z.string(),
    category: z.enum(['good', 'bad', 'improve']),
    text: z.string(),
    author_id: z.string(),
  }, async ({ project_id, session_id, category, text, author_id }) => {
    try {
      const data = await pmApi(`/api/retro-sessions/${session_id}/items?project_id=${project_id}`, {
        method: 'POST',
        body: JSON.stringify({ category, text, author_id }),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('vote_retro_item_v2', 'Vote on retro item', {
    project_id: z.string(),
    session_id: z.string(),
    item_id: z.string(),
    voter_id: z.string(),
  }, async ({ project_id, session_id, item_id, voter_id }) => {
    try {
      const data = await pmApi(`/api/retro-sessions/${session_id}/items/${item_id}/vote?project_id=${project_id}`, {
        method: 'POST',
        body: JSON.stringify({ voter_id }),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('add_retro_action_v2', 'Add retro action item', {
    project_id: z.string(),
    session_id: z.string(),
    title: z.string(),
    assignee_id: z.string().optional(),
  }, async ({ project_id, session_id, title, assignee_id }) => {
    try {
      const body: Record<string, unknown> = { title };
      if (assignee_id) body.assignee_id = assignee_id;
      const data = await pmApi(`/api/retro-sessions/${session_id}/actions?project_id=${project_id}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('export_retro_v2', 'Export retro as markdown', {
    project_id: z.string(),
    session_id: z.string(),
  }, async ({ project_id, session_id }) => {
    try {
      const data = await pmApi(`/api/retro-sessions/${session_id}/export?project_id=${project_id}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });
}
