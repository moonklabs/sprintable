import { redirect } from 'next/navigation';
import { AgentWorkflowEditor } from '@/components/agents/agent-workflow-editor';
import { requireOrgAdmin } from '@/lib/admin-check';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { AgentRoutingRuleService } from '@/services/agent-routing-rule';
import type { WorkflowMember } from '@/services/agent-workflow-editor';
import { isOssMode } from '@/lib/storage/factory';

export default async function AgentWorkflowPage() {
  if (isOssMode()) {
    return (
      <div className="flex h-64 items-center justify-center p-6 text-center">
        <div>
          <h2 className="text-base font-semibold text-foreground">OSS 버전 미제공 기능인.</h2>
          <p className="mt-1 text-sm text-muted-foreground">에이전트 배포 관리는 SaaS 버전에서 이용 가능한.</p>
        </div>
      </div>
    );
  }
  // SaaS-only path — not reached in OSS mode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return null as any;
}
