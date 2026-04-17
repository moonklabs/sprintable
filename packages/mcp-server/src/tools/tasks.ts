import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function handleError(e: unknown) { return err(e instanceof PmApiError ? e.message : String(e)); }

export function registerTasksTools(server: McpServer) {
  server.tool('list_tasks', 'List tasks', {
    project_id: z.string().optional().describe('Filter by project ID'),
    story_id: z.string().optional().describe('Filter by parent story ID'),
    assignee_id: z.string().optional().describe('Filter by assignee team_member ID'),
    status: z.string().optional().describe('Filter by status: todo | in-progress | done'),
  }, async ({ project_id, story_id, assignee_id, status }) => {
    try {
      const params = new URLSearchParams();
      if (project_id) params.set('project_id', project_id);
      if (story_id) params.set('story_id', story_id);
      if (assignee_id) params.set('assignee_id', assignee_id);
      if (status) params.set('status', status);
      const data = await pmApi(`/api/tasks?${params.toString()}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('list_my_tasks', 'List tasks assigned to a member', {
    project_id: z.string().optional().describe('Filter by project ID'),
    assignee_id: z.string().describe('Team member ID whose tasks to list'),
  }, async ({ project_id, assignee_id }) => {
    try {
      const params = new URLSearchParams({ assignee_id });
      if (project_id) params.set('project_id', project_id);
      const data = await pmApi(`/api/tasks?${params.toString()}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('get_task', 'Get task by ID', {
    task_id: z.string(),
  }, async ({ task_id }) => {
    try {
      const data = await pmApi(`/api/tasks/${encodeURIComponent(task_id)}`);
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('add_task', 'Create a task under a story', {
    story_id: z.string(),
    title: z.string(),
    assignee_id: z.string().optional(),
    story_points: z.number().optional(),
    status: z.string().optional().describe('todo | in-progress | done (default: todo)'),
  }, async (body) => {
    try {
      const data = await pmApi('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('update_task', 'Update task fields', {
    task_id: z.string(),
    title: z.string().optional(),
    assignee_id: z.string().nullable().optional(),
    story_points: z.number().nullable().optional(),
  }, async ({ task_id, ...updates }) => {
    try {
      const data = await pmApi(`/api/tasks/${encodeURIComponent(task_id)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('update_task_status', 'Update task status', {
    task_id: z.string(),
    status: z.string().describe('todo | in-progress | done'),
  }, async ({ task_id, status }) => {
    try {
      const data = await pmApi(`/api/tasks/${encodeURIComponent(task_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      return ok(data);
    } catch (e) { return handleError(e); }
  });

  server.tool('delete_task', 'Delete (soft) a task', {
    task_id: z.string(),
  }, async ({ task_id }) => {
    try {
      await pmApi(`/api/tasks/${encodeURIComponent(task_id)}`, { method: 'DELETE' });
      return ok({ deleted: true });
    } catch (e) { return handleError(e); }
  });
}
