import { redirect } from 'next/navigation';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';
import { AgentWebhookManager } from '@/components/agents/agent-webhook-manager';
import { isOssMode } from '@/lib/storage/factory';

export default async function ApiKeysPage() {
  if (isOssMode()) {
    redirect('/settings#members');
  }
  const db = null as any;
  const { data: { user } } = { data: { user: null } };
  if (!user) redirect('/login');

  const me = await getMyTeamMember(db, user);
  if (!me) redirect('/dashboard');

  // API Key 관리는 admin만 가능
  await requireOrgAdmin(db, me.org_id).catch(() => redirect('/dashboard'));

  // 프로젝트 내 모든 에이전트 조회 (webhook_url 포함)
  const { data: agents } = await db
    .from('team_members')
    .select('id, name, type, webhook_url')
    .eq('org_id', me.org_id)
    .eq('project_id', me.project_id)
    .eq('type', 'agent')
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Agent API Keys</h1>
        <p className="text-muted-foreground mt-2">
          Manage API keys and webhook URLs for agent authentication
        </p>
      </div>

      {!agents || agents.length === 0 ? (
        <p className="text-muted-foreground">No agents found in this project</p>
      ) : (
        <div className="space-y-6">
          {agents.map((agent) => (
            <div key={agent.id} className="space-y-3">
              <AgentApiKeyManager
                agentId={agent.id as string}
                agentName={agent.name as string}
              />
              <AgentWebhookManager
                agentId={agent.id as string}
                agentName={agent.name as string}
                currentWebhookUrl={(agent.webhook_url as string | null) ?? null}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
