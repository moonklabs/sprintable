import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function handleError(e: unknown) { return err(e instanceof PmApiError ? e.message : String(e)); }

export function registerActivityLogsTools(server: McpServer) {
  server.tool('list_activity_logs', 'List activity logs (agent actions, story updates, dispatch events)', {
    project_id: z.string().optional().describe('Filter by project ID'),
    actor_id: z.string().optional().describe('Filter by actor team member ID'),
    action: z.string().optional().describe('Filter by action (message_sent, story_updated, dispatch_triggered)'),
    entity_type: z.string().optional().describe('Filter by entity type (conversation, story, event)'),
    entity_id: z.string().optional().describe('Filter by entity ID'),
    from: z.string().optional().describe('Start datetime (ISO 8601)'),
    to: z.string().optional().describe('End datetime (ISO 8601)'),
    limit: z.number().optional().describe('Max results (default: 30, max: 100)'),
    offset: z.number().optional().describe('Pagination offset (default: 0)'),
  }, async ({ project_id, actor_id, action, entity_type, entity_id, from, to, limit, offset }) => {
    try {
      const params = new URLSearchParams();
      if (project_id) params.set('project_id', project_id);
      if (actor_id) params.set('actor_id', actor_id);
      if (action) params.set('action', action);
      if (entity_type) params.set('entity_type', entity_type);
      if (entity_id) params.set('entity_id', entity_id);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (limit !== undefined) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      const qs = params.toString();
      const data = await pmApi(`/api/v2/activity-logs${qs ? `?${qs}` : ''}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });
}
