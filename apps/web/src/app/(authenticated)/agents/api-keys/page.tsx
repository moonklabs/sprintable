'use client';

import { useEffect, useState } from 'react';
import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';

interface Agent {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
}

export default function ApiKeysPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAgents() {
      try {
        const res = await fetch('/api/team-members?type=agent');
        if (!res.ok) return;
        const json = await res.json() as { data?: Agent[] };
        setAgents((json.data ?? []).filter((m) => m.type === 'agent' && m.is_active));
      } finally {
        setLoading(false);
      }
    }
    void loadAgents();
  }, []);

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Agent API Keys</h1>
        <p className="text-muted-foreground mt-2">
          Manage API keys for agent authentication
        </p>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg border border-border bg-muted/30" />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">No active agent members in this project.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {agents.map((agent) => (
            <div key={agent.id} className="space-y-4">
              <AgentApiKeyManager agentId={agent.id} agentName={agent.name} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
