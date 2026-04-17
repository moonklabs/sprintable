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
      const data = await pmApi(`/api/sprints?${params.toString()}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('activate_sprint', 'Activate sprint (planning → active)', {
    sprint_id: z.string(),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/sprints/${encodeURIComponent(sprint_id)}/activate`, { method: 'POST' });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('close_sprint', 'Close sprint (active → closed)', {
    sprint_id: z.string(),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/sprints/${encodeURIComponent(sprint_id)}/close`, { method: 'POST' });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('get_velocity', 'Get sprint velocity', {
    sprint_id: z.string(),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/sprints/${encodeURIComponent(sprint_id)}/velocity`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('sprint_summary', 'Get sprint story summary by status', {
    sprint_id: z.string(),
  }, async ({ sprint_id }) => {
    try {
      const data = await pmApi(`/api/sprints/${encodeURIComponent(sprint_id)}/summary`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });
}
