import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function handleError(e: unknown) { return err(e instanceof PmApiError ? e.message : String(e)); }

export function registerDocsTools(server: McpServer) {
  server.tool('list_docs', 'List docs tree for project', {
    project_id: z.string().describe('Project ID'),
  }, async ({ project_id }) => {
    try {
      const data = await pmApi(`/api/docs?project_id=${encodeURIComponent(project_id)}&view=tree`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('get_doc', 'Get doc by slug', {
    project_id: z.string().describe('Project ID'),
    slug: z.string(),
  }, async ({ project_id, slug }) => {
    try {
      const data = await pmApi(`/api/docs?project_id=${encodeURIComponent(project_id)}&slug=${encodeURIComponent(slug)}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('create_doc', 'Create a new doc', {
    title: z.string(),
    slug: z.string(),
    content: z.string().optional(),
    content_format: z.enum(['markdown', 'html']).optional(),
    parent_id: z.string().optional(),
    is_folder: z.boolean().optional(),
    icon: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }, async (body) => {
    try {
      const data = await pmApi('/api/docs', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('update_doc', 'Update doc content/title', {
    doc_id: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    content_format: z.enum(['markdown', 'html']).optional(),
    icon: z.string().optional(),
    tags: z.array(z.string()).optional(),
    expected_updated_at: z.string().optional().describe('ISO timestamp for optimistic concurrency check'),
    force_overwrite: z.boolean().optional().describe('Skip conflict check and force write'),
  }, async ({ doc_id, ...updates }) => {
    try {
      const data = await pmApi(`/api/docs/${encodeURIComponent(doc_id)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('delete_doc', 'Soft-delete a doc', {
    doc_id: z.string(),
  }, async ({ doc_id }) => {
    try {
      await pmApi(`/api/docs/${encodeURIComponent(doc_id)}`, { method: 'DELETE' });
      return ok({ deleted: true });
    } catch (e) { return handleError(e); }
  });

  server.tool('search_docs', 'Search docs by title/content', {
    project_id: z.string().describe('Project ID'),
    query: z.string(),
  }, async ({ project_id, query }) => {
    try {
      const data = await pmApi(`/api/docs?project_id=${encodeURIComponent(project_id)}&q=${encodeURIComponent(query)}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });
}
