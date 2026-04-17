import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pmApi, PmApiError } from '../pm-api.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
}

export function registerAgentRunsTools(server: McpServer) {
  // POST /api/agent-runs
  server.tool(
    'emit_event',
    'Emit an agent run event (creates a new agent_runs record)',
    {
      agent_id: z.string().describe('Team member ID of the agent'),
      trigger: z.string().describe('Event trigger name'),
      model: z.string().optional().describe('Model used'),
      story_id: z.string().optional().describe('Related story ID'),
      memo_id: z.string().optional().describe('Related memo ID'),
      result_summary: z.string().optional().describe('Summary of the run result'),
      status: z.enum(['running', 'completed', 'failed']).optional().describe('Run status (default: completed)'),
      error_message: z.string().optional().describe('Error message if failed'),
      input_tokens: z.number().optional().describe('Input token count'),
      output_tokens: z.number().optional().describe('Output token count'),
      started_at: z.string().optional().describe('ISO timestamp when run started'),
      finished_at: z.string().optional().describe('ISO timestamp when run finished'),
    },
    async ({ agent_id, trigger, model, story_id, memo_id, result_summary, status, error_message, input_tokens, output_tokens, started_at, finished_at }) => {
      try {
        const body: Record<string, unknown> = { agent_id, trigger };
        if (model !== undefined) body.model = model;
        if (story_id !== undefined) body.story_id = story_id;
        if (memo_id !== undefined) body.memo_id = memo_id;
        if (result_summary !== undefined) body.result_summary = result_summary;
        if (status !== undefined) body.status = status;
        if (error_message !== undefined) body.error_message = error_message;
        if (input_tokens !== undefined) body.input_tokens = input_tokens;
        if (output_tokens !== undefined) body.output_tokens = output_tokens;
        if (started_at !== undefined) body.started_at = started_at;
        if (finished_at !== undefined) body.finished_at = finished_at;
        const data = await pmApi('/api/agent-runs', { method: 'POST', body: JSON.stringify(body) });
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // PATCH /api/agent-runs/[id]
  server.tool(
    'update_run_status',
    'Update an existing agent run status (supports retry chain)',
    {
      run_id: z.string().describe('Agent run ID to update'),
      status: z.enum(['running', 'completed', 'failed']).describe('New status'),
      error_message: z.string().optional().describe('Error message if failed'),
      result_summary: z.string().optional().describe('Result summary'),
      input_tokens: z.number().optional().describe('Input token count'),
      output_tokens: z.number().optional().describe('Output token count'),
      cost_usd: z.number().optional().describe('Cost in USD'),
      started_at: z.string().optional().describe('ISO timestamp when run started'),
      finished_at: z.string().optional().describe('ISO timestamp when run finished'),
    },
    async ({ run_id, status, error_message, result_summary, input_tokens, output_tokens, cost_usd, started_at, finished_at }) => {
      try {
        const body: Record<string, unknown> = { status };
        if (error_message !== undefined) body.error_message = error_message;
        if (result_summary !== undefined) body.result_summary = result_summary;
        if (input_tokens !== undefined) body.input_tokens = input_tokens;
        if (output_tokens !== undefined) body.output_tokens = output_tokens;
        if (cost_usd !== undefined) body.cost_usd = cost_usd;
        if (started_at !== undefined) body.started_at = started_at;
        if (finished_at !== undefined) body.finished_at = finished_at;
        const data = await pmApi(`/api/agent-runs/${run_id}`, { method: 'PATCH', body: JSON.stringify(body) });
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );

  // GET /api/agent-runs?project_id=X&limit=N
  server.tool(
    'poll_events',
    'Poll recent agent run events for a project',
    {
      project_id: z.string().describe('Project ID'),
      limit: z.number().optional().describe('Max results (default: 20)'),
    },
    async ({ project_id, limit }) => {
      try {
        const params = new URLSearchParams({ project_id });
        if (limit !== undefined) params.set('limit', String(limit));
        const data = await pmApi(`/api/agent-runs?${params.toString()}`);
        return ok(data);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );
}
