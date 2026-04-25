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
