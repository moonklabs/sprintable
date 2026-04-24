import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }

export function registerRetroTools(server: McpServer) {
  server.tool('get_retro_session', 'Get or create retro session for sprint', {
    project_id: z.string(),
    sprint_id: z.string(),
    org_id: z.string().optional().describe('Required when creating a new session'),
    initiator_id: z.string().optional().describe('Required when creating a new session'),
  }, async ({ project_id, sprint_id, org_id, initiator_id }) => {
    try {
      const params = new URLSearchParams({ project_id });
      if (org_id) params.set('org_id', org_id);
      if (initiator_id) params.set('initiator_id', initiator_id);
      const data = await pmApi(`/api/retro/${sprint_id}?${params}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('change_retro_phase', 'Change retro session phase', {
    project_id: z.string(),
    sprint_id: z.string(),
    phase: z.enum(['collect', 'vote', 'discuss', 'action', 'closed']),
  }, async ({ project_id, sprint_id, phase }) => {
    try {
      const data = await pmApi(`/api/retro/${sprint_id}?project_id=${project_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ phase }),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('add_retro_item', 'Add item to retro session', {
    project_id: z.string(),
    sprint_id: z.string(),
    category: z.enum(['good', 'bad', 'improve']),
    text: z.string(),
    author_id: z.string(),
  }, async ({ project_id, sprint_id, category, text, author_id }) => {
    try {
      const data = await pmApi(`/api/retro/${sprint_id}/items?project_id=${project_id}`, {
        method: 'POST',
        body: JSON.stringify({ category, text, author_id }),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('vote_retro_item', 'Vote on retro item (uses retro_votes for duplicate protection)', {
    session_id: z.string().describe('Retro session ID (use get_retro_session to obtain)'),
    item_id: z.string(),
    project_id: z.string(),
  }, async ({ session_id, item_id, project_id }) => {
    try {
      const data = await pmApi(`/api/retro-sessions/${session_id}/items/${item_id}/vote?project_id=${encodeURIComponent(project_id)}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('add_retro_action', 'Add action item to retro session', {
    project_id: z.string(),
    sprint_id: z.string(),
    title: z.string(),
    assignee_id: z.string(),
  }, async ({ project_id, sprint_id, title, assignee_id }) => {
    try {
      const data = await pmApi(`/api/retro/${sprint_id}/actions?project_id=${project_id}`, {
        method: 'POST',
        body: JSON.stringify({ title, assignee_id }),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('update_retro_action_status', 'Update retro action status', {
    action_id: z.string(),
    status: z.enum(['open', 'done']),
  }, async ({ action_id, status }) => {
    try {
      const data = await pmApi(`/api/retro/actions/${action_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('export_retro', 'Export retro as markdown', {
    project_id: z.string(),
    sprint_id: z.string(),
  }, async ({ project_id, sprint_id }) => {
    try {
      const data = await pmApi(`/api/retro/${sprint_id}/export?project_id=${project_id}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('get_burndown', 'Get burndown data for sprint', {
    sprint_id: z.string(),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/sprints/${sprint_id}/burndown`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('kickoff_sprint', 'Kickoff sprint — send notification to all members', {
    sprint_id: z.string(),
    message: z.string().optional(),
  }, async ({ sprint_id, message }) => {
    try {
      const data = await pmApi(`/api/sprints/${sprint_id}/kickoff`, {
        method: 'POST',
        body: JSON.stringify(message ? { message } : {}),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('checkin_sprint', 'Sprint check-in — get progress + missing standups', {
    sprint_id: z.string(),
    date: z.string().describe('YYYY-MM-DD'),
  }, async ({ sprint_id, date }) => {
    try {
      const data = await pmApi(`/api/sprints/${sprint_id}/checkin?date=${date}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });
}
