'use client';

import { useEmbeddedServer } from '@/components/embedded-server-context';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { formatAgentRuntimeLine } from '@/components/agents/agent-management-tab';
import { sessionStateLabel } from '@/components/chat/agent-session-strip';
import type { SessionLimit } from '@/lib/agent-session-limit';
import type { SessionRun } from '@/lib/agent-session-run';
import { AlertTriangle, ArrowLeft, Check, Copy, MinusCircle, Pencil, X, XCircle } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { AgentConnectionSettingsSection } from '@/components/agents/agent-connection-settings-section';
import { MessagingPolicySection } from '@/components/agents/messaging-policy-section';
import { AgentRunProfileSection } from '@/components/agents/agent-run-profile-section';
import { isDesktopRuntime } from '@/lib/agent-run-profile';
import { Button } from '@/components/ui/button';
import { Button as DsButton } from '@/components/ds/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ds/tabs';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { EmptyState } from '@/components/ds/empty-state';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { IconButton } from '@/components/ds/icon-button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ds/menu';
import { PageFrame } from '@/components/ds/page-frame';
import { PageSplit } from '@/components/ds/page-split';
import { SummaryCard } from '@/components/ds/summary-card';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { AgentsTopBarTitle } from '@/components/nav/flat-tab-top-bar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { DetailCard } from '@/components/agents/detail-card';
import { AgentProjectAccessSection } from '@/components/settings/agent-project-access-section';
import { Avatar } from '@/components/shared/avatar';
import { AvatarEditCard } from '@/components/shared/avatar-edit-card';
import { MemberNotificationPreferencesSummary } from '@/components/agents/member-notification-preferences-summary';
import { useToast } from '@/components/ui/toast';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  RUNTIME_REGISTRY,
  getRuntimeDef,
  resolveRuntimeStatus,
  runtimeLabel,
  type RuntimeStatus,
} from '@/lib/runtime-capabilities';

import { fetchWithAuth } from '@/lib/db/client';
import { fetchMe } from '@/lib/me-client';
import { agentRoleLabel } from '@/lib/org-role-label';
import { copyTextSafely } from '@/lib/clipboard';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

/** 런타임 상태(6종 중 ①~⑤) → 배지·헬퍼 표현. ⑥(드롭다운 dot)은 AC 범위 외(§11). */
const RUNTIME_STATUS_UI: Record<
  RuntimeStatus,
  {
    labelKey: string;
    helpKey: string;
    Icon: typeof Check | null;
  }
> = {
  supported: { labelKey: 'runtimeSupported', helpKey: 'runtimeSupportedHelp', Icon: Check },
  partial: { labelKey: 'runtimePartial', helpKey: 'runtimePartialHelp', Icon: AlertTriangle },
  unsupported: { labelKey: 'runtimeUnsupported', helpKey: 'runtimeUnsupportedHelp', Icon: XCircle },
  unset: { labelKey: 'runtimeUnset', helpKey: 'runtimeUnsetHelp', Icon: MinusCircle },
  unknown: { labelKey: 'runtimeUnknown', helpKey: 'runtimeUnknownHelp', Icon: XCircle },
};

