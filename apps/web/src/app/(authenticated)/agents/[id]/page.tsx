'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, Check, Copy, MinusCircle, Pencil, X, XCircle } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';
import { MessagingPolicySection } from '@/components/agents/messaging-policy-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { AgentProjectAccessSection } from '@/components/settings/agent-project-access-section';
import { useToast } from '@/components/ui/toast';
import {
  RUNTIME_REGISTRY,
  getRuntimeDef,
  resolveRuntimeStatus,
  type RuntimeStatus,
} from '@/lib/runtime-capabilities';

/** 런타임 상태(6종 중 ①~⑤) → 배지·헬퍼 표현. ⑥(드롭다운 dot)은 AC 범위 외(§11). */
const RUNTIME_STATUS_UI: Record<
  RuntimeStatus,
  {
    variant: 'success' | 'warning' | 'destructive' | 'chip';
    labelKey: string;
    helpKey: string;
    Icon: typeof Check | null;
  }
> = {
  supported: { variant: 'success', labelKey: 'runtimeSupported', helpKey: 'runtimeSupportedHelp', Icon: Check },
  partial: { variant: 'warning', labelKey: 'runtimePartial', helpKey: 'runtimePartialHelp', Icon: AlertTriangle },
  unsupported: { variant: 'destructive', labelKey: 'runtimeUnsupported', helpKey: 'runtimeUnsupportedHelp', Icon: XCircle },
  unset: { variant: 'chip', labelKey: 'runtimeUnset', helpKey: 'runtimeUnsetHelp', Icon: MinusCircle },
  unknown: { variant: 'destructive', labelKey: 'runtimeUnknown', helpKey: 'runtimeUnknownHelp', Icon: XCircle },
};

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
  created_by: string | null;
  fakechat_port: number | null;
  runtime_type: string | null;
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

function getWebhookState(configs: WebhookConfig[]): 'empty' | 'active' | 'paused' {
  if (!configs.length) return 'empty';
  return configs[0].is_active ? 'active' : 'paused';
}

