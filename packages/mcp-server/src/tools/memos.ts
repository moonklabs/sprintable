import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function handleError(e: unknown) { return err(e instanceof PmApiError ? e.message : String(e)); }

export function registerMemosTools(server: McpServer) {
  server.tool('list_memos', 'List memos', {
    project_id: z.string().optional().describe('Project ID'),
    assigned_to: z.string().optional().describe('Filter by assigned team member ID'),
    status: z.string().optional().describe('Filter by status (open/resolved)'),
    q: z.string().optional().describe('Search query'),
    include_archived: z.boolean().optional().describe('Include archived memos (default: false)'),
  }, async ({ project_id, assigned_to, status, q, include_archived }) => {
    try {
      const params = new URLSearchParams();
      if (project_id) params.set('project_id', project_id);
      if (assigned_to) params.set('assigned_to', assigned_to);
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      if (include_archived) params.set('include_archived', 'true');
      const qs = params.toString();
      const data = await pmApi(`/api/memos${qs ? `?${qs}` : ''}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('create_memo', 'Create memo', {
    project_id: z.string().optional(),
    title: z.string().optional(),
    content: z.string(),
    memo_type: z.string().optional(),
    assigned_to: z.string().optional().describe('Team member ID to assign'),
    story_id: z.string().optional(),
  }, async (body) => {
    try {
      const data = await pmApi('/api/memos', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('send_memo', 'Send a memo', {
    project_id: z.string().optional(),
    title: z.string().optional(),
    content: z.string(),
    memo_type: z.string().optional(),
    assigned_to: z.string().optional().describe('Single team member ID (legacy, use assigned_to_ids for multiple)'),
    assigned_to_ids: z.array(z.string()).optional().describe('Team member IDs to assign (supports multiple assignees)'),
  }, async ({ assigned_to, assigned_to_ids, ...rest }) => {
    try {
      const resolvedIds = assigned_to_ids ?? (assigned_to ? [assigned_to] : undefined);
      const payload = { ...rest, ...(resolvedIds ? { assigned_to_ids: resolvedIds } : {}) };
      const data = await pmApi('/api/memos', { method: 'POST', body: JSON.stringify(payload) });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('list_my_memos', 'List memos assigned to or created by a member', {
    assigned_to: z.string().optional().describe('Filter by assigned team member ID'),
    created_by: z.string().optional().describe('Filter by creator team member ID'),
    project_id: z.string().optional(),
    status: z.string().optional(),
  }, async ({ assigned_to, created_by, project_id, status }) => {
    try {
      const params = new URLSearchParams();
      if (project_id) params.set('project_id', project_id);
      if (assigned_to) params.set('assigned_to', assigned_to);
      if (created_by) params.set('created_by', created_by);
      if (status) params.set('status', status);
      const qs = params.toString();
      const data = await pmApi(`/api/memos${qs ? `?${qs}` : ''}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('read_memo', 'Read memo with replies', {
    memo_id: z.string().describe('Memo ID'),
  }, async ({ memo_id }) => {
    try {
      const data = await pmApi(`/api/memos/${encodeURIComponent(memo_id)}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('reply_memo', 'Reply to a memo', {
    memo_id: z.string(),
    content: z.string(),
    assigned_to: z.string().optional().describe('Single team member ID to explicitly notify via webhook (legacy, use assigned_to_ids for multiple)'),
    assigned_to_ids: z.array(z.string()).optional().describe('Team member IDs to explicitly notify via webhook on this reply'),
  }, async ({ memo_id, content, assigned_to, assigned_to_ids }) => {
    try {
      const resolvedIds = assigned_to_ids ?? (assigned_to ? [assigned_to] : undefined);
      const payload: Record<string, unknown> = { content };
      if (resolvedIds) payload.assigned_to_ids = resolvedIds;
      const data = await pmApi(`/api/memos/${encodeURIComponent(memo_id)}/replies`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('resolve_memo', 'Resolve a memo', {
    memo_id: z.string(),
  }, async ({ memo_id }) => {
    try {
      const data = await pmApi(`/api/memos/${encodeURIComponent(memo_id)}/resolve`, {
        method: 'PATCH',
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });
}
