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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function OssPersonaFormClient({ agents }: { agents: any[] }) {
  'use client';
  return (
    <form
      action="/api/agents/personas"
      method="POST"
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const res = await fetch('/api/agents/personas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name'),
            agent_id: fd.get('agent_id'),
            system_prompt: fd.get('system_prompt'),
            description: fd.get('description'),
          }),
        });
        if (res.ok) window.location.href = '/agents';
      }}
    >
      <div className="space-y-2">
        <label className="text-sm font-medium">Agent</label>
        <select name="agent_id" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Persona Name</label>
        <input name="name" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="e.g. Helpful Assistant" required />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">System Prompt</label>
        <textarea name="system_prompt" rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="You are a helpful assistant..." />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Description (optional)</label>
        <input name="description" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="Brief description" />
      </div>
      <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
        Create Persona
      </button>
    </form>
  );
}
