'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Check, Pencil, X } from 'lucide-react';
import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { useToast } from '@/components/ui/toast';

const MCP_SERVER_URL = 'https://app.sprintable.ai/api/v2/mcp';

interface AgentMember {
  id: string;
  name: string;
  type: 'human' | 'agent';
  role: string;
  project_id: string;
  is_active: boolean;
  webhook_url: string | null;
}

interface WebhookConfig {
  id: string;
  member_id: string | null;
  url: string;
  project_id: string | null;
  is_active: boolean;
}

interface ApiKey {
  id: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
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

export default function AgentDetailPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { addToast } = useToast();

  const [agent, setAgent] = useState<AgentMember | null>(null);
  const [loading, setLoading] = useState(true);

  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const [webhookConfigs, setWebhookConfigs] = useState<WebhookConfig[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);

  const [freshApiKey, setFreshApiKey] = useState<string | null>(null);
  const [hasActiveKey, setHasActiveKey] = useState(false);
  const [mcpCopied, setMcpCopied] = useState(false);

  const fetchAgent = useCallback(async () => {
    const res = await fetch(`/api/team-members/${id}`);
    if (!res.ok) { router.push('/settings?tab=members'); return; }
    const json = await res.json() as { data: AgentMember };
    setAgent(json.data);
  }, [id, router]);

  const fetchWebhookConfigs = useCallback(async (projectId: string) => {
    const res = await fetch(`/api/webhooks/config?project_id=${encodeURIComponent(projectId)}`);
    if (!res.ok) return;
    const json = await res.json() as { data: WebhookConfig[] };
    const agentConfigs = (json.data ?? []).filter((c) => c.member_id === id);
    setWebhookConfigs(agentConfigs);
    setWebhookUrl(agentConfigs[0]?.url ?? '');
  }, [id]);

