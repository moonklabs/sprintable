import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }

export function registerMeetingTools(server: McpServer) {
  server.tool('list_meetings', 'List meetings for project', {
    meeting_type: z.enum(['standup', 'retro', 'general', 'review']).optional(),
    date_from: z.string().optional().describe('YYYY-MM-DD'),
    date_to: z.string().optional().describe('YYYY-MM-DD'),
    limit: z.number().optional(),
  }, async ({ meeting_type, date_from, date_to, limit }) => {
    try {
      const params = new URLSearchParams();
      if (meeting_type) params.set('meeting_type', meeting_type);
      if (date_from) params.set('date_from', date_from);
      if (date_to) params.set('date_to', date_to);
      if (limit !== undefined) params.set('limit', String(limit));
      const query = params.toString();
      const data = await pmApi(`/api/meetings${query ? `?${query}` : ''}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('get_meeting', 'Get meeting details', {
    meeting_id: z.string(),
  }, async ({ meeting_id }) => {
    try {
      const data = await pmApi(`/api/meetings/${meeting_id}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('create_meeting', 'Create meeting', {
    title: z.string(),
    meeting_type: z.enum(['standup', 'retro', 'general', 'review']).optional(),
    date: z.string().optional().describe('ISO datetime'),
    duration_min: z.number().optional(),
    participants: z.array(z.object({ name: z.string() })).optional(),
    created_by: z.string().optional().describe('team_member ID'),
  }, async ({ title, meeting_type, date, duration_min, participants, created_by }) => {
    try {
      const body: Record<string, unknown> = { title };
      if (meeting_type) body.meeting_type = meeting_type;
      if (date) body.date = date;
      if (duration_min !== undefined) body.duration_min = duration_min;
      if (participants) body.participants = participants;
      if (created_by) body.created_by = created_by;
      const data = await pmApi('/api/meetings', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('update_meeting', 'Update meeting', {
    meeting_id: z.string(),
    title: z.string().optional(),
    meeting_type: z.enum(['standup', 'retro', 'general', 'review']).optional(),
    date: z.string().optional(),
    duration_min: z.number().optional(),
    participants: z.array(z.object({ name: z.string() })).optional(),
    raw_transcript: z.string().optional(),
    ai_summary: z.string().optional(),
    decisions: z.array(z.object({ id: z.string(), text: z.string(), owner: z.string().optional() })).optional(),
    action_items: z.array(z.object({ id: z.string(), text: z.string(), assignee: z.string().optional(), due_date: z.string().optional(), status: z.string().optional() })).optional(),
  }, async ({ meeting_id, ...updates }) => {
    try {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) body[k] = v;
      }
      const data = await pmApi(`/api/meetings/${meeting_id}`, { method: 'PUT', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('delete_meeting', 'Soft delete meeting', {
    meeting_id: z.string(),
  }, async ({ meeting_id }) => {
    try {
      const data = await pmApi(`/api/meetings/${meeting_id}`, { method: 'DELETE' });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('trigger_ai_summary', 'Trigger AI structuring on meeting transcript', {
    meeting_id: z.string(),
  }, async ({ meeting_id }) => {
    try {
      const data = await pmApi(`/api/meetings/${meeting_id}/summary`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });
}
