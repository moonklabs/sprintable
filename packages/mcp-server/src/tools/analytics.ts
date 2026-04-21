import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
}

export function registerAnalyticsTools(server: McpServer) {
  // GET /api/analytics/overview
  server.tool(
    'get_project_overview',
    'Get project overview stats',
    {
      project_id: z.string().describe('Project ID'),
    },
    async ({ project_id }) => {
      try {
        const params = new URLSearchParams({ project_id });
        const data = await pmApi(`/api/analytics/overview?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/analytics/workload
  server.tool(
    'get_member_workload',
    'Get workload for a member',
    {
      project_id: z.string().describe('Project ID'),
      member_id: z.string().describe('Team member ID'),
    },
    async ({ project_id, member_id }) => {
      try {
        const params = new URLSearchParams({ project_id, member_id });
        const data = await pmApi(`/api/analytics/workload?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/analytics/velocity-history
  server.tool(
    'get_sprint_velocity_history',
    'Get velocity across closed sprints',
    {
      project_id: z.string().describe('Project ID'),
    },
    async ({ project_id }) => {
      try {
        const params = new URLSearchParams({ project_id });
        const data = await pmApi(`/api/analytics/velocity-history?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/stories?q=
  server.tool(
    'search_stories',
    'Search stories by title',
    {
      project_id: z.string().describe('Project ID'),
      query: z.string().describe('Search query'),
    },
    async ({ project_id, query }) => {
      try {
        const params = new URLSearchParams({ project_id, q: query });
        const data = await pmApi(`/api/stories?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/stories?status=in-review
  server.tool(
    'get_blocked_stories',
    'Get stories with status in-review',
    {
      project_id: z.string().describe('Project ID'),
      sprint_id: z.string().optional().describe('Optional sprint filter'),
    },
    async ({ project_id, sprint_id }) => {
      try {
        const params = new URLSearchParams({ project_id, status: 'in-review' });
        if (sprint_id) params.set('sprint_id', sprint_id);
        const data = await pmApi(`/api/stories?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/stories?unassigned=true
  server.tool(
    'get_unassigned_stories',
    'Get stories without assignee',
    {
      project_id: z.string().describe('Project ID'),
      sprint_id: z.string().optional().describe('Optional sprint filter'),
    },
    async ({ project_id, sprint_id }) => {
      try {
        const params = new URLSearchParams({ project_id, unassigned: 'true' });
        if (sprint_id) params.set('sprint_id', sprint_id);
        const data = await pmApi(`/api/stories?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/tasks?status_ne=done
  server.tool(
    'get_overdue_tasks',
    'Get incomplete tasks',
    {
      project_id: z.string().describe('Project ID'),
      member_id: z.string().optional().describe('Filter by assignee'),
    },
    async ({ project_id, member_id }) => {
      try {
        const params = new URLSearchParams({ project_id, status_ne: 'done' });
        if (member_id) params.set('assignee_id', member_id);
        const data = await pmApi(`/api/tasks?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/analytics/activity
  server.tool(
    'get_recent_activity',
    'Get recent project activity',
    {
      project_id: z.string().describe('Project ID'),
      limit: z.number().optional().describe('Max items per category'),
    },
    async ({ project_id, limit }) => {
      try {
        const params = new URLSearchParams({ project_id });
        if (limit !== undefined) params.set('limit', String(limit));
        const data = await pmApi(`/api/analytics/activity?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // PATCH /api/stories/:id — assign story to member
  server.tool(
    'assign_story',
    'Assign story to a team member',
    {
      story_id: z.string().describe('Story ID'),
      assignee_id: z.string().describe('Team member ID to assign'),
    },
    async ({ story_id, assignee_id }) => {
      try {
        const data = await pmApi(`/api/stories/${story_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ assignee_id }),
        });
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/analytics/epic-progress
  server.tool(
    'get_epic_progress',
    'Get progress for an epic',
    {
      project_id: z.string().describe('Project ID'),
      epic_id: z.string().describe('Epic ID'),
    },
    async ({ project_id, epic_id }) => {
      try {
        const params = new URLSearchParams({ project_id, epic_id });
        const data = await pmApi(`/api/analytics/epic-progress?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/analytics/agent-stats
  server.tool(
    'get_agent_stats',
    'Get agent performance stats',
    {
      project_id: z.string().describe('Project ID'),
      agent_id: z.string().describe('Agent team member ID'),
    },
    async ({ project_id, agent_id }) => {
      try {
        const params = new URLSearchParams({ project_id, agent_id });
        const data = await pmApi(`/api/analytics/agent-stats?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/analytics/health
  server.tool(
    'get_project_health',
    'Get overall project health',
    {
      project_id: z.string().describe('Project ID'),
    },
    async ({ project_id }) => {
      try {
        const params = new URLSearchParams({ project_id });
        const data = await pmApi(`/api/analytics/health?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );
}
