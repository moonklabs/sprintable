'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { formatAgentRuntimeLine } from '@/components/agents/agent-management-tab';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { AlertTriangle, ArrowLeft, Check, Copy, MinusCircle, Pencil, X, XCircle } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { AgentConnectionSettingsSection } from '@/components/agents/agent-connection-settings-section';
import { MessagingPolicySection } from '@/components/agents/messaging-policy-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { AgentProjectAccessSection } from '@/components/settings/agent-project-access-section';
import { Avatar } from '@/components/shared/avatar';
import { AvatarEditCard } from '@/components/shared/avatar-edit-card';
import { MemberNotificationPreferencesSummary } from '@/components/agents/member-notification-preferences-summary';
import { useToast } from '@/components/ui/toast';
import {
  RUNTIME_REGISTRY,
  getRuntimeDef,
  resolveRuntimeStatus,
  runtimeLabel,
  type RuntimeStatus,
} from '@/lib/runtime-capabilities';

import { fetchWithAuth } from '@/lib/db/client';
import { resolveRoleLabel } from '@/app/(authenticated)/organization/trust/trust-utils';
import { copyTextSafely } from '@/lib/clipboard';

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

interface AgentMember {
  id: string;
  name: string;
  type: 'human' | 'agent';
  role: string;
  project_id: string;
  is_active: boolean;
  webhook_url: string | null;
  created_by: string | null;
  avatar_url?: string | null;
  // story #2362(2026-07-31) — 이 필드는 렌더에서 더 안 쓴다(fakechat은 다이얼아웃 방식이라
  // 포트를 리슨하지 않는다, packages/fakechat/server.ts 참고 — 「연결하라」고 안내하던 것이
  // 거짓이었다). 컬럼(마이그 0037) 자체는 안 지운다 — 이 파일 밖 소비처 전수를 안 했다.
  // 지울지는 그걸 센 뒤에 정한다.
  fakechat_port: number | null;
  runtime_type: string | null;
  // story #4129 — MCP clientInfo·(있으면)plugin 버전·세션 시작. BE computed_field(agent-
  // management-tab.tsx의 OrgAgent와 동형 필드, formatAgentRuntimeLine 공유).
  client_name?: string | null;
  client_version?: string | null;
  plugin_version?: string | null;
  session_started_at?: string | null;
  needs_restart?: boolean | null;
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
  const ta = useTranslations('agents');
  const tc = useTranslations('common');
  const to = useTranslations('organization');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
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
  const [fakechatEnvKeyCopied, setFakechatEnvKeyCopied] = useState(false);

  const [projects, setProjects] = useState<ProjectOption[]>([]);

  const fetchAgent = useCallback(async () => {
    const res = await fetchWithAuth(`/api/team-members/${id}`);
    // story #1990: replace — 뒤로가기 재진입 트랩 방지(§3.2 원칙, gate/chat/goal/loop과 동일).
    if (!res.ok) { router.replace('/organization/workforce?tab=manage'); return; }
    const json = await res.json() as { data: AgentMember };
    setAgent(json.data);
  }, [id, router]);

