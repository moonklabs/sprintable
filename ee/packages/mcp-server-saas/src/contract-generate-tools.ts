/**
 * S5 — generate_contract_from_nl MCP 도구
 *
 * 자연어 → LLM structured output → 계약 JSON preview.
 * 반환된 register_payload를 register_contract에 전달해 등록한다. (AC4)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

let _pmApiUrl = '';
let _agentApiKey = '';

export function configureSaasContractGenerateApi(pmApiUrl: string, agentApiKey: string) {
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

export function registerContractGenerateTools(server: McpServer) {
  server.tool(
    'generate_contract_from_nl',
    [
      'Convert natural language workflow rules into a contract JSON preview (SaaS only).',
      'Returns preview + register_payload. Pass register_payload to register_contract to finalize.',
      'validate.valid=false means the LLM output failed schema checks — retry or adjust the description.',
    ].join(' '),
    {
      natural_language: z.string().min(10).describe('Natural language description of the workflow rules'),
      entity_type: z.enum(['story', 'sprint', 'epic', 'task', 'document', 'retro_session'])
        .describe('Entity type the workflow governs'),
      org_id: z.string().describe('Organization ID'),
      project_id: z.string().describe('Project ID (used to resolve LLM config)'),
      suggested_name: z.string().optional().describe('Optional contract name hint'),
    },
    async ({ natural_language, entity_type, org_id, project_id, suggested_name }) => {
      try {
        const params = new URLSearchParams({ org_id, project_id });
        const body: Record<string, string> = { natural_language, entity_type };
        if (suggested_name) body['suggested_name'] = suggested_name;

        const data = await pmApi(`/api/workflow-contracts/generate?${params.toString()}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );
}
