/**
 * S6 — 워크플로우 상태 조회 MCP 도구
 *
 * AC1: get_workflow_state — 현재 상태 + 가능한 전이 + gate 충족 여부
 * AC2: 도구 description에 계약 정보(enforce/evaluate 모드) soft guidance 포함
 * AC3: get_my_workflow_saas — 기존 get_my_workflow + active_contracts + current_instance
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

let _pmApiUrl = '';
let _agentApiKey = '';

export function configureSaasWorkflowStateApi(pmApiUrl: string, agentApiKey: string) {
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

export function registerWorkflowStateTools(server: McpServer) {
  // ── AC1 + AC2 ──────────────────────────────────────────────────────────────
  server.tool(
    'get_workflow_state',
    [
      'Get the current workflow state and available transitions for an entity (SaaS only).',
      'Returns: current_state, contract_id, contract_mode (evaluate=advisory/enforce=blocking),',
      'and transitions_available with gate_satisfied flag for each.',
      'Use this before calling update_story_status_gated or any gated tool',
      'to check which transitions are ready and what conditions must be met.',
      'In enforce mode, unsatisfied gates will block the transition with a 422 error.',
    ].join(' '),
    {
      entity_type: z.enum(['story', 'sprint', 'epic', 'task', 'document', 'retro_session'])
        .describe('Entity type'),
      entity_id: z.string().describe('Entity UUID'),
      org_id: z.string().describe('Organization ID'),
      project_id: z.string().describe('Project ID'),
    },
    async ({ entity_type, entity_id, org_id, project_id }) => {
      try {
        const params = new URLSearchParams({ entity_type, entity_id, org_id, project_id });
        const data = await pmApi(`/api/workflow-state?${params.toString()}`);
        return ok(data);
      } catch (e) { return err(String(e)); }
    },
  );

  // ── AC3: get_my_workflow SaaS 확장 버전 ───────────────────────────────────
  server.tool(
    'get_my_workflow_saas',
    [
      'SaaS extension of get_my_workflow.',
      'Returns the same routing/gate data as get_my_workflow,',
      'plus active_contracts (workflow contracts active for the org)',
      'and current_workflow_mode summary.',
      'Use this instead of get_my_workflow in SaaS deployments.',
    ].join(' '),
    {
      org_id: z.string().describe('Organization ID'),
      project_id: z.string().describe('Project ID'),
    },
    async ({ org_id, project_id }) => {
      try {
        // 기존 get_my_workflow 데이터 + SaaS 계약 데이터를 병합
        const [myWorkflow, contracts] = await Promise.all([
          pmApi('/api/me').then(async (me) => {
            const myId = (me as { id: string }).id;
            const [rules, versions] = await Promise.all([
              pmApi('/api/v1/agent-routing-rules').catch(() => []),
              pmApi('/api/v1/workflow-versions').catch(() => []),
            ]);
            return { me, myId, rules, versions };
          }).catch(() => null),
          pmApi(`/api/workflow-contracts?org_id=${encodeURIComponent(org_id)}&project_id=${encodeURIComponent(project_id)}`).catch(() => ({ data: [] })),
        ]);

        return ok({
          workflow: myWorkflow,
          active_contracts: contracts,
          hint: 'Use get_workflow_state to check transition readiness for a specific entity.',
        });
      } catch (e) { return err(String(e)); }
    },
  );
}
