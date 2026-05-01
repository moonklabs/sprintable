import { redirect } from 'next/navigation';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentsDashboard } from '@/components/agents/agents-dashboard';
import { buildDeploymentCards } from '@/services/agent-dashboard';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { isOssMode } from '@/lib/storage/factory';

export default async function AgentsPage() {
  if (isOssMode()) {
    return <AgentsDashboard deployments={[]} />;
  }
  // SaaS-only path — not reached in OSS mode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return null as any;
}
