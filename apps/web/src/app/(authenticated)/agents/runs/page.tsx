import { redirect } from 'next/navigation';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { AgentRunsList } from '@/components/agents/agent-runs-list';
import { isOssMode } from '@/lib/storage/factory';

export default async function AgentRunsPage() {
  if (isOssMode()) {
    return <AgentRunsList />;
  }
  // SaaS-only path — not reached in OSS mode
  return null;
}
