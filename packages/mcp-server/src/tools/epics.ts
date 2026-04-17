import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function handleError(e: unknown) { return err(e instanceof PmApiError ? e.message : String(e)); }

export function registerEpicsTools(server: McpServer) {
  server.tool('list_epics', 'List epics', {
    project_id: z.string().describe('Project ID'),
  }, async ({ project_id }) => {
    try {
      const data = await pmApi(`/api/epics?project_id=${encodeURIComponent(project_id)}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('add_epic', 'Create epic', {
    project_id: z.string(),
    title: z.string(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    description: z.string().optional(),
  }, async (body) => {
    try {
      const data = await pmApi('/api/epics', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('update_epic', 'Update epic', {
    epic_id: z.string(),
    title: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().optional(),
    description: z.string().optional(),
  }, async ({ epic_id, ...updates }) => {
    try {
      const data = await pmApi(`/api/epics/${encodeURIComponent(epic_id)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('delete_epic', 'Delete epic', {
    epic_id: z.string(),
  }, async ({ epic_id }) => {
    try {
      await pmApi(`/api/epics/${encodeURIComponent(epic_id)}`, { method: 'DELETE' });
      return ok({ deleted: true });
    } catch (e) { return handleError(e); }
  });
}
