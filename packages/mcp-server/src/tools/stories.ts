import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function handleError(e: unknown) { return err(e instanceof PmApiError ? e.message : String(e)); }

export function registerStoriesTools(server: McpServer) {
  server.tool('list_stories', 'List stories', {
    project_id: z.string().describe('Project ID'),
    sprint_id: z.string().optional(),
    epic_id: z.string().optional(),
    assignee_id: z.string().optional(),
    status: z.string().optional(),
  }, async ({ project_id, sprint_id, epic_id, assignee_id, status }) => {
    try {
      const params = new URLSearchParams({ project_id });
      if (sprint_id) params.set('sprint_id', sprint_id);
      if (epic_id) params.set('epic_id', epic_id);
      if (assignee_id) params.set('assignee_id', assignee_id);
      if (status) params.set('status', status);
      const data = await pmApi(`/api/stories?${params.toString()}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('list_backlog', 'List backlog (no sprint)', {
    project_id: z.string().describe('Project ID'),
  }, async ({ project_id }) => {
    try {
      const data = await pmApi(`/api/stories/backlog?project_id=${encodeURIComponent(project_id)}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('add_story', 'Create story', {
    project_id: z.string().describe('Project ID'),
    title: z.string(),
    epic_id: z.string().optional(),
    sprint_id: z.string().optional(),
    assignee_id: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    story_points: z.number().optional(),
    description: z.string().optional(),
  }, async (body) => {
    try {
      const data = await pmApi('/api/stories', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('update_story', 'Update story', {
    story_id: z.string(),
    title: z.string().optional(),
    priority: z.string().optional(),
    story_points: z.number().optional(),
    description: z.string().optional(),
    assignee_id: z.string().optional(),
    epic_id: z.string().optional(),
  }, async ({ story_id, ...updates }) => {
    try {
      const data = await pmApi(`/api/stories/${encodeURIComponent(story_id)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('delete_story', 'Delete story', {
    story_id: z.string(),
  }, async ({ story_id }) => {
    try {
      await pmApi(`/api/stories/${encodeURIComponent(story_id)}`, { method: 'DELETE' });
      return ok({ deleted: true });
    } catch (e) { return handleError(e); }
  });

  server.tool('assign_story_to_sprint', 'Assign story to sprint', {
    story_id: z.string(),
    sprint_id: z.string(),
  }, async ({ story_id, sprint_id }) => {
    try {
      const data = await pmApi(`/api/stories/${encodeURIComponent(story_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sprint_id }),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('unassign_story_from_sprint', 'Remove story from sprint', {
    story_id: z.string(),
  }, async ({ story_id }) => {
    try {
      const data = await pmApi(`/api/stories/${encodeURIComponent(story_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sprint_id: null }),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('update_story_status', 'Update story status', {
    story_id: z.string(),
    status: z.string().describe('backlog | ready-for-dev | in-progress | in-review | done'),
  }, async ({ story_id, status }) => {
    try {
      const data = await pmApi(`/api/stories/${encodeURIComponent(story_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });
}
