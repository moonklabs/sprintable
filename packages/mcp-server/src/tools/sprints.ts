import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function handleError(e: unknown) { return err(e instanceof PmApiError ? e.message : String(e)); }

export function registerSprintsTools(server: McpServer) {
  server.tool('list_sprints', 'List sprints', {
    project_id: z.string().describe('Project ID'),
    status: z.string().optional().describe('Filter by status: planning | active | closed'),
  }, async ({ project_id, status }) => {
    try {
      const params = new URLSearchParams({ project_id });
      if (status) params.set('status', status);
      const data = await pmApi(`/api/v2/sprints?${params.toString()}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('activate_sprint', 'Activate sprint (planning → active)', {
    sprint_id: z.string(),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/v2/sprints/${encodeURIComponent(sprint_id)}/activate`, { method: 'POST' });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('close_sprint', 'Close sprint (active → closed)', {
    sprint_id: z.string(),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/v2/sprints/${encodeURIComponent(sprint_id)}/close`, { method: 'POST' });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('get_velocity', 'Get sprint velocity', {
    sprint_id: z.string(),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/v2/sprints/${encodeURIComponent(sprint_id)}/velocity`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('sprint_summary', 'Get sprint story summary by status', {
    sprint_id: z.string(),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/v2/sprints/${encodeURIComponent(sprint_id)}/summary`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('create_sprint', 'Create a new sprint', {
    project_id: z.string().describe('Project ID'),
    title: z.string().describe('Sprint title'),
    start_date: z.string().optional().describe('Start date (ISO date, e.g. 2026-05-01)'),
    end_date: z.string().optional().describe('End date (ISO date, e.g. 2026-05-14)'),
    team_size: z.number().optional().describe('Team size'),
  }, async ({ project_id, title, start_date, end_date, team_size }) => {
    try {
      const body: Record<string, unknown> = { project_id, title };
      if (start_date) body.start_date = start_date;
      if (end_date) body.end_date = end_date;
      if (team_size !== undefined) body.team_size = team_size;
      const data = await pmApi('/api/v2/sprints', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('update_sprint', 'Update sprint fields', {
    sprint_id: z.string().describe('Sprint ID'),
    title: z.string().optional().describe('Sprint title'),
    start_date: z.string().optional().describe('Start date (ISO date)'),
    end_date: z.string().optional().describe('End date (ISO date)'),
    team_size: z.number().optional().describe('Team size'),
  }, async ({ sprint_id, title, start_date, end_date, team_size }) => {
    try {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (start_date !== undefined) body.start_date = start_date;
      if (end_date !== undefined) body.end_date = end_date;
      if (team_size !== undefined) body.team_size = team_size;
      const data = await pmApi(`/api/v2/sprints/${encodeURIComponent(sprint_id)}`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('delete_sprint', 'Delete sprint', {
    sprint_id: z.string().describe('Sprint ID'),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/v2/sprints/${encodeURIComponent(sprint_id)}`, { method: 'DELETE' });
      return ok(data);
    } catch (e) { return handleError(e); }
  });
}
