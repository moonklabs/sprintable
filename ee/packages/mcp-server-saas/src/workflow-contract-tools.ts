import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

let _pmApiUrl = '';
let _agentApiKey = '';

export function configureSaasMcpApi(pmApiUrl: string, agentApiKey: string) {
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
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`PM API ${res.status}: ${text}`);
  }
  return res.json();
}

function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }

export function registerWorkflowContractTools(server: McpServer) {
  server.tool(
    'register_contract',
    'Register a new workflow contract (SaaS only). Validates atomic condition types and runs static graph analysis (deadlock/unreachable detection).',
    {
      org_id: z.string().describe('Organization ID'),
      name: z.string().describe('Contract name (unique per org+version)'),
      entity_type: z.string().describe('Entity type: story | sprint | epic | task | document | retro_session'),
      definition: z.object({
        states: z.array(z.string()).describe('All state names'),
        initial_state: z.string().describe('Starting state'),
        transitions: z.array(z.object({
          from: z.string(),
          to: z.string(),
          on_tool: z.string().describe('MCP tool name triggering this transition'),
          gate: z.record(z.unknown()).optional().describe('Gate expression (atomic conditions with all_of/any_of/none_of)'),
        })),
      }),
      mode: z.enum(['evaluate', 'enforce']).optional().describe('evaluate: advisory only | enforce: blocks tool execution'),
      version: z.number().int().positive().optional().describe('Contract version (default: 1)'),
    },
    async (args) => {
      try {
        const data = await pmApi('/api/workflow-contracts', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );

  server.tool(
    'get_contract',
    'Retrieve a workflow contract by ID (SaaS only).',
    {
      contract_id: z.string().describe('Contract UUID'),
      org_id: z.string().describe('Organization ID'),
    },
    async ({ contract_id, org_id }) => {
      try {
        const data = await pmApi(`/api/workflow-contracts/${encodeURIComponent(contract_id)}?org_id=${encodeURIComponent(org_id)}`);
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );

  server.tool(
    'list_contracts',
    'List active workflow contracts for an organization (SaaS only).',
    {
      org_id: z.string().describe('Organization ID'),
      entity_type: z.string().optional().describe('Filter by entity type'),
    },
    async ({ org_id, entity_type }) => {
      try {
        const params = new URLSearchParams({ org_id });
        if (entity_type) params.set('entity_type', entity_type);
        const data = await pmApi(`/api/workflow-contracts?${params.toString()}`);
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );
}
