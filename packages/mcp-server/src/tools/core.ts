import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }

export function registerCoreTools(server: McpServer) {
  server.tool('list_team_members', 'List team members for project', {
    project_id: z.string().optional().describe('Explicit project ID'),
    current_member_id: z.string().optional().describe('Current project team_member ID used when project_id is omitted'),
  }, async ({ project_id, current_member_id }) => {
    try {
      const params = new URLSearchParams();
      if (project_id) params.set('project_id', project_id);
      if (current_member_id) params.set('current_member_id', current_member_id);
      const query = params.toString();
      const data = await pmApi(`/api/members${query ? `?${query}` : ''}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('my_dashboard', 'Dashboard summary for a member', {
    project_id: z.string().optional().describe('Explicit project ID'),
    member_id: z.string(),
  }, async ({ project_id, member_id }) => {
    try {
      const params = new URLSearchParams({ member_id });
      if (project_id) params.set('project_id', project_id);
      const data = await pmApi(`/api/dashboard?${params}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });
}
