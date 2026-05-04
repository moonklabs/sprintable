import { redirect } from 'next/navigation';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { AgentHitlRequestsList } from '@/components/agents/agent-hitl-requests-list';

export default async function AgentHitlRequestsPage() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return null as any;
}
