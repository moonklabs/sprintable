import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

let _pmApiUrl = '';
let _agentApiKey = '';

export function configureSaasStoryMcpApi(pmApiUrl: string, agentApiKey: string) {
  _pmApiUrl = pmApiUrl.replace(/\/$/, '');
  _agentApiKey = agentApiKey;
}

async function pmApi(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${_pmApiUrl}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${_agentApiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }

export function registerStoryWorkflowTools(server: McpServer) {
  server.tool(
    'update_story_status_gated',
    'Update story status through the workflow gate check (SaaS only). In enforce mode, gate violations block the status change. In evaluate mode, violations are logged but the update proceeds.',
    {
      story_id: z.string().describe('Story UUID'),
      status: z.string().describe('Target status: backlog | ready-for-dev | in-progress | in-review | done'),
      org_id: z.string().describe('Organization ID'),
      project_id: z.string().describe('Project ID'),
    },
    async ({ story_id, status, org_id, project_id }) => {
      try {
        const data = await pmApi(
          `/api/stories/${encodeURIComponent(story_id)}/status?org_id=${encodeURIComponent(org_id)}&project_id=${encodeURIComponent(project_id)}`,
          { method: 'PATCH', body: JSON.stringify({ status }) },
        );
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );

  server.tool(
    'get_default_story_contract',
    'Get or auto-create the default story workflow contract for an organization (SaaS only).',
    {
      org_id: z.string().describe('Organization ID'),
    },
    async ({ org_id }) => {
      try {
        const data = await pmApi(`/api/workflow-contracts/default?org_id=${encodeURIComponent(org_id)}&entity_type=story`);
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );

  server.tool(
    'set_contract_mode',
    'Switch a workflow contract between evaluate (advisory) and enforce (blocking) mode (SaaS only, AC4).',
    {
      contract_id: z.string().describe('Contract UUID'),
      org_id: z.string().describe('Organization ID'),
      mode: z.enum(['evaluate', 'enforce']).describe('evaluate: log only | enforce: block on gate fail'),
    },
    async ({ contract_id, org_id, mode }) => {
      try {
        const data = await pmApi(
          `/api/workflow-contracts/${encodeURIComponent(contract_id)}/mode?org_id=${encodeURIComponent(org_id)}`,
          { method: 'PATCH', body: JSON.stringify({ mode }) },
        );
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );
}
