import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
}

export function registerAuditTools(server: McpServer) {
  server.tool(
    'list_audit_logs',
    'List permission audit logs (member_added, member_removed, role_changed). Admin/owner only.',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Max records to return (default 50)'),
      cursor: z.string().optional().describe('Pagination cursor — created_at of last record (ISO timestamp)'),
    },
    async ({ limit, cursor }) => {
      try {
        const params = new URLSearchParams();
        if (limit !== undefined) params.set('limit', String(limit));
        if (cursor !== undefined) params.set('cursor', cursor);
        const qs = params.size > 0 ? `?${params.toString()}` : '';
        const data = await pmApi(`/api/audit-logs${qs}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );
}
