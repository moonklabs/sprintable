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

export default async function NewAgentPersonaPage() {
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
  return null;
}