  const fetchActiveApiKey = useCallback(async () => {
    const res = await fetch(`/api/agents/${id}/api-key`);
    if (!res.ok) return;
    const json = await res.json() as { data: ApiKey[] };
    const active = (json.data ?? []).find((k) => !k.revoked_at);
    setHasActiveKey(!!active);
  }, [id]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchAgent(), fetchActiveApiKey()])
      .finally(() => setLoading(false));
  }, [fetchAgent, fetchActiveApiKey]);

  useEffect(() => {
    if (!agent) return;
    void fetchWebhookConfigs(agent.project_id);
  }, [agent, fetchWebhookConfigs]);

  const handleSaveEdit = async () => {
    if (!editName.trim()) return;
    setSavingEdit(true);
    const res = await fetch(`/api/team-members/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName.trim(), role: editRole.trim() || 'member' }),
    });
    if (res.ok) {
      const json = await res.json() as { data: AgentMember };
      setAgent(json.data);
      setEditingName(false);
      addToast({ type: 'success', title: tc('saved') });
    } else {
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
    }
    setSavingEdit(false);
  };

  const handleSaveWebhook = async () => {
    const trimmed = webhookUrl.trim();
    if (trimmed && !/^https:\/\//i.test(trimmed)) {
      addToast({ type: 'error', title: 'Webhook URL must start with https://' });
      return;
    }
    if (!agent) return;
    setSavingWebhook(true);
    try {
      if (!trimmed) {
        if (webhookConfigs[0]) {
          await fetch(`/api/webhooks/config?id=${encodeURIComponent(webhookConfigs[0].id)}`, { method: 'DELETE' });
          setWebhookConfigs([]);
        }
      } else {
        const res = await fetch('/api/webhooks/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: id, url: trimmed, project_id: agent.project_id }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
          return;
        }
      }
      addToast({ type: 'success', title: 'Webhook URL saved' });
      await fetchWebhookConfigs(agent.project_id);
    } finally {
      setSavingWebhook(false);
    }
  };

  const handleCopyMcp = async () => {
    const key = freshApiKey ?? '<YOUR_API_KEY>';
    try {
      await navigator.clipboard.writeText(buildMcpConfig(key));
      setMcpCopied(true);
      setTimeout(() => setMcpCopied(false), 2000);
    } catch {
      addToast({ type: 'error', title: tc('error') });
    }
  };

  if (loading) {
    return (
      <div className="w-full max-w-3xl mx-auto p-6 space-y-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />)}
      </div>
    );
  }

  if (!agent) return null;

  return (
    <div className="w-full max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/settings?tab=members" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold text-foreground">{t('orgAgentsTitle')}</h1>
      </div>

      {/* 기본 정보 */}
      <SectionCard>
        <SectionCardHeader>
          <div className="flex items-center justify-between gap-3 w-full">
            {editingName ? (
              <div className="flex flex-1 items-center gap-2">
                <OperatorInput
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={t('agentNamePlaceholder')}
                  className="max-w-xs"
                />
                <OperatorInput
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value)}
                  placeholder="role"
                  className="max-w-32"
                />
                <button type="button" onClick={() => void handleSaveEdit()} disabled={savingEdit} className="text-emerald-500 hover:text-emerald-400 disabled:opacity-50">
                  <Check className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setEditingName(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex flex-1 items-center gap-3 min-w-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-foreground">{agent.name}</span>
                    {!agent.is_active ? <Badge variant="destructive">inactive</Badge> : null}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant="secondary">{t('agentMember')}</Badge>
                    <Badge variant="outline">{agent.role}</Badge>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setEditName(agent.name); setEditRole(agent.role); setEditingName(true); }}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </SectionCardHeader>
      </SectionCard>

      {/* API Keys */}
      <AgentApiKeyManager
        agentId={id}
        agentName={agent.name}
        onNewKey={(key) => { setFreshApiKey(key); setHasActiveKey(true); }}
      />

      {/* Webhook 설정 */}
      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">Webhook URL</h2>
            <p className="text-sm text-muted-foreground">이 에이전트로 이벤트가 발생할 때 POST로 전송됩니다. HTTPS 필수.</p>
          </div>
        </SectionCardHeader>
        <SectionCardBody className="space-y-3">
          <div className="flex gap-2">
            <OperatorInput
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-agent.example.com/webhook"
              className="flex-1 font-mono text-xs"
            />
            <Button variant="hero" size="sm" onClick={() => void handleSaveWebhook()} disabled={savingWebhook}>
              {savingWebhook ? '...' : tc('save')}
            </Button>
          </div>
          {webhookConfigs[0] ? (
            <p className="text-xs text-muted-foreground truncate font-mono">
              Current: {webhookConfigs[0].url}
            </p>
          ) : null}
        </SectionCardBody>
      </SectionCard>

      {/* MCP Config */}
      <SectionCard>
        <SectionCardHeader>
          <div className="flex items-center justify-between w-full">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">MCP Config</h2>
              <p className="text-sm text-muted-foreground">Claude Code나 MCP 클라이언트에 붙여넣으면 이 에이전트로 Sprintable에 연결됩니다.</p>
            </div>
            <Button variant="glass" size="sm" onClick={() => void handleCopyMcp()}>
              {mcpCopied ? <Check className="h-3.5 w-3.5" /> : 'Copy'}
            </Button>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          {freshApiKey ? (
            <p className="text-xs text-emerald-500 mb-2">새 API Key가 포함된 설정입니다. 지금 복사해 두세요 — 페이지를 새로고침하면 사라집니다.</p>
          ) : !hasActiveKey ? (
            <p className="text-xs text-amber-400 mb-2">API Key를 먼저 발급하세요. 발급 직후 실제 키가 이 블록에 자동으로 포함됩니다.</p>
          ) : (
            <p className="text-xs text-muted-foreground mb-2">보안상 기존 키는 재표시되지 않습니다. 새 키를 발급하면 이 블록에 자동으로 포함됩니다.</p>
          )}
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground/80">
            {buildMcpConfig(freshApiKey ?? '<YOUR_API_KEY>')}
          </pre>
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