  const fetchOrgContext = useCallback(async () => {
    // story #3519(§16-7 2부, PO 確定 2026-09-05) — 둘 다 부수(ok?채움:방치, 그 외 화면을
    // 안 막는다)인데 catch가 어디에도 없었다 — 하나가 네트워크단 reject하면 나머지도
    // 조용히 못 채워졌다. leg별로 격리한다.
    const [projectRes, meRes] = await Promise.all([
      fetchWithAuth('/api/projects').catch(() => null),
      fetchWithAuth('/api/me').catch(() => null),
    ]);
    if (projectRes?.ok) {
      const json = await projectRes.json() as { data: ProjectOption[] };
      setProjects((json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    }
    if (meRes?.ok) {
      const json = await meRes.json() as { data?: { user_id?: string | null; role?: string } };
      setCurrentUserId(json.data?.user_id ?? null);
      setOrgRole(json.data?.role ?? 'member');
    }
  }, []);

  const fetchWebhookConfigs = useCallback(async (projectId: string) => {
    // story 933248fa 재오픈: GET은 기본 caller-scope라 project_id만으로는 "내(caller) 웹훅"만
    // 돌아온다 — admin이 타 멤버(id) 상세를 보는 중이면 ?member_id=로 그 타깃을 명시 조회해야
    // BE의 admin override(list_webhook_configs)가 실제로 작동한다(write_ok≠read_success).
    const res = await fetchWithAuth(
      `/api/webhooks/config?project_id=${encodeURIComponent(projectId)}&member_id=${encodeURIComponent(id)}`,
    );
    if (!res.ok) return;
    const json = await res.json() as { data: WebhookConfig[] };
    const agentConfigs = (json.data ?? []).filter((c) => c.member_id === id);
    setWebhookConfigs(agentConfigs);
    setWebhookUrl(agentConfigs[0]?.url ?? '');
  }, [id]);

  const fetchActiveApiKey = useCallback(async () => {
    const res = await fetchWithAuth(`/api/agents/${id}/api-key`);
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
    const res = await fetchWithAuth(`/api/team-members/${id}`, {
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
      // story #2485 — backend update_team_member()는 generic HTTP상태 코드만 낸다
      // (진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
      if (status === 403) {
        addToast({ type: 'error', title: t('ownershipDenied') });
      } else {
        addToast({ type: 'error', title: tc('error') });
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
          // story #2485 — backend upsert_webhook_config()는 generic HTTP상태 코드만
          // 낸다(진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 제거.
          addToast({ type: 'error', title: tc('error') });
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
        // story #2485 — backend upsert_webhook_config()는 generic HTTP상태 코드만
        // 낸다(진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 제거.
        addToast({ type: 'error', title: tc('error') });
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

  // story #2362 — fakechat은 포트를 리슨하지 않는다(다이얼아웃 방식, packages/fakechat/
  // server.ts 참고). 복사할 것은 접속 URL이 아니라 그 에이전트의 런치 셸 export 한 줄이다.
  const handleCopyFakechatEnvKey = async () => {
    if (!freshApiKey) return;
    const result = await copyTextSafely(`export SPRINTABLE_API_KEY=${freshApiKey}`);
    if (!result.ok) {
      // story #3986(클래스 «거짓 성공 표시») — 공용 헬퍼로 일반화(발명 0), 낱말도
      // 일반 오류(tc('error'))에서 "직접 선택" 정본으로 정정.
      addToast({ type: 'error', title: tc('copyFailedSelectManually') });
      return;
    }
    setFakechatEnvKeyCopied(true);
    setTimeout(() => setFakechatEnvKeyCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="w-full max-w-3xl mx-auto p-6 space-y-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />)}
      </div>
    );
  }

  if (!agent) return null;

  const canEditBase =
    (currentUserId !== null && agent.created_by === currentUserId) ||
    orgRole === 'admin' ||
    orgRole === 'owner';
  // story #3994 CHANGES-2(페드루 PO 판정 2026-09-17) — 「시스템 발행」은 예약 멤버라
  // 아무도 손으로 바꾸면 안 된다(런타임 재저장 시 다음 자동 발행이 두 번째 「시스템
  // 발행」을 만드는 실 결함까지 확認됨). canEdit을 여기 한 곳에서 좁혀 이름 편집·
  // 아바타·활성/비활성 토글·런타임 저장·메시지 정책(전부 기존 `canEdit &&`/`canEdit ?`
  // 게이트)이 전부 자동으로 읽기 전용이 되게 한다(자리마다 조건 분산 금지). API 키
  // 섹션만은 canEditBase를 그대로 써서(아래) 중립 설명 1줄을 그 자리에 낸다 — 나머지는
  // 이미 있는 "비-canEdit 읽기 전용" 표시로 충분(새 문구 0).
  const isSystemPublisherAgent = isSystemPublisher(agent.runtime_type);
  const canEdit = canEditBase && !isSystemPublisherAgent;
  // story 933248fa — 타 멤버 웹훅 설정은 BE가 admin/owner role만 허용(creator 단독은 불가, 산티아고
  // IDOR 방어 유지). canEdit(creator 포함)보다 엄격하게 별도 게이트 — 아니면 편집 UI가 "가능해 보이는데
  // 실제로 실패"하는 정직하지 않은 상태가 재발한다(§673 프로젝트 grant 게이트와 동일 패턴).
  const canEditWebhook = (orgRole === 'admin' || orgRole === 'owner') && !isSystemPublisherAgent;

  const handleSaveRuntime = async () => {
    setSavingRuntime(true);
    try {
      const res = await fetchWithAuth(`/api/team-members/${id}`, {
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
        // story #2485 — backend update_team_member()는 generic HTTP상태 코드만 낸다
        // (진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
        if (status === 403) {
          addToast({ type: 'error', title: t('ownershipDenied') });
        } else {
          addToast({ type: 'error', title: tc('error') });
        }
      }
    } finally {
      setSavingRuntime(false);
    }
  };

  const handleToggleActive = async () => {
    const next = !agent.is_active;
    const res = await fetchWithAuth(`/api/team-members/${id}`, {
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
      // story #2485 — backend update_team_member()는 generic HTTP상태 코드만 낸다
      // (진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
      if (status === 403) {
        addToast({ type: 'error', title: t('ownershipDenied') });
      } else {
        addToast({ type: 'error', title: tc('error') });
      }
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        {/* story #1990: replace, 기본 push 아님 — 뒤로가기 재진입 트랩 방지(§3.2). */}
        <Link href="/organization/workforce?tab=manage" replace className="text-muted-foreground hover:text-foreground transition-colors">
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
                <button type="button" onClick={() => void handleSaveEdit()} disabled={savingEdit} className="text-success transition hover:opacity-80 disabled:opacity-50">
                  <Check className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setEditingName(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex flex-1 items-center gap-3 min-w-0">
                <Avatar name={agent.name} avatarUrl={agent.avatar_url} actorType="agent" size={40} runtimeType={agent.runtime_type} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-foreground">{agent.name}</span>
                    {!agent.is_active ? <Badge variant="destructive">inactive</Badge> : null}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant="secondary">{t('agentMember')}</Badge>
                    <Badge variant="outline">{resolveRoleLabel(agent.role, null, to)}</Badge>
                    {/* story #3092(2단계, 표면3) — 커넥터 필드. runtime_type null이면 생략
                        (전역 폴백 규칙 — 추측·「미지정」류 문구 금지). 공식 로고는 법무
                        사인오프 전이라 이번엔 텍스트만(로고 트랙은 후속 스코프). */}
                    {runtimeLabel(agent.runtime_type) ? (
                      <Badge variant="chip">{t('connectorLabel')}: {runtimeLabel(agent.runtime_type)}</Badge>
                    ) : null}
                    {agent.needs_restart ? (
                      <Badge variant="warning">{ta('agentNeedsRestartBadge')}</Badge>
                    ) : null}
                  </div>
                  {(() => {
                    const runtimeLine = formatAgentRuntimeLine(agent, locale, displayTimezone, ta);
                    return runtimeLine ? (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{runtimeLine}</p>
                    ) : null;
                  })()}
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
          <SectionCardBody className="space-y-4">
            <AvatarEditCard
              memberId={agent.id}
              name={agent.name}
              avatarUrl={agent.avatar_url ?? null}
              actorType="agent"
              onUpdated={(url) => setAgent((prev) => (prev ? { ...prev, avatar_url: url } : prev))}
            />
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
      {/* story #3994 CHANGES-4(페드루 PO C3 2026-09-17) — 「시스템 발행」의 runtime_type
          은 §3107 예약값이라 resolveRuntimeStatus()의 두 capability 축이 둘 다 false로
          해석돼 'unsupported'(destructive 빨간 배지+XCircle)로 떨어진다 — "연결 필요
          없음" 화면 한복판에 빨간 경고가 뜨는 거짓 신호(헤더에 이미 있는 「커넥터:
          Sprintable」 칩으로 충분, 새 문구 0). */}
      {!isSystemPublisherAgent && (() => {
        const savedRuntime = agent.runtime_type ?? '';
        const runtimeStatus = resolveRuntimeStatus(selectedRuntime || null);
        const ui = RUNTIME_STATUS_UI[runtimeStatus];
        const stagedDef = getRuntimeDef(selectedRuntime);
        const stagedKnown = !!stagedDef;
        // ⑤ 미인식: 원값을 드롭다운 트리거에 그대로 노출(데이터 은닉 금지) + 미인식 표시.
        // story #3107 — system-publisher는 사람이 만든 에이전트가 고를 실 런타임이 아니라
        // 시스템 예약값이라(뱃지/라벨 표기 전용) 이 "에이전트 런타임 지정" 드롭다운에서만
        // 명시적으로 걸러낸다(runtimeLabel()·CONNECTOR_BADGE_REGISTRY 등 다른 소비처는
        // RUNTIME_REGISTRY를 그대로 써 무필터).
        const runtimeOptions = [
          ...(selectedRuntime && !stagedKnown
            ? [{ value: selectedRuntime, label: `${selectedRuntime} (${t('runtimeUnknown')})`, disabled: true }]
            : []),
          ...RUNTIME_REGISTRY.filter((r) => r.key !== 'system-publisher').map((r) => ({ value: r.key, label: r.label })),
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
      {/* story #3994(«거짓 경고» 클래스, PO CHANGES-1 2026-09-17) — 「시스템 발행」은
          키를 발급받을 연결 대상이 아니다(연결된 키로 고객 에이전트가 "시스템 발행"
          이름을 사칭해 메시지를 보낼 수 있는 모양이 되는 실 문제). 서버 쪽 발급 거부는
          새 BE라 이 카드 밖(PO가 별도 카드로) — 여기서는 FE 진입점만 막고 목록과 같은
          중립 설명 1줄로 대체(런타임 선택 자체는 §3107이 이미 배제 — 아래 §478 참고).
          canEditBase를 쓴다(위에서 좁힌 canEdit이 아니라) — 그래야 편집권 있는 뷰어가
          여기서 «못 만짐»이 아니라 «중립 설명»을 본다(narrowed canEdit이면 이 블록
          자체가 안 뜬다). */}
      {canEditBase && (
        isSystemPublisherAgent ? (
          <SectionCard>
            <SectionCardBody>
              <p className="text-xs text-muted-foreground" data-testid="agent-detail-system-publisher-notice">
                {ta('systemPublisherNeutralDescription')}
              </p>
            </SectionCardBody>
          </SectionCard>
        ) : (
          <AgentApiKeyManager
            agentId={id}
            agentName={agent.name}
            onNewKey={(key) => { setFreshApiKey(key); setHasActiveKey(true); }}
          />
        )
      )}

      {/* Notification channel section */}
      {/* story #3994 CHANGES-4(페드루 PO C4 2026-09-17) — 「시스템 발행」은 canEditWebhook이
          false라 webhookAdminOnly("관리자만 다른 멤버의 웹훅을 설정할 수 있어요")가 org
          admin 본인에게도 뜬다 — 실제 사유(예약 멤버라 무조건 편집 불가)와 다른 거짓
          사유라 카드 자체를 미렌더(아래 알림 설정 요약 카드도 동일 사유·동일 처방). */}
      {!isSystemPublisherAgent && (() => {
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
              {!canEditWebhook ? (
                <p className="text-xs text-muted-foreground">{t('webhookAdminOnly')}</p>
              ) : null}
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{t('webhookEnabledToggle')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('webhookEnabledHelp')}</p>
                </div>
                <Switch
                  checked={webhookActive}
                  onCheckedChange={(next) => void handleToggle(next)}
                  disabled={savingWebhook || !canEditWebhook}
                />
              </div>
              <div className="flex gap-2">
                <OperatorInput
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://your-agent.example.com/webhook"
                  className="flex-1 font-mono text-xs"
                  disabled={!webhookActive || !canEditWebhook}
                />
                <Button
                  variant="hero"
                  size="sm"
                  onClick={() => void handleSaveWebhook()}
                  disabled={savingWebhook || !webhookActive || !webhookUrl.trim() || !canEditWebhook}
                >
                  {savingWebhook ? '...' : tc('save')}
                </Button>
              </div>
            </SectionCardBody>
          </SectionCard>
        );
      })()}

      {/* story #2623 — 멤버 관점 요약(AC3, «이 에이전트는 어느 대화에서 무엇을 받나»). 웹훅
          섹션과 동일 admin/owner 게이트(canEditWebhook — story 933248fa와 같은 org role 축,
          새 인가 어휘 발명 없음) 재사용. BE #2623 착지 대기 — 착지 前엔 로드에러/자기자신
          목록으로 보일 수 있다(컴포넌트 자체 docstring 참고, 조용히 감추지 않는다).
          story #3994 CHANGES-4(페드루 PO C4) — 위 알림 채널 카드와 동일 사유(거짓
          webhookAdminOnly 사유 회피)로 시스템 발행이면 미렌더. */}
      {!isSystemPublisherAgent && (
        <SectionCard>
          <SectionCardHeader>
            <h2 className="text-base font-semibold text-foreground">{t('notificationPreferencesSummaryTitle')}</h2>
          </SectionCardHeader>
          <SectionCardBody>
            {!canEditWebhook ? (
              <p className="text-xs text-muted-foreground">{t('webhookAdminOnly')}</p>
            ) : (
              <MemberNotificationPreferencesSummary memberId={id} memberLabel={agent.name} />
            )}
          </SectionCardBody>
        </SectionCard>
      )}

      {/* Messaging policy (E-MSG-POLICY S3) */}
      {canEdit && <MessagingPolicySection agentId={id} creatorUserId={agent.created_by} />}

      {/* story #2751(설계①) — 연결 설정 상시 섹션. connection-artifact를 항상 재조회해
          .mcp.json 등 연결 구조를 언제든 다시 볼 수 있게 한다(freshApiKey 유무와 무관).
          story #3994 CHANGES-2(페드루 PO 판정 2026-09-17) — 「시스템 발행」은 연결
          대상이 아니다(위 키 관리 자리의 중립 설명 "따로 연결하지 않아도 돼요" 바로
          아래에 "이렇게 연결하세요"가 뜨는 모순 발견) — 이 섹션 자체를 안 그린다
          (중립 설명을 또 하나 더 안 얹는다 — 위 1줄로 충분, 두 번째 대체 문구는
          같은 말을 반복할 뿐 새 정보가 없다). */}
      {!isSystemPublisherAgent ? (
        <AgentConnectionSettingsSection agentId={id} freshApiKey={freshApiKey} />
      ) : null}

      {/* Fakechat 채널 (SSE) — story #2362(2026-07-31): 예전엔 여기가 "이 포트로 접속하라"고
          안내했는데, fakechat은 다이얼아웃 방식이라 그 주소를 아무도 안 연다(포트를 안 쓴다).
          진짜 필요한 건 런치 셸의 env 한 줄 — API Keys 섹션(위)이 이미 관리하는 그 키를
          그대로 재사용한다(AC3 — 키 노출은 새 방식을 안 만들고 그 섹션의 fresh-key/masked
          패턴을 그대로 쓴다).
          story #3994 CHANGES-3(유나 design 재앵커 적발·PO 코드 확認 2026-09-17) — 이 인라인
          SectionCard가 canEdit류 게이트 없이 무조건 렌더돼, 「시스템 발행」(키 발급이 막혀
          hasActiveKey는 항상 false)에게 「런치 셸에 export SPRINTABLE_API_KEY=… 넣으세요」
          연결 지시 + agentFakechatEnvKeyRequired amber 거짓 경고(위 API 키 자리의 "따로
          연결하지 않아도 돼요"와 같은 화면에서 모순)가 떴다. 연결 설정 섹션(위)과 동일하게
          섹션 자체를 미렌더 — 새 대체 문구 추가 없음(위 중립 설명 1줄로 이미 충분). */}
      {!isSystemPublisherAgent ? (
        <SectionCard>
          <SectionCardHeader>
            <div className="flex items-center justify-between w-full">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-foreground">{t('agentFakechatTitle')}</h2>
                  <Badge variant="info">SSE</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('agentFakechatDescription')}
                </p>
              </div>
              {freshApiKey ? (
                <Button variant="glass" size="sm" onClick={() => void handleCopyFakechatEnvKey()}>
                  {fakechatEnvKeyCopied ? <Check className="h-3.5 w-3.5" /> : <><Copy className="h-3.5 w-3.5 mr-1" />Copy export</>}
                </Button>
              ) : null}
            </div>
          </SectionCardHeader>
          <SectionCardBody className="space-y-3">
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <p>{t('agentFakechatEnvKeyInstruction')}</p>
              <p>{webhookActive ? t('agentFakechatWebhookActiveNote') : t('agentFakechatWebhookOffNote')}</p>
              <p>
                {t.rich('agentFakechatSuccessCheck', {
                  code: (chunks) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{chunks}</code>,
                })}
              </p>
            </div>

            {freshApiKey ? (
              <>
                <p className="text-xs text-success">{t('agentFakechatEnvKeyFreshNote')}</p>
                <code className="block overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground/80">
                  export SPRINTABLE_API_KEY={freshApiKey}
                </code>
              </>
            ) : !hasActiveKey ? (
              <p className="text-xs text-warning-strong">{t('agentFakechatEnvKeyRequired')}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('agentFakechatEnvKeySecurityNote')}</p>
            )}
          </SectionCardBody>
        </SectionCard>
      ) : null}

      {/* 프로젝트 접근 (org-agent 멀티프로젝트 단일키 grant) — 088987d8 */}
      {/* 프로젝트 grant 게이트는 page canEdit(creator 포함)보다 엄격 — creator라도 비-admin이면 과권한
          (RC①). org admin/owner 만 page-wide 허용(org admin 은 org 전 프로젝트 grant 가능 = BE
          _require_owner_or_admin 정합·403 surprise 0; 단일 project owner-non-admin 은 안전하게 미노출). */}
      <AgentProjectAccessSection
        agentMemberId={id}
        projects={projects}
        canEdit={(orgRole === 'admin' || orgRole === 'owner') && !isSystemPublisherAgent}
      />
    </div>
  );
}