function isWebhookUrlAllowed(url: string): boolean {
  if (!url) return true;
  if (/^https:\/\//i.test(url)) return true;
  return /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/i.test(url);
}

export default function AgentDetailPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { addToast } = useToast();

  const [agent, setAgent] = useState<AgentMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [orgRole, setOrgRole] = useState<string>('member');

  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const [selectedRuntime, setSelectedRuntime] = useState<string>('');
  const [savingRuntime, setSavingRuntime] = useState(false);

  const [webhookConfigs, setWebhookConfigs] = useState<WebhookConfig[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookActive, setWebhookActive] = useState(false);
  const [savingWebhook, setSavingWebhook] = useState(false);

  const [freshApiKey, setFreshApiKey] = useState<string | null>(null);
  const [hasActiveKey, setHasActiveKey] = useState(false);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [fakechatMcpCopied, setFakechatMcpCopied] = useState(false);

  const [projects, setProjects] = useState<ProjectOption[]>([]);

  const fetchAgent = useCallback(async () => {
    const res = await fetch(`/api/team-members/${id}`);
    if (!res.ok) { router.push('/agents?tab=manage'); return; }
    const json = await res.json() as { data: AgentMember };
    setAgent(json.data);
  }, [id, router]);

  const fetchOrgContext = useCallback(async () => {
    const [projectRes, meRes] = await Promise.all([
      fetch('/api/projects'),
      fetch('/api/me'),
    ]);
    if (projectRes.ok) {
      const json = await projectRes.json() as { data: ProjectOption[] };
      setProjects((json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    }
    if (meRes.ok) {
      const json = await meRes.json() as { data?: { user_id?: string | null; role?: string } };
      setCurrentUserId(json.data?.user_id ?? null);
      setOrgRole(json.data?.role ?? 'member');
    }
  }, []);

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
  }, [agent, fetchWebhookConfigs]);

  useEffect(() => {
    setWebhookActive(webhookConfigs[0]?.is_active ?? false);
  }, [webhookConfigs]);

  // S2: 저장된 runtime_type → staged 셀렉터 동기화(로드·저장 후 재파생).
  useEffect(() => {
    setSelectedRuntime(agent?.runtime_type ?? '');
  }, [agent?.runtime_type]);

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
      const status = res.status;
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      if (status === 403) {
        addToast({ type: 'error', title: t('ownershipDenied') });
      } else {
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
      }
    }
    setSavingEdit(false);
  };

  const handleSaveWebhook = async () => {
    const trimmed = webhookUrl.trim();
    if (trimmed && !isWebhookUrlAllowed(trimmed)) {
      addToast({ type: 'error', title: t('webhookUrlInvalid') });
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
          body: JSON.stringify({ member_id: id, url: trimmed, project_id: agent.project_id, is_active: webhookActive }),
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

  const handleToggle = async (next: boolean) => {
    if (!agent) return;
    setWebhookActive(next);
    if (!webhookConfigs[0]) return;
    setSavingWebhook(true);
    try {
      const res = await fetch('/api/webhooks/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_id: id,
          url: webhookConfigs[0].url,
          project_id: agent.project_id,
          is_active: next,
        }),
      });
      if (!res.ok) {
        setWebhookActive(!next);
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
        return;
      }
      await fetchWebhookConfigs(agent.project_id);
    } catch {
      setWebhookActive(!next);
      addToast({ type: 'error', title: tc('error') });
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

  const handleCopyFakechatMcp = async () => {
    if (!agent?.fakechat_port) return;
    const config = JSON.stringify(
      { mcpServers: { sprintable: { type: 'sse', url: `http://localhost:${agent.fakechat_port}/sse` } } },
      null, 2,
    );
    try {
      await navigator.clipboard.writeText(config);
      setFakechatMcpCopied(true);
      setTimeout(() => setFakechatMcpCopied(false), 2000);
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

  const canEdit =
    (currentUserId !== null && agent.created_by === currentUserId) ||
    orgRole === 'admin' ||
    orgRole === 'owner';

  const handleSaveRuntime = async () => {
    setSavingRuntime(true);
    try {
      const res = await fetch(`/api/team-members/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime_type: selectedRuntime || null }),
      });
      if (res.ok) {
        const json = await res.json() as { data: AgentMember };
        setAgent(json.data);
        addToast({ type: 'success', title: t('runtimeTypeSaved') });
      } else {
        const status = res.status;
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        if (status === 403) {
          addToast({ type: 'error', title: t('ownershipDenied') });
        } else {
          addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
        }
      }
    } finally {
      setSavingRuntime(false);
    }
  };

  const handleToggleActive = async () => {
    const next = !agent.is_active;
    const res = await fetch(`/api/team-members/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: next }),
    });
    if (res.ok) {
      const json = await res.json() as { data: AgentMember };
      setAgent(json.data);
      addToast({ type: 'success', title: next ? t('agentActivated') : t('agentDeactivated') });
    } else {
      const status = res.status;
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      if (status === 403) {
        addToast({ type: 'error', title: t('ownershipDenied') });
      } else {
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
      }
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/agents?tab=manage" className="text-muted-foreground hover:text-foreground transition-colors">
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
                {canEdit && (
                <button
                  type="button"
                  onClick={() => { setEditName(agent.name); setEditRole(agent.role); setEditingName(true); }}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              </div>
            )}
          </div>
        </SectionCardHeader>
        {canEdit && (
          <SectionCardBody>
            <Button
              variant="glass"
              size="sm"
              onClick={() => void handleToggleActive()}
            >
              {agent.is_active ? t('deactivateAgent') : t('activateAgent')}
            </Button>
          </SectionCardBody>
        )}
      </SectionCard>

      {/* 런타임 타입 (E-CHAT-CMD S2) */}
      {(() => {
        const savedRuntime = agent.runtime_type ?? '';
        const runtimeStatus = resolveRuntimeStatus(selectedRuntime || null);
        const ui = RUNTIME_STATUS_UI[runtimeStatus];
        const stagedDef = getRuntimeDef(selectedRuntime);
        const stagedKnown = !!stagedDef;
        // ⑤ 미인식: 원값을 드롭다운 트리거에 그대로 노출(데이터 은닉 금지) + 미인식 표시.
        const runtimeOptions = [
          ...(selectedRuntime && !stagedKnown
            ? [{ value: selectedRuntime, label: `${selectedRuntime} (${t('runtimeUnknown')})`, disabled: true }]
            : []),
          ...RUNTIME_REGISTRY.map((r) => ({ value: r.key, label: r.label })),
        ];
        // 변경 + registry 등록값일 때만 저장 가능(④ 미선택·⑤ 미인식 재저장 방지).
        const canSaveRuntime = stagedKnown && selectedRuntime !== savedRuntime;
        const StatusIcon = ui.Icon;
        return (
          <SectionCard>
            <SectionCardHeader>
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-semibold text-foreground">{t('runtimeTypeTitle')}</h2>
                  <Badge variant={ui.variant}>
                    {StatusIcon ? <StatusIcon className="h-3 w-3" /> : null}
                    {t(ui.labelKey)}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{t('runtimeTypeDescription')}</p>
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-3">
              {canEdit ? (
                <>
                  <div className="flex gap-2">
                    <OperatorDropdownSelect
                      value={selectedRuntime}
                      onValueChange={setSelectedRuntime}
                      options={runtimeOptions}
                      placeholder={t('runtimeTypePlaceholder')}
                      className="flex-1"
                    />
                    <Button
                      variant="hero"
                      size="sm"
                      onClick={() => void handleSaveRuntime()}
                      disabled={savingRuntime || !canSaveRuntime}
                    >
                      {savingRuntime ? '...' : tc('save')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t(ui.helpKey)}</p>
                </>
              ) : (
                <div className="space-y-1">
                  <p className="text-sm text-foreground">
                    {stagedDef?.label ?? (selectedRuntime || t('runtimeUnset'))}
                  </p>
                  <p className="text-xs text-muted-foreground">{t(ui.helpKey)}</p>
                </div>
              )}
            </SectionCardBody>
          </SectionCard>
        );
      })()}

      {/* API Keys */}
      {canEdit && (
        <AgentApiKeyManager
          agentId={id}
          agentName={agent.name}
          onNewKey={(key) => { setFreshApiKey(key); setHasActiveKey(true); }}
        />
      )}

      {/* Notification channel section */}
      {(() => {
        const webhookState = getWebhookState(webhookConfigs);
        return (
          <SectionCard>
            <SectionCardHeader>
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-semibold text-foreground">{t('notificationChannel')}</h2>
                  {webhookState === 'empty' && <Badge variant="info">{t('webhookStatusEmpty')}</Badge>}
                  {webhookState === 'active' && <Badge variant="success">{t('webhookStatusActive')}</Badge>}
                  {webhookState === 'paused' && (
                    <>
                      <Badge variant="secondary">{t('webhookStatusInactive')}</Badge>
                      <Badge variant="info">{t('webhookStatusFallback')}</Badge>
                    </>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {webhookState === 'empty' && t('webhookHelperEmpty')}
                  {webhookState === 'active' && t('webhookHelperActive')}
                  {webhookState === 'paused' && t('webhookHelperPaused')}
                </p>
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{t('webhookEnabledToggle')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('webhookEnabledHelp')}</p>
                </div>
                <Switch
                  checked={webhookActive}
                  onCheckedChange={(next) => void handleToggle(next)}
                  disabled={savingWebhook}
                />
              </div>
              <div className="flex gap-2">
                <OperatorInput
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://your-agent.example.com/webhook"
                  className="flex-1 font-mono text-xs"
                  disabled={!webhookActive}
                />
                <Button
                  variant="hero"
                  size="sm"
                  onClick={() => void handleSaveWebhook()}
                  disabled={savingWebhook || !webhookActive || !webhookUrl.trim()}
                >
                  {savingWebhook ? '...' : tc('save')}
                </Button>
              </div>
            </SectionCardBody>
          </SectionCard>
        );
      })()}

      {/* Messaging policy (E-MSG-POLICY S3) */}
      {canEdit && <MessagingPolicySection agentId={id} creatorUserId={agent.created_by} />}

      {/* MCP Config */}
      <SectionCard>
        <SectionCardHeader>
          <div className="flex items-center justify-between w-full">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">MCP Config</h2>
              <p className="text-sm text-muted-foreground">Claude Code나 MCP 클라이언트에 붙여넣으면 이 에이전트로 Sprintable에 연결됩니다.</p>
            </div>
            {freshApiKey && (
              <Button variant="glass" size="sm" onClick={() => void handleCopyMcp()}>
                {mcpCopied ? <Check className="h-3.5 w-3.5" /> : 'Copy'}
              </Button>
            )}
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          {freshApiKey ? (
            <>
              <p className="text-xs text-emerald-500 mb-2">새 API Key가 포함된 설정입니다. 지금 복사해 두세요 — 페이지를 새로고침하면 사라집니다.</p>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground/80">
                {buildMcpConfig(freshApiKey)}
              </pre>
            </>
          ) : !hasActiveKey ? (
            <p className="text-xs text-amber-400">API Key를 먼저 발급하세요. 발급 직후 실제 키가 이 블록에 자동으로 포함됩니다.</p>
          ) : (
            <p className="text-xs text-muted-foreground">보안상 기존 키는 재표시되지 않습니다. 위 API Keys 섹션에서 새 키를 발급하면 실제 키가 포함된 Config가 여기에 자동으로 나타납니다.</p>
          )}
        </SectionCardBody>
      </SectionCard>

      {/* Fakechat 채널 (SSE) */}
      <SectionCard>
        <SectionCardHeader>
          <div className="flex items-center justify-between w-full">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">Fakechat 채널</h2>
                <Badge variant="info">SSE</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                이 에이전트의 로컬 SSE 채널 설정입니다. fakechat 서버가 해당 포트에서 실행되어야 합니다.
              </p>
            </div>
            {agent.fakechat_port ? (
              <Button variant="glass" size="sm" onClick={() => void handleCopyFakechatMcp()}>
                {fakechatMcpCopied ? <Check className="h-3.5 w-3.5" /> : <><Copy className="h-3.5 w-3.5 mr-1" />Copy SSE Config</>}
              </Button>
            ) : null}
          </div>
        </SectionCardHeader>
        <SectionCardBody className="space-y-3">
          {agent.fakechat_port ? (
            <>
              <div className="flex items-center gap-3 text-sm">
                <span className="text-muted-foreground">Port</span>
                <code className="rounded bg-muted px-2 py-0.5 font-mono text-foreground">{agent.fakechat_port}</code>
                <span className="text-muted-foreground">SSE URL</span>
                <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
                  http://localhost:{agent.fakechat_port}/sse
                </code>
              </div>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground/80">
                {JSON.stringify(
                  { mcpServers: { sprintable: { type: 'sse', url: `http://localhost:${agent.fakechat_port}/sse` } } },
                  null, 2,
                )}
              </pre>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              fakechat 포트 정보가 없습니다. 에이전트를 재생성하거나 관리자에게 문의하세요.
            </p>
          )}
        </SectionCardBody>
      </SectionCard>

      {/* 프로젝트 접근 (org-agent 멀티프로젝트 단일키 grant) — 088987d8 */}
      {/* 프로젝트 grant 게이트는 page canEdit(creator 포함)보다 엄격 — creator라도 비-admin이면 과권한
          (RC①). org admin/owner 만 page-wide 허용(org admin 은 org 전 프로젝트 grant 가능 = BE
          _require_owner_or_admin 정합·403 surprise 0; 단일 project owner-non-admin 은 안전하게 미노출). */}
      <AgentProjectAccessSection
        agentMemberId={id}
        projects={projects}
        canEdit={orgRole === 'admin' || orgRole === 'owner'}
      />
    </div>
  );
}
