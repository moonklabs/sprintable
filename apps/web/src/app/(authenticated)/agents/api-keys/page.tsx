import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';
import { AgentWebhookManager } from '@/components/agents/agent-webhook-manager';

export default async function ApiKeysPage() {
  return (
    <div className="container mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Agent API Keys</h1>
        <p className="text-muted-foreground mt-2">
          Manage API keys and webhook URLs for agent authentication
        </p>
      </div>

      <div className="space-y-6">
        <AgentApiKeyManager agentId="" agentName="Default Agent" />
        <AgentWebhookManager agentId="" agentName="Default Agent" currentWebhookUrl={null} />
      </div>
    </div>
  );
}
