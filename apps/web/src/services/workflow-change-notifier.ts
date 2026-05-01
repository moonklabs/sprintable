// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { MemoService } from './memo';
import type { RoutingRuleSummary } from './agent-routing-rule';

interface WorkflowChangeNotifyInput {
  orgId: string;
  projectId: string;
  actorId: string;
  newRules: RoutingRuleSummary[];
}

interface LatestVersionRow {
  id: string;
  version: number;
  change_summary: { added_rules: number; removed_rules: number; changed_rules: number };
}

function buildMemoContent(version: number, summary: { added_rules: number; removed_rules: number; changed_rules: number }): string {
  const lines = [
    `🔔 워크플로우 업데이트 (버전 ${version})`,
    '',
    '변경 요약:',
    `- 추가된 규칙: ${summary.added_rules}`,
    `- 삭제된 규칙: ${summary.removed_rules}`,
    `- 수정된 규칙: ${summary.changed_rules}`,
    '',
    '`get_my_workflow` 도구로 현재 라우팅 설정을 확인하세요.',
  ];
  return lines.join('\n');
}

export async function notifyWorkflowChange(
  supabase: SupabaseClient,
  input: WorkflowChangeNotifyInput,
): Promise<void> {
  const { data: versionRows } = await supabase
    .from('workflow_versions')
    .select('id, version, change_summary')
    .eq('org_id', input.orgId)
    .eq('project_id', input.projectId)
    .order('version', { ascending: false })
    .limit(1);

  const latestVersion = (versionRows?.[0] ?? null) as LatestVersionRow | null;
  if (!latestVersion) return;

  const agentIdSet = new Set<string>();
  for (const rule of input.newRules) {
    agentIdSet.add(rule.agent_id);
    if (rule.action.forward_to_agent_id) {
      agentIdSet.add(rule.action.forward_to_agent_id);
    }
  }

  const agentIds = Array.from(agentIdSet);
  if (agentIds.length === 0) return;

  const content = buildMemoContent(
    latestVersion.version,
    latestVersion.change_summary ?? { added_rules: 0, removed_rules: 0, changed_rules: 0 },
  );

  const memoService = MemoService.fromSupabase(supabase);
  const memoIds: string[] = [];

  for (const agentId of agentIds) {
    try {
      const memo = await memoService.create({
        org_id: input.orgId,
        project_id: input.projectId,
        title: `🔔 워크플로우 업데이트 (버전 ${latestVersion.version})`,
        content,
        memo_type: 'system_workflow_update',
        assigned_to_ids: [agentId],
        created_by: input.actorId,
      });
      memoIds.push(memo.id);
    } catch (err) {
      console.warn(`[notifyWorkflowChange] memo create failed for agent ${agentId}:`, err);
    }
  }

  await supabase.from('workflow_change_events').insert({
    org_id: input.orgId,
    project_id: input.projectId,
    workflow_version_id: latestVersion.id,
    notified_agent_ids: agentIds,
    memo_ids: memoIds,
  });
}
