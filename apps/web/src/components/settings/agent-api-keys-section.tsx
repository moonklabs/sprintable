'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';

interface AgentMember {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
}

interface ApiKey {
  id: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

interface NewKeyResult {
  id: string;
  key_prefix: string;
  api_key: string;
  created_at: string;
}

export function AgentApiKeysSection({ projectId }: { projectId: string }) {
  const [agents, setAgents] = useState<AgentMember[]>([]);
  const [keys, setKeys] = useState<Record<string, ApiKey[]>>({});
  const [newKey, setNewKey] = useState<{ agentId: string; result: NewKeyResult } | null>(null);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState('');
  const [adding, setAdding] = useState(false);
  const { addToast } = useToast();

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/team-members?project_id=${projectId}&type=agent`);
      const json = await res.json() as { data: AgentMember[] };
      const agentList = (json.data ?? []).filter((m) => m.type === 'agent');
      setAgents(agentList);
      const keyMap: Record<string, ApiKey[]> = {};
      await Promise.all(agentList.map(async (agent) => {
        const kr = await fetch(`/api/agents/${agent.id}/api-key`);
        const kj = await kr.json() as { data: ApiKey[] };
        keyMap[agent.id] = kj.data ?? [];
      }));
      setKeys(keyMap);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void fetchAgents(); }, [fetchAgents]);

  const handleIssue = useCallback(async (agentId: string) => {
    setIssuing(agentId);
    try {
      const res = await fetch(`/api/agents/${agentId}/api-key`, { method: 'POST' });
      const json = await res.json() as { data: NewKeyResult };
      setNewKey({ agentId, result: json.data });
      await fetchAgents();
    } finally {
      setIssuing(null);
    }
  }, [fetchAgents]);

  const handleRevoke = useCallback(async (agentId: string, keyId: string) => {
    setRevoking(keyId);
    try {
      await fetch(`/api/agents/${agentId}/api-key/${keyId}`, { method: 'DELETE' });
      await fetchAgents();
    } finally {
      setRevoking(null);
    }
  }, [fetchAgents]);

  const handleAddAgent = useCallback(async () => {
    const name = newAgentName.trim();
    if (!name) return;
    setAdding(true);
    try {
      const res = await fetch('/api/team-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, name, type: 'agent' }),
      });
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!res.ok) {
        addToast({ type: 'error', title: '에이전트 추가 실패', body: json?.error?.message ?? 'Failed to add agent' });
        return;
      }
      setNewAgentName('');
      await fetchAgents();
    } finally {
      setAdding(false);
    }
  }, [newAgentName, projectId, fetchAgents, addToast]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading...</div>;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold">🔑 Agent API Keys</h2>
          <p className="text-sm text-muted-foreground">에이전트 팀원의 API Key를 관리하는. MCP/HTTP API 전용 — UI 로그인 불가.</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody>
        <div className="mb-6 flex gap-2">
          <input
            type="text"
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAddAgent(); }}
            placeholder="에이전트 이름"
            className="flex-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!newAgentName.trim() || adding}
            onClick={() => void handleAddAgent()}
          >
            {adding ? '추가 중...' : '+ 에이전트 추가'}
          </Button>
        </div>
        {agents.length === 0 && (
          <p className="text-sm text-muted-foreground">No agent team members in this project.</p>
        )}
        {agents.map((agent) => (
          <div key={agent.id} className="mb-6">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-medium text-sm">{agent.name}</span>
              <Badge variant={agent.is_active ? 'default' : 'secondary'}>
                {agent.is_active ? 'active' : 'inactive'}
              </Badge>
            </div>

            {newKey?.agentId === agent.id && (
              <div className="mb-3 rounded-md border border-yellow-300 bg-yellow-50 p-3 dark:border-yellow-700 dark:bg-yellow-950">
                <p className="mb-1 text-xs font-semibold text-yellow-800 dark:text-yellow-200">
                  새 API Key — 지금만 표시됩니다. 복사해 두세요.
                </p>
                <code className="block break-all text-xs text-yellow-900 dark:text-yellow-100">
                  {newKey.result.api_key}
                </code>
              </div>
            )}

            <div className="space-y-1">
              {(keys[agent.id] ?? []).map((k) => (
                <div key={k.id} className="flex items-center justify-between rounded border px-3 py-2 text-xs">
                  <div className="flex items-center gap-3">
                    <code className="font-mono">{k.key_prefix}…</code>
                    <span className="text-muted-foreground">
                      발급: {new Date(k.created_at).toLocaleDateString()}
                    </span>
                    {k.last_used_at && (
                      <span className="text-muted-foreground">
                        최근 사용: {new Date(k.last_used_at).toLocaleDateString()}
                      </span>
                    )}
                    {k.revoked_at && <Badge variant="destructive">revoked</Badge>}
                  </div>
                  {!k.revoked_at && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs text-destructive hover:text-destructive"
                      disabled={revoking === k.id}
                      onClick={() => void handleRevoke(agent.id, k.id)}
                    >
                      {revoking === k.id ? 'Revoking...' : 'Revoke'}
                    </Button>
                  )}
                </div>
              ))}
              {(keys[agent.id] ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">발급된 API Key 없음.</p>
              )}
            </div>

            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={issuing === agent.id}
              onClick={() => void handleIssue(agent.id)}
            >
              {issuing === agent.id ? 'Issuing...' : '+ 새 API Key 발급'}
            </Button>
          </div>
        ))}
      </SectionCardBody>
    </SectionCard>
  );
}
