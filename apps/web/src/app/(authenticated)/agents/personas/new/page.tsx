import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { checkFeatureLimit } from '@/lib/check-feature';
import { AgentPersonaComposer, type PersonaComposerAgent, type PersonaComposerPersona } from '@/components/agents/agent-persona-composer';
import { AgentOrchestrationUpgradeState } from '@/components/agents/agent-orchestration-gate';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { buttonVariants } from '@/components/ui/button';
import { AgentPersonaService, MANAGED_SAFETY_LAYER_NOTICE } from '@/services/agent-persona';
import { listProjectPersonaToolOptions } from '@/services/persona-composer';
import { isOssMode } from '@/lib/storage/factory';
import { OssPersonaFormClient } from './oss-persona-form-client';

export default async function NewAgentPersonaPage() {
  if (isOssMode()) {
    const { getOssUserContext } = await import('@/lib/auth-helpers');
    const { me } = await getOssUserContext();
    const { createTeamMemberRepository } = await import('@/lib/storage/factory');
    const agents = me ? await (await createTeamMemberRepository()).list({ org_id: me.org_id, project_id: me.project_id, type: 'agent', is_active: true }) : [];
    return <OssPersonaForm agents={agents} />;
  }
  // SaaS-only path — not reached in OSS mode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return null as any;
}

// Minimal OSS persona creation form
function OssPersonaForm({ agents }: { agents: Array<{ id: string; name: string }> }) {
  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">New Agent Persona</h2>
        <p className="mt-1 text-sm text-muted-foreground">Create a persona for an agent in this project</p>
      </div>
      {agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents in this project. Add an agent member first.</p>
      ) : (
        <OssPersonaFormClient agents={agents} />
      )}
    </div>
  );
}

