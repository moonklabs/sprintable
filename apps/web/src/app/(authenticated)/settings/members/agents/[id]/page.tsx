'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Check, Pencil, Plus, X } from 'lucide-react';
import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { useToast } from '@/components/ui/toast';

function getAppOrigin() {
  if (typeof window !== 'undefined') return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.sprintable.ai';
}
const MCP_SERVER_URL = () => `${getAppOrigin()}/api/v2/mcp`;

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

interface ProjectOption {
  id: string;
  name: string;
}

interface NewProjectResult {
  agentId: string;
  projectId: string;
  projectName: string;
  apiKey: string;
  webhookUrl: string;
  savingWebhook: boolean;
}

function buildMcpConfig(apiKey: string) {
  return JSON.stringify(
    {
      mcpServers: {
        sprintable: {
          type: 'streamable-http',
          url: MCP_SERVER_URL(),
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

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [sameNameAgents, setSameNameAgents] = useState<AgentMember[]>([]);
  const [showAddToProject, setShowAddToProject] = useState(false);
  const [selectedAddProjectId, setSelectedAddProjectId] = useState('');
  const [addingToProject, setAddingToProject] = useState(false);
  const [newProjectResult, setNewProjectResult] = useState<NewProjectResult | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);

  const fetchAgent = useCallback(async () => {
    const res = await fetch(`/api/team-members/${id}`);
    if (!res.ok) { router.push('/settings?tab=members'); return; }
    const json = await res.json() as { data: AgentMember };
    setAgent(json.data);
  }, [id, router]);

  const fetchOrgContext = useCallback(async () => {
    const [projectRes, contextRes] = await Promise.all([
      fetch('/api/projects'),
      fetch('/api/current-project'),
    ]);
    if (projectRes.ok) {
      const json = await projectRes.json() as { data: ProjectOption[] };
      setProjects((json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    }
    if (contextRes.ok) {
      const json = await contextRes.json() as { data?: { org_id?: string } };
      setOrgId(json.data?.org_id ?? null);
    }
  }, []);

  const fetchSameNameAgents = useCallback(async (agentName: string) => {
    const res = await fetch('/api/team-members?type=agent&include_inactive=true');
    if (!res.ok) return;
    const json = await res.json() as { data: AgentMember[] };
    setSameNameAgents((json.data ?? []).filter((a) => a.name === agentName && a.id !== id));
  }, [id]);

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
    Promise.all([fetchAgent(), fetchActiveApiKey(), fetchOrgContext()])
      .finally(() => setLoading(false));
  }, [fetchAgent, fetchActiveApiKey, fetchOrgContext]);

  useEffect(() => {
    if (!agent) return;
    void fetchWebhookConfigs(agent.project_id);
    void fetchSameNameAgents(agent.name);
  }, [agent, fetchWebhookConfigs, fetchSameNameAgents]);

  const assignedProjectIds = useMemo(() => {
    const ids = new Set(sameNameAgents.map((a) => a.project_id));
    if (agent) ids.add(agent.project_id);
    return ids;
  }, [sameNameAgents, agent]);

  const availableProjects = useMemo(
    () => projects.filter((p) => !assignedProjectIds.has(p.id)),
    [projects, assignedProjectIds],
  );

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

  const handleAddToProject = async () => {
    if (!selectedAddProjectId || !agent || !orgId) return;
    setAddingToProject(true);
    try {
      const memberRes = await fetch('/api/team-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, project_id: selectedAddProjectId, name: agent.name, type: 'agent', role: agent.role }),
      });
      if (!memberRes.ok) {
        const json = await memberRes.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
        return;
      }
      const memberJson = await memberRes.json() as { data: AgentMember };
      const newAgentId = memberJson.data.id;

      const keyRes = await fetch(`/api/agents/${newAgentId}/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: ['read', 'write'] }),
      });
      if (!keyRes.ok) {
        addToast({ type: 'error', title: 'API Key 자동 생성 실패. 상세 페이지에서 수동으로 발급하세요.' });
        await fetchSameNameAgents(agent.name);
        return;
      }
      const rawKey = (await keyRes.json() as { data?: { api_key?: string } }).data?.api_key ?? '';

      const projectName = projects.find((p) => p.id === selectedAddProjectId)?.name ?? selectedAddProjectId;
      setNewProjectResult({ agentId: newAgentId, projectId: selectedAddProjectId, projectName, apiKey: rawKey, webhookUrl: '', savingWebhook: false });
      setSelectedAddProjectId('');
      setShowAddToProject(false);
      await fetchSameNameAgents(agent.name);
    } finally {
      setAddingToProject(false);
    }
  };

  const handleSaveNewProjectWebhook = async () => {
    if (!newProjectResult) return;
    const trimmed = newProjectResult.webhookUrl.trim();
    if (trimmed && !/^https:\/\//i.test(trimmed)) {
      addToast({ type: 'error', title: 'Webhook URL must start with https://' });
      return;
    }
    setNewProjectResult((prev) => prev ? { ...prev, savingWebhook: true } : null);
    try {
      if (trimmed) {
        await fetch('/api/webhooks/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: newProjectResult.agentId, url: trimmed, project_id: newProjectResult.projectId }),
        });
      }
      addToast({ type: 'success', title: `${newProjectResult.projectName} 프로젝트 추가 완료` });
      setNewProjectResult(null);
    } finally {
      setNewProjectResult((prev) => prev ? { ...prev, savingWebhook: false } : null);
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
            {agent.webhook_url && webhookConfigs.length === 0 ? (
              <p className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                기존 webhook URL(<code className="font-mono">{agent.webhook_url}</code>)이 레거시 필드에 저장되어 있습니다. 아래에 다시 입력해 저장하면 새 webhook_configs 방식으로 마이그레이션됩니다.
              </p>
            ) : null}
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

      {/* 다른 프로젝트에 추가 */}
      <SectionCard>
        <SectionCardHeader>
          <div className="flex items-center justify-between w-full">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">다른 프로젝트에 추가</h2>
              <p className="text-sm text-muted-foreground">
                동일 이름으로 다른 프로젝트에 격리 배포합니다. 프로젝트별 독립 API Key와 Webhook이 발급됩니다.
              </p>
            </div>
            {!showAddToProject && availableProjects.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setShowAddToProject(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                프로젝트 추가
              </Button>
            ) : null}
          </div>
        </SectionCardHeader>
        <SectionCardBody className="space-y-4">
          {/* 이미 할당된 프로젝트 목록 */}
          {sameNameAgents.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">할당된 프로젝트</p>
              {sameNameAgents.map((a) => {
                const pName = projects.find((p) => p.id === a.project_id)?.name ?? a.project_id;
                return (
                  <div key={a.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                    <span className="text-foreground font-medium">{pName}</span>
                    <div className="flex items-center gap-2">
                      {!a.is_active ? <Badge variant="destructive">inactive</Badge> : null}
                      <Link href={`/settings/members/agents/${a.id}`} className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline">
                        상세
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* 추가 폼 */}
          {showAddToProject ? (
            <div className="flex gap-2 items-center">
              <OperatorDropdownSelect
                value={selectedAddProjectId}
                onValueChange={(v) => setSelectedAddProjectId(v)}
                options={[
                  { value: '', label: '프로젝트 선택' },
                  ...availableProjects.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
              <Button variant="hero" size="sm" onClick={() => void handleAddToProject()} disabled={!selectedAddProjectId || addingToProject}>
                {addingToProject ? '...' : '추가'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setShowAddToProject(false); setSelectedAddProjectId(''); }}>
                취소
              </Button>
            </div>
          ) : availableProjects.length === 0 ? (
            <p className="text-xs text-muted-foreground">추가 가능한 프로젝트가 없습니다.</p>
          ) : null}

          {/* 신규 추가 결과: API Key + Webhook 입력 */}
          {newProjectResult ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
              <p className="text-sm font-semibold text-emerald-500">{newProjectResult.projectName} 프로젝트 추가 완료</p>
              {newProjectResult.apiKey ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">API Key — 지금만 표시됩니다. 복사해 두세요.</p>
                  <code className="block break-all rounded bg-background border border-border p-2 text-xs text-foreground/80 font-mono">
                    {newProjectResult.apiKey}
                  </code>
                </div>
              ) : null}
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">Webhook URL (선택)</p>
                <div className="flex gap-2">
                  <OperatorInput
                    type="url"
                    value={newProjectResult.webhookUrl}
                    onChange={(e) => setNewProjectResult((prev) => prev ? { ...prev, webhookUrl: e.target.value } : null)}
                    placeholder="https://your-agent.example.com/webhook"
                    className="flex-1 font-mono text-xs"
                  />
                  <Button variant="hero" size="sm" onClick={() => void handleSaveNewProjectWebhook()} disabled={newProjectResult.savingWebhook}>
                    {newProjectResult.savingWebhook ? '...' : tc('save')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setNewProjectResult(null)}>
                    건너뛰기
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
