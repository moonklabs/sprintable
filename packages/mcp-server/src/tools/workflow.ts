import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pmApi, PmApiError } from '../pm-api.js';

function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }] }; }
function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }

interface RoutingRule {
  id: string;
  agent_id: string;
  name: string;
  priority: number;
  conditions: { memo_type: string[] };
  action: { auto_reply_mode: string; forward_to_agent_id: string | null };
  is_enabled: boolean;
}

interface WorkflowVersion {
  id: string;
  version: number;
  created_at: string;
}

interface WorkflowGate {
  rule_id: string;
  rule_name: string;
  memo_types: string[];
  action: string;
  i_am: 'source' | 'target';
  forward_to: string | null;
}

function buildNaturalLanguageSummary(gates: WorkflowGate[], myId: string): string {
  if (gates.length === 0) return '워크플로우 미설정 — 현재 라우팅 규칙 없음.';

  const lines: string[] = [];
  for (const gate of gates) {
    const memoLabel = gate.memo_types.length > 0
      ? gate.memo_types.join(', ')
      : '모든 메모 타입';

    if (gate.i_am === 'source') {
      if (gate.action === 'process_and_forward') {
        lines.push(`[${memoLabel}] 수신 → 처리 후 ${gate.forward_to ?? '다음 에이전트'}에게 포워딩`);
      } else {
        lines.push(`[${memoLabel}] 수신 → 처리 후 원래 담당자에게 보고`);
      }
    } else {
      lines.push(`[${memoLabel}] 다른 에이전트로부터 포워딩 수신 (${gate.rule_name})`);
    }
  }

  return lines.join('\n');
}

export function registerWorkflowTools(server: McpServer) {
  server.tool(
    'get_my_workflow',
    'Get the current agent\'s workflow routing rules — version, role, gates, and natural language summary',
    {},
    async () => {
      try {
        // 1. Resolve own agent_id via API Key
        const me = await pmApi<{ id: string; name: string; type: string }>('/api/me');
        const myId = me.id;

        // 2. Fetch all routing rules for the project
        const rules = await pmApi<RoutingRule[]>('/api/v1/agent-routing-rules');

        // 3. Fetch latest workflow version
        let latestVersion: WorkflowVersion | null = null;
        try {
          const versions = await pmApi<WorkflowVersion[]>('/api/v1/workflow-versions');
          latestVersion = (Array.isArray(versions) && versions.length > 0 ? versions[0] : null) ?? null;
        } catch {
          // workflow_versions may not exist yet — graceful degradation
        }

        // 4. Filter gates: rules where I am source (agent_id) or target (forward_to_agent_id)
        const allRules = Array.isArray(rules) ? rules : [];
        const gates: WorkflowGate[] = [];
        const teamSet = new Set<string>();

        for (const rule of allRules) {
          const iAmSource = rule.agent_id === myId;
          const iAmTarget = rule.action.forward_to_agent_id === myId;

          if (!iAmSource && !iAmTarget) continue;

          teamSet.add(rule.agent_id);
          if (rule.action.forward_to_agent_id) {
            teamSet.add(rule.action.forward_to_agent_id);
          }

          gates.push({
            rule_id: rule.id,
            rule_name: rule.name,
            memo_types: rule.conditions.memo_type ?? [],
            action: rule.action.auto_reply_mode,
            i_am: iAmSource ? 'source' : 'target',
            forward_to: rule.action.forward_to_agent_id,
          });
        }

        // 5. Determine my_role
        const isSource = gates.some((g) => g.i_am === 'source');
        const isTarget = gates.some((g) => g.i_am === 'target');
        const myRole = isSource && isTarget
          ? 'processor_and_recipient'
          : isSource
            ? 'processor'
            : isTarget
              ? 'recipient'
              : 'none';

        // 6. Compose result
        const result = {
          version: latestVersion?.version ?? null,
          updated_at: latestVersion?.created_at ?? null,
          my_role: myRole,
          gates,
          team: Array.from(teamSet).filter((id) => id !== myId),
          natural_language_summary: buildNaturalLanguageSummary(gates, myId),
        };

        return ok(result);
      } catch (e) {
        return err(e instanceof PmApiError ? e.message : String(e));
      }
    },
  );
}
