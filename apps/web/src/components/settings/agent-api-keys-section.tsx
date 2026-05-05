'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';

const MCP_SERVER_URL = 'https://app.sprintable.ai/api/v2/mcp';
const LLMS_PROMPT = 'Read this document and complete onboarding: https://app.sprintable.ai/llms.txt';

interface AgentMember {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  webhook_url: string | null;
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

function buildMcpConfig(apiKey: string) {
  return JSON.stringify(
    {
      mcpServers: {
        sprintable: {
          type: 'streamable-http',
          url: MCP_SERVER_URL,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    },
    null,
    2,
  );
}

function McpConfigBlock({
  apiKey,
  agentName,
  onCopy,
}: {
  apiKey: string;
  agentName: string;
  onCopy: (text: string, label: string) => void;
}) {
  const config = buildMcpConfig(apiKey);

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-foreground">MCP Config — {agentName}</p>
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-xs"
          onClick={() => onCopy(config, 'MCP Config')}
        >
          Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded bg-background p-2 text-xs text-foreground/80">{config}</pre>
    </div>
  );
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
  const [webhookUrls, setWebhookUrls] = useState<Record<string, string>>({});
  const [webhookErrors, setWebhookErrors] = useState<Record<string, string>>({});
  const [savingWebhook, setSavingWebhook] = useState<string | null>(null);
  const { addToast } = useToast();

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/team-members?project_id=${projectId}&type=agent`);
      const json = await res.json() as { data: AgentMember[] };
      const agentList = (json.data ?? []).filter((m) => m.type === 'agent');
      setAgents(agentList);
      // Seed webhook URL inputs from fetched data
      setWebhookUrls((prev) => {
        const next = { ...prev };
        for (const agent of agentList) {
          if (!(agent.id in next)) next[agent.id] = agent.webhook_url ?? '';
        }
        return next;
      });
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

  const handleSaveWebhook = useCallback(async (agentId: string, agentName: string) => {
    const trimmed = (webhookUrls[agentId] ?? '').trim();
    if (trimmed && !/^https:\/\//i.test(trimmed)) {
      setWebhookErrors((prev) => ({ ...prev, [agentId]: 'Webhook URL must start with https://' }));
      return;
    }
    setWebhookErrors((prev) => ({ ...prev, [agentId]: '' }));
    setSavingWebhook(agentId);
    try {
      const res = await fetch(`/api/team-members/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: trimmed || null }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
        addToast({ type: 'error', title: json.error?.message ?? 'Failed to save webhook URL' });
        return;
      }
      addToast({ type: 'success', title: `Webhook URL updated for ${agentName}` });
    } catch {
      addToast({ type: 'error', title: 'Network error — please retry' });
    } finally {
      setSavingWebhook(null);
    }
  }, [addToast, webhookUrls]);

  const handleCopy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast({ type: 'success', title: `${label} 복사됨` });
    } catch {
      addToast({ type: 'error', title: '복사 실패', body: '클립보드 접근 권한을 확인하세요.' });
    }
  }, [addToast]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading...</div>;

  return (
    <div className="space-y-4">
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
          {agents.map((agent) => {
            const agentKeys = keys[agent.id] ?? [];
            const activeKeys = agentKeys.filter((k) => !k.revoked_at);
            const freshKey = newKey?.agentId === agent.id ? newKey.result : null;

            return (
              <div key={agent.id} className="mb-6">
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-medium text-sm">{agent.name}</span>
                  <Badge variant={agent.is_active ? 'default' : 'secondary'}>
                    {agent.is_active ? 'active' : 'inactive'}
                  </Badge>
                </div>

                {freshKey ? (
                  <div className="mb-3 rounded-md border border-yellow-300 bg-yellow-50 p-3 dark:border-yellow-700 dark:bg-yellow-950">
                    <p className="mb-1 text-xs font-semibold text-yellow-800 dark:text-yellow-200">
                      새 API Key — 지금만 표시됩니다. 복사해 두세요.
                    </p>
                    <code className="block break-all text-xs text-yellow-900 dark:text-yellow-100">
                      {freshKey.api_key}
                    </code>
                  </div>
                ) : null}

                <div className="space-y-1">
                  {agentKeys.map((k) => (
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
                  {agentKeys.length === 0 && (
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

                {/* MCP Config block */}
                {freshKey ? (
                  <McpConfigBlock
                    apiKey={freshKey.api_key}
                    agentName={agent.name}
                    onCopy={handleCopy}
                  />
                ) : activeKeys.length > 0 ? (
                  <McpConfigBlock
                    apiKey={`${activeKeys[0].key_prefix}...`}
                    agentName={agent.name}
                    onCopy={handleCopy}
                  />
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    ⚠️ MCP Config를 사용하려면 먼저 API Key를 발급하세요.
                  </p>
                )}

                {/* Webhook URL */}
                <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 space-y-2">
                  <p className="text-xs font-semibold text-foreground">Webhook URL</p>
                  <p className="text-xs text-muted-foreground">메모 배정 시 이 URL로 POST 전송됩니다. HTTPS 필수.</p>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={webhookUrls[agent.id] ?? ''}
                      onChange={(e) => {
                        setWebhookUrls((prev) => ({ ...prev, [agent.id]: e.target.value }));
                        setWebhookErrors((prev) => ({ ...prev, [agent.id]: '' }));
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveWebhook(agent.id, agent.name); }}
                      placeholder="https://your-agent.example.com/webhook"
                      className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={savingWebhook === agent.id}
                      onClick={() => void handleSaveWebhook(agent.id, agent.name)}
                    >
                      {savingWebhook === agent.id ? 'Saving...' : 'Save'}
                    </Button>
                  </div>
                  {webhookErrors[agent.id] ? (
                    <p className="text-xs text-red-600">{webhookErrors[agent.id]}</p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </SectionCardBody>
      </SectionCard>

      {/* Agent onboarding prompt */}
      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold">🤖 에이전트 온보딩 프롬프트</h2>
            <p className="text-sm text-muted-foreground">에이전트에게 아래 문구를 전달하면 Sprintable 사용법을 자동으로 학습합니다.</p>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-foreground">온보딩 프롬프트</p>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                onClick={() => void handleCopy(LLMS_PROMPT, '온보딩 프롬프트')}
              >
                Copy
              </Button>
            </div>
            <pre className="overflow-x-auto rounded bg-background p-2 text-xs text-foreground/80 whitespace-pre-wrap">{LLMS_PROMPT}</pre>
          </div>
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
