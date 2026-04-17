import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
}

export function registerStandupsTools(server: McpServer) {
  // GET /api/standup?project_id=&member_id=&date=
  server.tool(
    'get_standup',
    'Get standup entry for a specific member and date',
    {
      project_id: z.string().describe('Project ID'),
      member_id: z.string().describe('Team member ID'),
      date: z.string().describe('Date in YYYY-MM-DD format'),
    },
    async ({ project_id, member_id, date }) => {
      try {
        const params = new URLSearchParams({ project_id, member_id, date });
        const data = await pmApi(`/api/standup?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // POST /api/standup
  server.tool(
    'save_standup',
    'Save or update a standup entry for a team member',
    {
      author_id: z.string().describe('Team member ID whose standup this is'),
      date: z.string().describe('Date in YYYY-MM-DD format'),
      done: z.string().optional().describe('What was done'),
      plan: z.string().optional().describe('What is planned'),
      blockers: z.string().optional().describe('Any blockers'),
      sprint_id: z.string().optional().describe('Sprint ID'),
      plan_story_ids: z.array(z.string()).optional().describe('Story IDs planned for this standup'),
    },
    async ({ author_id, date, done, plan, blockers, sprint_id, plan_story_ids }) => {
      try {
        const body: Record<string, unknown> = { author_id, date };
        if (done !== undefined) body.done = done;
        if (plan !== undefined) body.plan = plan;
        if (blockers !== undefined) body.blockers = blockers;
        if (sprint_id !== undefined) body.sprint_id = sprint_id;
        if (plan_story_ids !== undefined) body.plan_story_ids = plan_story_ids;
        const data = await pmApi('/api/standup', { method: 'POST', body: JSON.stringify(body) });
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/standup?project_id=&date=
  server.tool(
    'list_standup_entries',
    'List all standup entries for a project on a given date',
    {
      project_id: z.string().describe('Project ID'),
      date: z.string().describe('Date in YYYY-MM-DD format'),
    },
    async ({ project_id, date }) => {
      try {
        const params = new URLSearchParams({ project_id, date });
        const data = await pmApi(`/api/standup?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // POST /api/standup/feedback
  server.tool(
    'review_standup',
    'Post a review/feedback on a standup entry',
    {
      standup_entry_id: z.string().describe('Standup entry ID to review'),
      feedback_text: z.string().describe('Feedback content'),
      review_type: z.enum(['comment', 'approve', 'request_changes']).optional().describe('Review type (default: comment)'),
    },
    async ({ standup_entry_id, feedback_text, review_type }) => {
      try {
        const body: Record<string, unknown> = { standup_entry_id, feedback_text };
        if (review_type !== undefined) body.review_type = review_type;
        const data = await pmApi('/api/standup/feedback', { method: 'POST', body: JSON.stringify(body) });
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/standup/feedback/:entry_id
  server.tool(
    'get_standup_feedback',
    'Get all feedback for a standup entry',
    {
      standup_entry_id: z.string().describe('Standup entry ID'),
    },
    async ({ standup_entry_id }) => {
      try {
        const data = await pmApi(`/api/standup/feedback/${standup_entry_id}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );
}
