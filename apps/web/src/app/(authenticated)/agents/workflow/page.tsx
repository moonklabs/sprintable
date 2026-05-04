import { redirect } from 'next/navigation';
import { AgentWorkflowEditor } from '@/components/agents/agent-workflow-editor';
import { requireOrgAdmin } from '@/lib/admin-check';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { AgentRoutingRuleService } from '@/services/agent-routing-rule';
import type { WorkflowMember } from '@/services/agent-workflow-editor';

export default async function AgentWorkflowPage() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return null as any;
}
