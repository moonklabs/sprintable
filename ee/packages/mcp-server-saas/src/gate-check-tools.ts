import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

let _pmApiUrl = '';
let _agentApiKey = '';

export function configureSaasGateMcpApi(pmApiUrl: string, agentApiKey: string) {
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

export function registerGateCheckTools(server: McpServer) {
  server.tool(
    'check_workflow_gate',
    'Check workflow gate before executing a tool on an entity. Evaluates atomic conditions against the active workflow instance. Returns pass/fail with violations list. In enforce mode, a failed gate blocks the tool call.',
    {
      entity_type: z.string().describe('Entity type: story | sprint | epic | task | document | retro_session'),
      entity_id: z.string().describe('UUID of the entity to check'),
      tool_name: z.string().describe('Name of the MCP tool being gated'),
      org_id: z.string().describe('Organization ID'),
      project_id: z.string().describe('Project ID'),
      actor_role: z.string().optional().describe('Caller role (default: member)'),
    },
    async (args) => {
      try {
        const data = await pmApi('/api/gate-check', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );

  server.tool(
    'create_workflow_instance',
    'Create a workflow instance for an entity under a specific contract (SaaS only).',
    {
      contract_id: z.string().describe('Workflow contract UUID'),
      entity_id: z.string().describe('Entity UUID'),
      initial_state: z.string().describe('Starting state (must match contract definition)'),
    },
    async (args) => {
      try {
        const data = await pmApi('/api/workflow-instances', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );
}