/** story 4912 (C1): the status chip's tone — colour only where it MEANS something (supported = done · partial = needs a hand · unsupported/unknown = failed · unset = neutral). */
const RUNTIME_CHIP_TONE: Record<RuntimeStatus, 'neutral' | 'done' | 'needs-hand' | 'failed'> = {
  supported: 'done', partial: 'needs-hand', unsupported: 'failed', unset: 'neutral', unknown: 'failed',
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

/** story 4675 — what GET /api/agents/{id}/desktop-session says about where the agent is (the DM strip's shape · the bound pair is new) */
interface DeskView {
  setup_id: string | null;
  device_name: string | null;
  state: string | null;
  activity?: string | null;
  limit?: SessionLimit | null;
  // story 4686 (AC2): what the live session really runs on (the strip's line · «지금 도는 것» in the run group)
  run?: SessionRun | null;
  bound_setup_id?: string | null;
  bound_device_name?: string | null;
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

type DetailTab = 'run' | 'keys' | 'notify' | 'access';

export default function AgentDetailPage() {
  const embedded = useEmbeddedServer();
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('settings');
  const ta = useTranslations('agents');
  const tSession = useTranslations('chats.agentSession'); // story 4675 — the session's word, the DM strip's table
  // story 4675 (Yuna 5068): /desktop redirects to Today while DESKTOP_DOWNLOAD_ENABLED is off (prod now) — the link follows the
  // same flag the sidebar and /more read (navV3Flags); off, or not known → no link, the line stays
  const { navV3Flags } = useDashboardContext();
  const desktopPageOn = navV3Flags?.desktopDownloadEnabled === true;
  const tc = useTranslations('common');
  const to = useTranslations('organization');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { addToast } = useToast();

  const [agent, setAgent] = useState<AgentMember | null>(null);
  const [loading, setLoading] = useState(true);
  // story 4889 (UI-6 · W2): which panel of the detail is shown (the page's own state — not an address)
  const [detailTab, setDetailTab] = useState<DetailTab>('run');
  // story 4889 (AC3 §5 #6) — the agent could not be read: said on the screen (it used to bounce to the list without a word, and `!agent` drew nothing)
  const [loadError, setLoadError] = useState<null | 'notfound' | 'failed'>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [orgRole, setOrgRole] = useState<string>('member');
  // story 4675 (F2): the computer this agent runs on (its reported session · the DM strip's own read) or is bound to (its live
  // key's setup) — one read; nothing said when neither (the page as it was)
  const [desk, setDesk] = useState<DeskView | null>(null);
  useEffect(() => {
    setDesk(null); // story 4889: the previous agent's computer line must not stay while the new id is read
    let off = false;
    fetchWithAuth(`/api/agents/${id}/desktop-session`)
      .then(async (r) => (r.ok ? ((await r.json()) as DeskView) : null))
      .catch(() => null)
      .then((v) => { if (!off) setDesk(v); });
    return () => { off = true; };
  }, [id]);

  // story 4912 (A2): the avatar's photo card opens from the avatar (a dialog) and the deactivate goes through a confirm like the list's
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false); // one activate / deactivate request at a time (a double press must not send two)
  const togglingRef = useRef(false); // the same guard, read synchronously: two presses in one tick are both before the next render
  // story 4912 (B2, codex 5697 r2): a GENERATION, not the id — A→B→A inside one request must not let the old request clear the new request's guard or write its answer
  const toggleGenRef = useRef(0);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const [selectedRuntime, setSelectedRuntime] = useState<string>('');
  const [savingRuntime, setSavingRuntime] = useState(false);

  const [webhookConfigs, setWebhookConfigs] = useState<WebhookConfig[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  // story 4889: the id the page shows NOW — a late answer for an older id is dropped (and the per-agent side state is cleared when the id changes)
  const idRef = useRef(id);
  useEffect(() => { idRef.current = id; }, [id]); // (assigned in an effect, not during render — an abandoned concurrent render must not move it; this effect is declared before the loads below, so it runs first)
  // story 4912 (A2): the two dialogs belong to the agent they were opened for — a route change to another agent closes them (a deactivate confirm opened for A must never confirm against B)
  useEffect(() => { setAvatarOpen(false); setDeactivateOpen(false); setTogglingActive(false); togglingRef.current = false; toggleGenRef.current += 1; }, [id]);
  const [webhookActive, setWebhookActive] = useState(false);
  const [savingWebhook, setSavingWebhook] = useState(false);

  const [freshApiKey, setFreshApiKey] = useState<string | null>(null);
  const [hasActiveKey, setHasActiveKey] = useState(false);
  // story 4912 (A2): the side summary says «활성 키 있음/없음» only once a key-list read really worked (a failed read is not «없음»)
  const [keysReadOk, setKeysReadOk] = useState(false);
  const keyReadSeqRef = useRef(0); // story 4912 (B2, codex): the newest key read wins — two retries / a retry and the initial read must not land out of order
  const [keysReading, setKeysReading] = useState(false);
  const [keysReadFailed, setKeysReadFailed] = useState(false); // story 4912 (B2): a failed key read is said as a failure (with [다시 시도]) — never as «no key»
  const [fakechatEnvKeyCopied, setFakechatEnvKeyCopied] = useState(false);

  const [projects, setProjects] = useState<ProjectOption[]>([]);

  // story #4231 — fetchAgent는 로드 효과의 의존성이라 flatHref를 의존성에 넣으면 프로젝트가 바뀔 때마다 에이전트를 다시 받는다.
  // 실패 시 되돌리는 주소만 최신 목표 프로젝트를 쓰면 되므로 ref로 읽는다.
  const flatHrefRef = useRef(flatHref);
  useEffect(() => { flatHrefRef.current = flatHref; }, [flatHref]);

  // story 4889 — one read at a time counts: a new id (or a retry) starts a new read and the late answer of an older one is dropped (it used to be able to
  // overwrite the newer page, and the OLD agent stayed on the screen while the new one was being read — or after its read failed).
  const readSeq = useRef(0);
  const fetchAgent = useCallback(async (): Promise<boolean> => {
    // story 4889 (AC3 §5 #6): a failed read is SAID on the screen with a way out (retry · back to the list) — no silent bounce, no blank page. (Before: `router.replace(list)` — story #1990's
    // «no back-button trap» still holds: this page never redirects itself, so Back leaves it at once.) Returns whether this read is still the current one.
    const seq = ++readSeq.current;
    const live = () => seq === readSeq.current;
    setAgent(null);
    setLoadError(null);
    try {
      const res = await fetchWithAuth(`/api/team-members/${id}`);
      if (!live()) return false;
      if (!res.ok) { setLoadError(res.status === 404 || res.status === 403 ? 'notfound' : 'failed'); return true; }
      const json = await res.json() as { data: AgentMember };
      if (!live()) return false;
      setAgent(json.data);
      return true;
    } catch {
      if (!live()) return false;
      setLoadError('failed');
      return true;
    }
  }, [id]);

  const fetchOrgContext = useCallback(async () => {
    // story #3519(§16-7 2부, PO 確定 2026-09-05) — 둘 다 부수(ok?채움:방치, 그 외 화면을
    // 안 막는다)인데 catch가 어디에도 없었다 — 하나가 네트워크단 reject하면 나머지도
    // 조용히 못 채워졌다. leg별로 격리한다.
    const [projectRes, meRes] = await Promise.all([
      fetchWithAuth('/api/projects').catch(() => null),
      fetchMe().catch(() => null),
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
    const forId = id;
    const res = await fetchWithAuth(
      `/api/webhooks/config?project_id=${encodeURIComponent(projectId)}&member_id=${encodeURIComponent(id)}`,
    );
    if (!res.ok || idRef.current !== forId) return;
    const json = await res.json() as { data: WebhookConfig[] };
    if (idRef.current !== forId) return;
    const agentConfigs = (json.data ?? []).filter((c) => c.member_id === id);
    setWebhookConfigs(agentConfigs);
    setWebhookUrl(agentConfigs[0]?.url ?? '');
  }, [id]);

  const fetchActiveApiKey = useCallback(async () => {
    const forId = id;
    const seq = ++keyReadSeqRef.current;
    const current = () => idRef.current === forId && keyReadSeqRef.current === seq;
    setKeysReading(true);
    try {
      const res = await fetchWithAuth(`/api/agents/${id}/api-key`);
      if (!current()) return;
      if (!res.ok) { setKeysReadFailed(true); return; }
      const json = await res.json() as { data: ApiKey[] };
      if (!current()) return;
      const active = (json.data ?? []).find((k) => !k.revoked_at);
      setHasActiveKey(!!active);
      setKeysReadOk(true);
      setKeysReadFailed(false);
    } catch {
      if (current()) setKeysReadFailed(true);
    } finally {
      if (keyReadSeqRef.current === seq) setKeysReading(false);
    }
  }, [id]);

  useEffect(() => {
    let current = true; // story 4889: an older id's late answer does not end the newer id's loading
    // story 4889: the previous agent's side state (key presence · webhook · a freshly shown key) does not stay while this id is read
    setHasActiveKey(false); setKeysReadOk(false); setKeysReadFailed(false); setWebhookConfigs([]); setWebhookUrl(''); setFreshApiKey(null);
    setLoading(true);
    Promise.all([fetchAgent(), fetchActiveApiKey(), fetchOrgContext()])
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [fetchAgent, fetchActiveApiKey, fetchOrgContext]);

  useEffect(() => {
    // story 4889: right after the id changes `agent` still holds the PREVIOUS agent for a render — its project must not be asked for the new id
    if (!agent || agent.id !== id) return;
    void fetchWebhookConfigs(agent.project_id);
  }, [agent, id, fetchWebhookConfigs]);

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
      addToast({ type: 'success', title: t('webhookUrlSavedToast') });
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
      <SkeletonGroup label={tc('loading')} className="w-full max-w-3xl mx-auto p-6 space-y-4" data-testid="agent-detail-loading">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
      </SkeletonGroup>
    );
  }

  if (!agent) {
    // story 4889 (AC3 §5 #6): not a blank page — the reason, and the way out. The list address is read at the PRESS (story #4231: the project the person is switching to now, not the one at render).
    const kind = loadError ?? 'failed';
    const backToList = () => { const flatHref = flatHrefRef.current; router.push(flatHref('/organization/workforce?tab=manage')); }; // (read at the press · the ratchet knows the `flatHref(` wrap by this name)
    return (
      <div className="w-full max-w-3xl mx-auto p-6" data-testid="agent-detail-load-error" data-kind={kind} role="alert">
        <EmptyState
          icon="error"
          title={ta(kind === 'notfound' ? 'detailNotFound' : 'detailLoadFailed')}
          action={(
            <div className="flex flex-wrap justify-center gap-2">
              {kind === 'failed' ? (
                <DsButton variant="primary" onClick={() => { setLoading(true); void fetchAgent().then((isCurrent) => { if (isCurrent) setLoading(false); }); }}>{tc('retry')}</DsButton>
              ) : null}
              <DsButton variant="secondary" onClick={backToList}>{ta('backToList')}</DsButton>
            </div>
          )}
        />
      </div>
    );
  }

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
  // story 4889 (W2): a panel is offered only while it has a section to show this viewer (keys: canEditBase · notify: the webhook/summary cards or the messaging policy)
  const showKeysTab = canEditBase;
  const showNotifyTab = !isSystemPublisherAgent || canEdit;
  const shownTab: DetailTab = (detailTab === 'keys' && !showKeysTab) || (detailTab === 'notify' && !showNotifyTab) ? 'run' : detailTab;

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
    if (togglingRef.current) return;
    togglingRef.current = true;
    const next = !agent.is_active;
    const gen = toggleGenRef.current;
    const stillMine = () => toggleGenRef.current === gen; // false once the page left this agent (any id change bumps it — also A→B→A)
    setTogglingActive(true);
    let res: Response;
    try {
      res = await fetchWithAuth(`/api/team-members/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
    } finally {
      if (stillMine()) { togglingRef.current = false; setTogglingActive(false); }
    }
    if (!stillMine()) return; // the page moved on to another agent while this was out: its answer is not this page's
    if (res.ok) {
      const json = await res.json() as { data: AgentMember };
      if (!stillMine()) return; // the body took long enough for the page to leave
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

  // story 4832: one computer in the app's own server — no «지금 도는 컴퓨터» line (and no link to a device list that is not drawn there)
  const computerLine = embedded ? null : desk?.state && desk.device_name
    ? ta('runningOn', { name: desk.device_name, state: sessionStateLabel(desk, tSession) })
    : desk?.bound_device_name ? ta('boundNotRunYet', { name: desk.bound_device_name }) : null;
  const computerSetupId = desk?.setup_id ?? desk?.bound_setup_id ?? null;
  const canManageDevices = (orgRole === 'admin' || orgRole === 'owner') && desktopPageOn;
  const summaryItems = [
    ...(computerLine ? [{
      id: 'computer',
      label: ta('detailSummaryComputer'),
      value: (
        <span data-testid="agent-running-on" className="flex flex-col gap-0.5">
          <span>{computerLine}</span>
          {canManageDevices && computerSetupId ? (
            <Link href={flatHref(`/desktop#device=${computerSetupId}`)} className="whitespace-nowrap text-ds-small font-medium text-ds-action-text hover:underline" data-testid="agent-see-devices">
              {ta('seeConnectedDevices')}
            </Link>
          ) : null}
        </span>
      ),
    }] : []),
    // the key list is read for the people who may manage keys only (canEditBase); for others «no key» would be a guess
    ...(showKeysTab && keysReadOk ? [{ id: 'key', label: ta('detailSummaryKey'), value: hasActiveKey ? ta('detailSummaryKeyHas') : ta('detailSummaryKeyNone') }] : []),
  ];
  const connectorText = runtimeLabel(agent.runtime_type);

  return (
    <PageFrame width="wide">
      <TopBarSlot title={<AgentsTopBarTitle />} showContextChip />
      {/* story #1990: replace, 기본 push 아님 — 뒤로가기 재진입 트랩 방지(§3.2). story 4912 (A2): the back link keeps its place; the big «조직 에이전트» title is gone (the top bar says the screen's name). */}
      <Link href={flatHref('/organization/workforce?tab=manage')} replace className="inline-flex w-fit items-center gap-1.5 text-ds-small text-ds-ink-3 hover:text-ds-ink" data-testid="agent-detail-back">
        <ArrowLeft className="h-4 w-4" />
        {ta('title')}
      </Link>

      <PageSplit asideLabel={ta('detailSideLabel')} aside={<SummaryCard title={ta('detailSummaryTitle')} items={summaryItems} emptyText={ta('detailSummaryEmpty')} emptyLabel={ta('detailSummaryEmptyLabel')} />}>
        <div className="flex flex-col gap-6">
      {/* 기본 정보 — story 4912 (A2): ONE head card (avatar · name · role/connector chips · runtime line · «⋯» menu); the photo card opens from the avatar, the activate/deactivate lives in the menu */}
      <Card data-testid="agent-detail-head" className="p-4">
        <div className="flex items-start justify-between gap-3">
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
                placeholder={t('agentRolePlaceholder')}
                className="max-w-32"
              />
              <button type="button" onClick={() => void handleSaveEdit()} disabled={savingEdit} aria-label={tc('save')} className="text-success transition hover:opacity-80 disabled:opacity-50">
                <Check className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setEditingName(false)} aria-label={tc('cancel')} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {canEdit ? (
                <Button type="button" variant="ghost" onClick={() => setAvatarOpen(true)} aria-label={ta('detailAvatarChangeAria')} data-testid="agent-avatar-open" className="h-auto w-auto shrink-0 rounded-full p-0">
                  <Avatar name={agent.name} avatarUrl={agent.avatar_url} actorType="agent" size={44} runtimeType={agent.runtime_type} />
                </Button>
              ) : (
                <Avatar name={agent.name} avatarUrl={agent.avatar_url} actorType="agent" size={44} runtimeType={agent.runtime_type} />
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-ds-card-title font-semibold text-ds-ink">{agent.name}</span>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => { setEditName(agent.name); setEditRole(agent.role); setEditingName(true); }}
                      aria-label={tc('edit')}
                      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {!agent.is_active ? <Chip>{ta('statusInactive')}</Chip> : null}
                  <Chip>{t('agentMember')}</Chip>
                  <Chip>{agentRoleLabel(agent.role, to)}</Chip>
                  {/* story #3092(2단계, 표면3) — 커넥터 필드. runtime_type null이면 생략
                      (전역 폴백 규칙 — 추측·「미지정」류 문구 금지). 공식 로고는 법무
                      사인오프 전이라 이번엔 텍스트만(로고 트랙은 후속 스코프). */}
                  {connectorText ? <Chip>{t('connectorLabel')}: {connectorText}</Chip> : null}
                  {agent.needs_restart ? <Chip tone="needs-hand">{ta('agentNeedsRestartBadge')}</Chip> : null}
                </div>
                {(() => {
                  const runtimeLine = formatAgentRuntimeLine(agent, locale, displayTimezone, ta);
                  return runtimeLine ? (
                    <p className="mt-1 truncate text-ds-small text-ds-ink-3">{runtimeLine}</p>
                  ) : null;
                })()}
              </div>
            </div>
          )}
          {canEdit && !editingName ? (
            <Menu>
              <MenuTrigger render={<IconButton icon="more_horiz" label={ta('detailActionsAria')} data-testid="agent-detail-actions" />} />
              <MenuContent align="end">
                {agent.is_active ? (
                  <MenuItem variant="danger" icon="block" disabled={togglingActive} onClick={() => setDeactivateOpen(true)}>{t('deactivateAgent')}</MenuItem>
                ) : (
                  <MenuItem icon="check_circle" disabled={togglingActive} onClick={() => void handleToggleActive()}>{t('activateAgent')}</MenuItem>
                )}
              </MenuContent>
            </Menu>
          ) : null}
        </div>
      </Card>

      {/* the photo card, opened from the avatar (it used to sit under the head card all the time) */}
      <Dialog open={avatarOpen} onOpenChange={setAvatarOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{ta('detailAvatarChangeAria')}</DialogTitle>
            <DialogDescription className="sr-only">{ta('detailAvatarChangeAria')}</DialogDescription>
          </DialogHeader>
          <AvatarEditCard
            memberId={agent.id}
            name={agent.name}
            avatarUrl={agent.avatar_url ?? null}
            actorType="agent"
            onUpdated={(url) => setAgent((prev) => (prev ? { ...prev, avatar_url: url } : prev))}
          />
        </DialogContent>
      </Dialog>

      {/* story #2406 AC1 (the list's rule, here too — PO 11-12 «같은 행동 · 같은 보호»): deactivating asks first (the 2026-08-01 incident: a wrong press switched a real account off); activating is immediate */}
      <Dialog open={deactivateOpen} onOpenChange={setDeactivateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deactivateAgentDialogTitle', { name: agent.name })}</DialogTitle>
            <DialogDescription>{t('deactivateAgentDialogBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeactivateOpen(false)}>{tc('cancel')}</Button>
            <Button variant="destructive" disabled={togglingActive} onClick={() => { setDeactivateOpen(false); void handleToggleActive(); }}>{t('deactivateAgentDialogConfirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* story 4889 (UI-6 · W2, AC3 §2) — the one long scroll became four panels under a ds Tabs strip: 실행 환경 · 키 · 알림/메시징 · 접근. Every section stays (nothing removed · no new behaviour);
          panels stay MOUNTED (keepMounted) so a section's own state and loads are not lost when you switch. A tab whose sections are all hidden for this viewer/agent is not offered. */}
      <Tabs value={shownTab} onValueChange={(v) => setDetailTab(v as DetailTab)}>
        <TabsList aria-label={ta('detailTabsLabel')} data-testid="agent-detail-tabs">
          <TabsTrigger value="run">{ta('detailTabRun')}</TabsTrigger>
          {showKeysTab ? <TabsTrigger value="keys">{ta('detailTabKeys')}</TabsTrigger> : null}
          {showNotifyTab ? <TabsTrigger value="notify">{ta('detailTabNotify')}</TabsTrigger> : null}
          <TabsTrigger value="access">{ta('detailTabAccess')}</TabsTrigger>
        </TabsList>
        <TabsContent value="run" keepMounted className="space-y-6 pt-4">
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
            <DetailCard
              data-testid="agent-detail-card-runtime"
              title={t('runtimeTypeTitle')}
              chips={(
                <Chip tone={RUNTIME_CHIP_TONE[runtimeStatus]}>
                  {StatusIcon ? <StatusIcon className="h-3 w-3" /> : null}
                  {t(ui.labelKey)}
                </Chip>
              )}
              description={t('runtimeTypeDescription')}
            >
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
                      <DsButton
                        variant="primary"
                        onClick={() => void handleSaveRuntime()}
                        disabled={savingRuntime || !canSaveRuntime}
                      >
                        {savingRuntime ? '...' : tc('save')}
                      </DsButton>
                    </div>
                    <p className="text-ds-small text-ds-ink-3">{t(ui.helpKey)}</p>
                  </>
                ) : (
                  <div className="space-y-1">
                    <p className="text-ds-body text-ds-ink">
                      {stagedDef?.label ?? (selectedRuntime || t('runtimeUnset'))}
                    </p>
                    <p className="text-ds-small text-ds-ink-3">{t(ui.helpKey)}</p>
                  </div>
                )}
            </DetailCard>
          );
        })()}

        {/* story #4540 (C-5) — «실행»: the model · effort the desktop app starts this agent with (desktop runtimes only) */}
        {isDesktopRuntime(agent.runtime_type) ? <AgentRunProfileSection agentId={agent.id} runtimeType={agent.runtime_type ?? null} runNow={desk?.run ?? null} /> : null}

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
          <DetailCard
            data-testid="agent-detail-card-sse"
            title={t('agentFakechatTitle')}
            chips={<Chip tone="info">SSE</Chip>}
            description={t('agentFakechatDescription')}
            action={freshApiKey ? (
              <DsButton variant="secondary" onClick={() => void handleCopyFakechatEnvKey()}>
                {fakechatEnvKeyCopied ? <Check className="h-3.5 w-3.5" /> : <><Copy className="mr-1 h-3.5 w-3.5" />{ta('fakechatEnvCopyExport')}</>}
              </DsButton>
            ) : undefined}
          >
            {/* story #4240(유나 390 실측 «않아/요») — 한국어 안내 줄은 낱말 단위로만 줄바꿈(break-keep · CJK에만 작용 · 키·코드 줄 무영향). */}
            <div className="space-y-3 break-keep">
              <div className="space-y-1.5 text-ds-small text-ds-ink-3">
                <p>{t('agentFakechatEnvKeyInstruction')}</p>
                <p>{webhookActive ? t('agentFakechatWebhookActiveNote') : t('agentFakechatWebhookOffNote')}</p>
                <p>
                  {t.rich('agentFakechatSuccessCheck', {
                    code: (chunks) => <code className="rounded-ds-tag bg-ds-surface-high px-1 py-0.5 font-mono text-ds-mono-md text-ds-ink">{chunks}</code>,
                  })}
                </p>
              </div>

              {freshApiKey ? (
                <>
                  <p className="text-ds-small text-ds-done">{t('agentFakechatEnvKeyFreshNote')}</p>
                  <code className="block overflow-x-auto rounded-ds-control border border-ds-line bg-ds-surface-sunk p-3 font-mono text-ds-mono-md text-ds-ink-2">
                    export SPRINTABLE_API_KEY={freshApiKey}
                  </code>
                </>
              ) : keysReadFailed && !keysReadOk ? (
                <div className="flex flex-wrap items-center gap-2" data-testid="agent-key-read-failed">
                  <p role="status" className="text-ds-small text-ds-needs-hand">{ta('detailKeyReadFailed')}</p>
                  <DsButton variant="secondary" disabled={keysReading} onClick={() => { void fetchActiveApiKey(); }}>{tc('retry')}</DsButton>
                </div>
              ) : !hasActiveKey ? (
                <p className="text-ds-small text-ds-needs-hand">{t('agentFakechatEnvKeyRequired')}</p>
              ) : (
                <p className="text-ds-small text-ds-ink-3">{t('agentFakechatEnvKeySecurityNote')}</p>
              )}
            </div>
          </DetailCard>
        ) : null}

        </TabsContent>
        <TabsContent value="keys" keepMounted className="space-y-6 pt-4">
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
            <DetailCard data-testid="agent-detail-card-system-notice">
              <p className="text-ds-small text-ds-ink-3" data-testid="agent-detail-system-publisher-notice">
                {ta('systemPublisherNeutralDescription')}
              </p>
            </DetailCard>
          ) : (
            <AgentApiKeyManager
              agentId={id}
              agentName={agent.name}
              onNewKey={(key) => { setFreshApiKey(key); setHasActiveKey(true); }}
              onKeysRead={(n) => { setHasActiveKey(n > 0); setKeysReadOk(true); }}
            />
          )
        )}

        </TabsContent>
        <TabsContent value="notify" keepMounted className="space-y-6 pt-4">
        {/* Notification channel section */}
        {/* story #3994 CHANGES-4(페드루 PO C4 2026-09-17) — 「시스템 발행」은 canEditWebhook이
            false라 webhookAdminOnly("관리자만 다른 멤버의 웹훅을 설정할 수 있어요")가 org
            admin 본인에게도 뜬다 — 실제 사유(예약 멤버라 무조건 편집 불가)와 다른 거짓
            사유라 카드 자체를 미렌더(아래 알림 설정 요약 카드도 동일 사유·동일 처방). */}
        {!isSystemPublisherAgent && (() => {
          const webhookState = getWebhookState(webhookConfigs);
          return (
            <DetailCard
              data-testid="agent-detail-card-webhook"
              title={t('notificationChannel')}
              chips={(
                <>
                  {webhookState === 'empty' && <Chip tone="info">{t('webhookStatusEmpty')}</Chip>}
                  {webhookState === 'active' && <Chip tone="done">{t('webhookStatusActive')}</Chip>}
                  {webhookState === 'paused' && (
                    <>
                      <Chip>{t('webhookStatusInactive')}</Chip>
                      <Chip tone="info">{t('webhookStatusFallback')}</Chip>
                    </>
                  )}
                </>
              )}
              description={(
                <>
                  {webhookState === 'empty' && t('webhookHelperEmpty')}
                  {webhookState === 'active' && t('webhookHelperActive')}
                  {webhookState === 'paused' && t('webhookHelperPaused')}
                </>
              )}
            >
                {!canEditWebhook ? (
                  <p className="text-ds-small text-ds-ink-3">{t('webhookAdminOnly')}</p>
                ) : null}
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-ds-body font-medium text-ds-ink">{t('webhookEnabledToggle')}</p>
                    <p className="mt-0.5 text-ds-small text-ds-ink-3">{t('webhookEnabledHelp')}</p>
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
                    className="flex-1 font-mono"
                    disabled={!webhookActive || !canEditWebhook}
                  />
                  <DsButton
                    variant="primary"
                    onClick={() => void handleSaveWebhook()}
                    disabled={savingWebhook || !webhookActive || !webhookUrl.trim() || !canEditWebhook}
                  >
                    {savingWebhook ? '...' : tc('save')}
                  </DsButton>
                </div>
            </DetailCard>
          );
        })()}

        {/* story #2623 — 멤버 관점 요약(AC3, «이 에이전트는 어느 대화에서 무엇을 받나»). 웹훅
            섹션과 동일 admin/owner 게이트(canEditWebhook — story 933248fa와 같은 org role 축,
            새 인가 어휘 발명 없음) 재사용. BE #2623 착지 대기 — 착지 前엔 로드에러/자기자신
            목록으로 보일 수 있다(컴포넌트 자체 docstring 참고, 조용히 감추지 않는다).
            story #3994 CHANGES-4(페드루 PO C4) — 위 알림 채널 카드와 동일 사유(거짓
            webhookAdminOnly 사유 회피)로 시스템 발행이면 미렌더. */}
        {!isSystemPublisherAgent && (
          <DetailCard data-testid="agent-detail-card-notification-summary" title={t('notificationPreferencesSummaryTitle')}>
            {!canEditWebhook ? (
              <p className="text-ds-small text-ds-ink-3">{t('webhookAdminOnly')}</p>
            ) : (
              <MemberNotificationPreferencesSummary memberId={id} memberLabel={agent.name} />
            )}
          </DetailCard>
        )}

        {/* Messaging policy (E-MSG-POLICY S3) */}
        {canEdit && <MessagingPolicySection agentId={id} creatorUserId={agent.created_by} />}

        </TabsContent>
        <TabsContent value="access" keepMounted className="space-y-6 pt-4">
        {/* 프로젝트 접근 (org-agent 멀티프로젝트 단일키 grant) — 088987d8 */}
        {/* 프로젝트 grant 게이트는 page canEdit(creator 포함)보다 엄격 — creator라도 비-admin이면 과권한
            (RC①). org admin/owner 만 page-wide 허용(org admin 은 org 전 프로젝트 grant 가능 = BE
            _require_owner_or_admin 정합·403 surprise 0; 단일 project owner-non-admin 은 안전하게 미노출). */}
        <AgentProjectAccessSection
          agentMemberId={id}
          projects={projects}
          canEdit={(orgRole === 'admin' || orgRole === 'owner') && !isSystemPublisherAgent}
        />
        </TabsContent>
      </Tabs>
        </div>
      </PageSplit>
    </PageFrame>
  );
}
