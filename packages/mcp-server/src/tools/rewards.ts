import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }

export function registerRewardsTools(server: McpServer) {
  server.tool('get_wallet', 'Get reward balance for a member', {
    project_id: z.string(),
    member_id: z.string(),
  }, async ({ project_id, member_id }) => {
    try {
      const data = await pmApi(`/api/rewards?project_id=${project_id}&member_id=${member_id}&balance=true`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('give_reward', 'Grant reward/penalty to a member', {
    project_id: z.string(),
    member_id: z.string(),
    amount: z.number(),
    reason: z.string(),
    granted_by: z.string(),
    reference_type: z.string().optional(),
    reference_id: z.string().optional(),
  }, async ({ project_id, member_id, amount, reason, granted_by, reference_type, reference_id }) => {
    try {
      const body: Record<string, unknown> = { project_id, member_id, amount, reason, granted_by };
      if (reference_type) body.reference_type = reference_type;
      if (reference_id) body.reference_id = reference_id;
      const data = await pmApi('/api/rewards', { method: 'POST', body: JSON.stringify(body) });
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });

  server.tool('get_leaderboard_v2', 'Get reward leaderboard for project with optional period filter', {
    project_id: z.string(),
    period: z.enum(['all', 'daily', 'weekly', 'monthly']).optional().describe('Time period (default: all)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 50)'),
  }, async ({ project_id, period, limit }) => {
    try {
      const params = new URLSearchParams({ project_id });
      if (period) params.set('period', period);
      if (limit !== undefined) params.set('limit', String(limit));
      const data = await pmApi(`/api/rewards/leaderboard?${params.toString()}`);
      return ok(data);
    } catch (e) {
      return err(e instanceof PmApiError ? e.message : String(e));
    }
  });
}
