'use client';

import { ORG_DELETED_LANDING } from '@/lib/auth/org-deleted-landing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { DesktopDownloadCard } from '@/components/desktop/desktop-download-card';
import { PhoneAppCard } from '@/components/desktop/phone-app-card';
import { ThisPhoneCard } from '@/components/settings/this-phone-card';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { UsageDashboard } from '@/components/settings/usage-dashboard';
import { OrgMembersSection } from '@/components/settings/org-members-section';
import { AddMemberModal } from '@/components/settings/add-member-modal';
import { MemberWebhooksSection } from '@/components/settings/member-webhooks-section';
import { ProjectAccessSection } from '@/components/settings/project-access-section';

import { MyProfileSection } from '@/components/settings/my-profile-section';
import { MyNotificationChannelSection } from '@/components/settings/my-notification-channel-section';
import { BlockedUsersSection } from '@/components/settings/blocked-users-section';
import { WorkflowTriggerTypesSection } from '@/components/settings/workflow-trigger-types-section';
import { RecurringRecipesSection } from '@/components/settings/recurring-recipes-section';
import { WorkflowExecutionHistorySection } from '@/components/settings/workflow-execution-history-section';
import { WorkflowTemplateGallerySection } from '@/components/settings/workflow-template-gallery-section';
import { WorkflowLineEditorSection } from '@/components/settings/workflow-line-editor-section';
import { ThemeSettings } from '@/components/settings/theme-settings';
import { LanguageSettings } from '@/components/settings/language-settings';
import { RefreshSettings } from '@/components/settings/refresh-settings';
import { StandupDeadlineSection } from '@/components/settings/standup-deadline-section';
import { GateLevelMatrix } from '@/components/settings/gate-level-matrix';
import { OrgGatePolicySection } from '@/components/settings/org-gate-policy-section';
import { OrganizationSection, OrgDangerSection } from '@/components/settings/organization-section';
import { TwoFactorSection } from '@/components/settings/two-factor-section';
import { OtherSessionsSection } from '@/components/settings/other-sessions-section';
import { SetPasswordSection } from '@/components/settings/set-password-section';
import { LinkedAccountsSection } from '@/components/settings/linked-accounts-section';
import { NotificationsPane } from './notifications-pane';
import { SettingsSection } from '@/components/settings/settings-section';
import { canSubmitOrgDelete } from './org-delete-gate';
import { DeleteAccountDialog } from '@/components/settings/delete-account-dialog';
import { LegalLinks, BusinessInfoBlock } from '@/components/legal/legal-footer';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { NOTIFICATION_TYPES } from '@/lib/notification-types';
import { isEEEnabled } from '@/lib/ee';
import { isSupportWidgetEnabled } from '@/lib/support-widget-flag';
import { HIDDEN_SETTINGS_TABS, resolveSettingsTab as resolveTab } from './settings-tab';
import { settingsNavGroups } from './settings-nav';
import { SettingsNav } from './settings-nav-list';
import { IconButton } from '@/components/ds/icon-button';
import { Banner } from '@/components/ds/banner';
import { Button as DsButton } from '@/components/ds/button';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { SupportSettingsTabPanel } from '@/components/settings/support-tab-panel';
import { ApiKeysMovedCard } from '@/components/settings/api-keys-moved-card';
import { AccountDangerSection } from '@/components/settings/account-danger-section';
import { ProjectsSection } from '@/components/settings/projects-section';
import { ProjectDeleteDialog } from '@/components/settings/project-delete-dialog';
import { OrgDeleteDialog } from '@/components/settings/org-delete-dialog';
import dynamic from 'next/dynamic';
import { fetchWithAuth } from '@/lib/db/client';
import { fetchMe } from '@/lib/me-client';
import { useFlatHref } from '@/hooks/use-flat-href';
import { withProjectParam } from '@/lib/with-project-param';
import { resolveChatsHref } from '@/lib/nav-v3-destinations';
import { memberRowLabels } from '@/lib/member-display';

// TypeScript 정적 해석을 위해 unconditional import — 조건부 렌더링은 JSX isEEEnabled() 체크로 처리
const BillingTab = dynamic(
  () => import('@/ee/components/billing/billing-tab').then((m) => ({ default: m.BillingTab })),
  { ssr: false },
);

interface NotificationSetting {
  id: string;
  channel: string;
  event_type: string;
  enabled: boolean;
}

interface WebhookConfig {
  id: string;
  member_id: string;
  url: string;
  is_active: boolean;
  project_id: string | null;
  projects?: { name: string };
}

interface ProjectOption {
  id: string;
  name: string;
  description?: string | null;
}

interface ProjectMember {
  id: string;
  name: string;
  email?: string;
  type: 'human' | 'agent';
  role: string;
  user_id: string | null;
  project_id: string;
  is_active: boolean;
  webhook_url?: string | null;
  created_by?: string | null;
  fakechat_port?: number | null;
}

const NOTIFICATION_CATEGORIES = [

  { key: 'story', types: ['story', 'story_assigned'] },
  { key: 'task', types: ['task', 'task_assigned', 'task_completed'] },
  { key: 'sprint', types: ['sprint_closed'] },
  { key: 'system', types: ['info', 'warning', 'system', 'standup_reminder', 'reward', 'invitation'] },
] as const satisfies ReadonlyArray<{ key: string; types: ReadonlyArray<(typeof NOTIFICATION_TYPES)[number]> }>;

type NotificationCategoryKey = typeof NOTIFICATION_CATEGORIES[number]['key'];

// story #3762 — adminChecked(/api/me 응답 전) 구간엔 이 자리가 "권한 없음"이 아니라
// "아직 모름"이다. null로 비우면 콜드 진입 시 레일이 통째로 짧아져 그 탭들이 애초에 없던
// 것처럼 보인다(로딩≠권한없음 클래스 결함) — 판정 전엔 자리만 스켈레톤으로 지키고,
// 판정 뒤에만 null(진짜 숨김)로 확정한다.

function isWebhookUrlAllowed(url: string): boolean {
  if (!url) return true;
  if (/^https:\/\//i.test(url)) return true;
  return /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/i.test(url);
}

// E-SETTINGS-IA: deprecate(숨김)된 settings 탭.
// - 'workflow'·'org-members'는 컴포넌트/route 보존(reversible) — 탭 트리거·콘텐츠·
//   딥링크(?tab=)만 차단, 재노출 시 이 set에서 제거만 하면 IA 위치 복원.
//   story c4980e70: org-members 탭 = /organization/members로 승격(회귀 0 위해 코드는
//   보존, LNB에서만 숨김).
// - 'ai'는 story #2487(PO 決 2026-09-10)로 컴포넌트·BFF route·i18n 키까지 전부 삭제됐다
//   (BE 라우트 0건 — Sprintable이 고객사 모델키/MCP연결을 호스팅하는 모델을 접었다는
//   판단, 재노출은 새 구현이 필요·set에서 제거만으론 복원 안 됨). 이 문자열은 과거 딥링크
//   (?tab=ai) 방어 폴백 용도로만 남긴다.
// the tab from ?tab= (pure · tested in settings-tab.test.ts) with this deployment's gates
const resolveSettingsTab = (tab: string | null, phoneApp: boolean): string => resolveTab(tab, { supportWidget: isSupportWidgetEnabled(), billing: isEEEnabled(), phoneApp });

export default function SettingsPage() {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const tLegal = useTranslations('legal');
  // story #2485 — projectLimitExceededError는 onboarding-form.tsx(#2484)와 동일 개념
  // (resource:"project" PLAN_LIMIT_EXCEEDED)이라 새 키를 만들지 않고 재사용한다.
  const tOnboarding = useTranslations('onboarding');
  const router = useRouter();
  const searchParamsHook = useSearchParams();
  // story 4906 (PO 11-12): a project made from the chat list's empty state («프로젝트 만들기» there) sends the person BACK where they came from — the list, where «에이전트 추가» already stands. A whitelist of one
  // word (not a free address: no open redirect); made from settings itself (no `return`) the person stays here as before.
  const returnToChats = searchParamsHook.get('return') === 'chats';
  const { orgId: ctxOrgId, orgMemberships, navV3Flags } = useDashboardContext();
  const { inPhoneApp } = usePhoneBridge(); // story 4762 — the «이 폰» tab exists only inside the phone app
  const [activeTab, setActiveTab] = useState(() => resolveSettingsTab(searchParamsHook.get('tab'), inPhoneApp));
  // story #3772 — 프로필 탭 섹션 넷(내 프로필·비밀번호·연결된 계정·2FA)이 각자 /api/me를
  // 읽다 실패하면 «이유 없이» 조용히 사라졌다. 섹션은 그대로 두고(각자의 「모름」 렌더
  // 로직 무변) 탭 한 자리에서만 사유+재시도를 말한다(같은 사실 네 번 금지). retryNonce를
  // key로 써서 재시도 클릭이 섹션 넷을 통째로 리마운트(=재-fetch)한다(상세페이지
  // key-remount 정본과 동형, 섹션별 refetch 함수를 새로 노출할 필요가 없다).
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [profileRetryNonce, setProfileRetryNonce] = useState(0);
  const handleProfileSectionLoadError = useCallback(() => setProfileLoadFailed(true), []);
  const handleProfileTabRetry = useCallback(() => {
    setProfileLoadFailed(false);
    setProfileRetryNonce((n) => n + 1);
  }, []);
  const [lnbOpen, setLnbOpen] = useState(() => !searchParamsHook.get('tab')); // a phone arriving at /settings with no ?tab= sees the LIST first (≥md the list is always there)
  const { addToast } = useToast();

  const pickedTabByHand = useRef(false); // story 4762 — set once the person clicks a tab: a phone claim that comes later must not move them back to the link's tab
  const handleTabChange = (tab: string) => {
    pickedTabByHand.current = true;
    setActiveTab(tab);
    setLnbOpen(false); // 모바일에서 탭 선택 시 LNB 자동 접기
  };

  // story 4762 — the tab follows the link (`?tab=`) when the link changes AND when the phone claim comes after the first render (a `?tab=this-phone` link then lands on its tab once the
  // tab exists) — but a claim that comes later never moves a person who already picked a tab by hand
  const lastSearchParams = useRef(searchParamsHook);
  useEffect(() => {
    const linkChanged = lastSearchParams.current !== searchParamsHook;
    lastSearchParams.current = searchParamsHook;
    if (!linkChanged && pickedTabByHand.current) return;
    const tab = searchParamsHook.get('tab');
    if (tab) {
      setActiveTab(resolveSettingsTab(tab, inPhoneApp));
      if (linkChanged) setLnbOpen(false); // a link to a section while the phone's list is up opens that pane (the row would be selected behind a hidden pane otherwise)
    } else if (linkChanged) {
      setLnbOpen(true); // …and back to /settings with no `?tab=` is the list again
    }
  }, [searchParamsHook, inPhoneApp]);

  // story 4762 — the «이 폰» tab only exists inside the phone app: if the bridge goes away while the person is on it, the tab list must not point at a pane that is gone
  useEffect(() => {
    if (!inPhoneApp) setActiveTab((current) => (current === 'this-phone' ? resolveSettingsTab('this-phone', false) : current)); // functional: a link change queued in the same pass keeps winning
  }, [inPhoneApp]);

  const [orgId, setOrgId] = useState<string | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [orgInfo, setOrgInfo] = useState<{ id: string; name: string; slug: string; plan?: string; role?: string } | null>(null);
  const [editOrgName, setEditOrgName] = useState('');
  const [savingOrgName, setSavingOrgName] = useState(false);
  const [orgNameError, setOrgNameError] = useState('');
  const [showDeleteOrgConfirm, setShowDeleteOrgConfirm] = useState(false);
  const [deleteOrgConfirmName, setDeleteOrgConfirmName] = useState('');
  const [deletingOrg, setDeletingOrg] = useState(false);
  const [orgImpact, setOrgImpact] = useState<{ project_count: number; member_count: number; has_active_subscription: boolean } | null>(null);
  const [orgImpactLoading, setOrgImpactLoading] = useState(false);
  // story #2092(P0) — orgImpact===null 하나로는 "아직 안 물었다"와 "물었는데 실패했다"를
  // 구분 못 해, 조회 실패가 곧 "영향도 없음"인 것처럼 버튼을 열어줬다(has_active_subscription
  // 기본값 false가 실패 케이스에도 그대로 적용). 이 플래그로 실패 상태를 명시적으로 갈라
  // 삭제 진행을 1차로 막는다(AC2) — 서버 거부(#2898, 이미 배포됨)가 최종 방어선이지만
  // 화면도 "안내이지 방어가 아니다"에서 "안내"쪽은 최소한 정확해야 한다.
  const [orgImpactFailed, setOrgImpactFailed] = useState(false);
  // AC3 탈출구 — 조회 실패가 계속될 때만 의미를 갖는 명시적 인정 체크. 재조회가 성공하면
  // (fetchOrgImpact 재호출) 무의미해지므로 그때마다 초기화한다.
  const [confirmWithoutImpact, setConfirmWithoutImpact] = useState(false);
  const [projectMemberships] = useState<Array<{ projectId: string; projectName: string }>>([]);
  const [settings, setSettings] = useState<NotificationSetting[]>([]);
  // story #2272 — 알림 설정(형제: 이벤트타입별 채널토글, 위 settings)과 같은 자리에 선다.
  // scope_type='global'·channel='in_app' 조합의 level(all/mentions/mute) — 기본 알림 레벨.
  const [globalPreferenceLevel, setGlobalPreferenceLevel] = useState<'all' | 'mentions' | 'mute'>('all');
  const [savingPreferenceLevel, setSavingPreferenceLevel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [createdProjectMembership, setCreatedProjectMembership] = useState<{ projectId: string; projectName: string } | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectActionMessage, setProjectActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editProjectName, setEditProjectName] = useState('');
  const [editProjectDescription, setEditProjectDescription] = useState('');
  const [savingProject, setSavingProject] = useState(false);
  const [memberProjectId, setMemberProjectId] = useState('');
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  // story #4311 — 휴먼 웹훅 줄은 이름만 보이니 같은 이름 구성원이 갈리게 memberRowLabels(member-display 한 곳의 꼬리 규칙)로.
  const webhookRowLabels = useMemo(() => memberRowLabels(projectMembers.filter((m) => m.type === 'human'), tc, () => ''), [projectMembers, tc]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminChecked, setAdminChecked] = useState(false);
  const [currentProjectRole, setCurrentProjectRole] = useState<string>('member'); // S-GATE-4: 현재 프로젝트 effective role
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deleteProjectConfirmId, setDeleteProjectConfirmId] = useState<string | null>(null);

  const [addMemberOpen, setAddMemberOpen] = useState(false); // 7363ec8a: 통합 "+멤버 추가" 모달
  const [webhookEditing, setWebhookEditing] = useState<Record<string, string>>({});
  const [webhookSaving, setWebhookSaving] = useState<string | null>(null);
  const [webhookErrors, setWebhookErrors] = useState<Record<string, string>>({});

  // DashboardCtx에서 현재 org의 role을 derive — fetch 완료 전에도 올바른 role 반영
  const ctxRole = orgMemberships.find(o => o.orgId === (orgId ?? ctxOrgId))?.role;
  const currentOrgRole = (orgInfo?.role ?? ctxRole ?? 'member') as string;

  // story #2092(P0) — 삭제 다이얼로그를 열 때·재시도할 때 공통으로 쓰는 영향도 조회.
  // 실패(네트워크 에러든 non-2xx든)를 orgImpactFailed로 명시 구분 — orgImpact===null은
  // 더 이상 "실패"의 대리 신호가 아니다(위 상태 선언 주석 참고).
  const fetchOrgImpact = async () => {
    if (!orgInfo) return;
    setOrgImpactLoading(true);
    setOrgImpactFailed(false);
    setConfirmWithoutImpact(false);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgInfo.id}/impact`).catch(() => null);
      if (!res?.ok) {
        setOrgImpact(null);
        setOrgImpactFailed(true);
        return;
      }
      const json = await res.json() as { data?: { project_count: number; member_count: number; has_active_subscription: boolean } };
      if (!json.data) {
        setOrgImpact(null);
        setOrgImpactFailed(true);
        return;
      }
      setOrgImpact(json.data);
    } finally {
      setOrgImpactLoading(false);
    }
  };

  const handleOpenDeleteOrg = async () => {
    if (!orgInfo) return;
    setShowDeleteOrgConfirm(true);
    setDeleteOrgConfirmName('');
    setOrgImpact(null);
    setOrgImpactFailed(false);
    setConfirmWithoutImpact(false);
    await fetchOrgImpact();
  };

  const handleDeleteOrg = async () => {
    if (!orgInfo) return;
    if (!canSubmitOrgDelete({
      orgName: orgInfo.name,
      confirmName: deleteOrgConfirmName,
      deletingOrg,
      orgImpactLoading,
      hasActiveSubscription: orgImpact?.has_active_subscription ?? false,
      orgImpactFailed,
      confirmWithoutImpact,
    })) return;
    setDeletingOrg(true);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgInfo.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        // story #2092 AC3 — 영향도 조회가 실패한 채로 사용자가 명시 인정했을 때만 true.
        // 서버(#2898)가 이 신호와 무관하게 자체 재조회로 최종 판정한다 — 이 필드는
        // "재조회도 실패하면 그때 이 인정을 참고하라"는 사용자 신호일 뿐, 화면이 서버를
        // 대신 판정하지 않는다.
        body: JSON.stringify({
          confirmation: orgInfo.name,
          confirm_without_impact: orgImpactFailed && confirmWithoutImpact,
        }),
      });
      if (res.ok) {
        // story 4763 (H6): say so on the other side — the onboarding no longer makes a same-named organization behind the person's back
        window.location.href = ORG_DELETED_LANDING;
      } else {
        // story #2485 — backend delete_organization()은 generic HTTP상태 코드만
        // 낸다(진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
        addToast({ type: 'error', title: t('orgDeleteFailed') });
        setShowDeleteOrgConfirm(false);
      }
    } finally {
      setDeletingOrg(false);
    }
  };

  const handleSaveOrgName = async () => {
    if (!orgInfo || !editOrgName.trim() || savingOrgName) return;
    setSavingOrgName(true);
    setOrgNameError('');
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgInfo.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editOrgName.trim() }),
      });
      const json = await res.json() as { data?: { name: string }; error?: { message?: string } };
      if (!res.ok) {
        // story #2485 — backend update_organization()은 generic HTTP상태 코드만
        // 낸다(진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 제거.
        setOrgNameError(t('orgNameSaveFailed'));
      } else {
        setOrgInfo((prev) => prev ? { ...prev, name: json.data?.name ?? editOrgName.trim() } : prev);
        addToast({ type: 'success', title: t('orgNameSaved') });
      }
    } finally {
      setSavingOrgName(false);
    }
  };

  const refreshProjects = async () => {
    const endpoint = orgId ? `/api/projects?org_id=${encodeURIComponent(orgId)}` : '/api/projects';
    const res = await fetch(endpoint);
    if (!res.ok) return;

    const json = await res.json();
    if (!json?.data) return;

    const nextProjects = (json.data as ProjectOption[]).slice().sort((a, b) => a.name.localeCompare(b.name));
    setProjects(nextProjects);
    setMemberProjectId((current) => current || currentProjectId || nextProjects[0]?.id || '');
  };

  const refreshMemberData = async (projectId: string) => {
    if (!projectId) return;

    const projectMemberRes = await fetchWithAuth(`/api/team-members?project_id=${projectId}`);

    if (projectMemberRes.ok) {
      const json = await projectMemberRes.json();
      setProjectMembers((json.data ?? []) as ProjectMember[]);
    }
  };

  // Fetch org and project context
  useEffect(() => {
    async function loadContext() {
      // admin 감지: /api/me role 기반 (invitations 응답 결과에 의존하지 않음)
      try {
        const meRes = await fetchMe();
        const meJson = meRes.ok ? await meRes.json() : null;
        const role = (meJson?.data?.role ?? 'member') as string;
        setIsAdmin(role === 'admin' || role === 'owner');
        setCurrentUserId((meJson?.data?.user_id as string | null) ?? null);
      } catch {
        setIsAdmin(false);
      } finally {
        setAdminChecked(true);
      }

      // Get current project — current-project 실패/예외와 무관하게 loading은 finally에서 해소(무한 스켈레톤 방지).
      // (fresh signup 직후 org_id 없는 JWT → /current-project 실패 시 setLoading(false) 미호출되던 결함)
      try {
        const projectRes = await fetchWithAuth('/api/current-project');
        if (projectRes.ok) {
          const projectJson = await projectRes.json();
          const projectId = projectJson?.data?.project_id ?? null;
          const orgId = projectJson?.data?.org_id ?? null;
          setCurrentProjectId(projectId);
          setOrgId(orgId);

          // org 상세 정보 로드 — list API에서 orgId로 필터 (단건 API 미구현)
          if (orgId) {
            const orgListRes = await fetchWithAuth('/api/organizations').catch(() => null);
            if (orgListRes?.ok) {
              const orgListJson = await orgListRes.json() as { data?: Array<{ id: string; name: string; slug: string; plan?: string; role?: string }> };
              const found = (orgListJson.data ?? []).find((o) => o.id === orgId);
              if (found) {
                setOrgInfo(found);
                setEditOrgName(found.name);
              }
            }
          }

          // Get notification settings
          const settingsRes = await fetchWithAuth('/api/notification-settings');
          if (settingsRes.ok) {
            const settingsJson = await settingsRes.json();
            setSettings(settingsJson.data ?? []);
          }

          // story #2272 — 형제(notification-preferences)의 global·in_app level 조회.
          const preferencesRes = await fetchWithAuth('/api/notification-preferences');
          if (preferencesRes.ok) {
            const preferencesJson = await preferencesRes.json() as { data?: Array<{ scope_type: string; channel: string; level: 'all' | 'mentions' | 'mute' }> };
            const global = (preferencesJson.data ?? []).find((p) => p.scope_type === 'global' && p.channel === 'in_app');
            if (global) setGlobalPreferenceLevel(global.level);
          }

          // Get webhook configs
          const webhookRes = await fetchWithAuth('/api/webhooks/config');
          if (webhookRes.ok) {
            const webhookJson = await webhookRes.json();
            setWebhooks(webhookJson.data ?? []);
          }
        }
      } finally {
        setLoading(false);
      }
    }

    void loadContext().catch((err) => { console.error('설정 컨텍스트 로드 실패', err); });

    void refreshProjects().catch((err) => { console.error('프로젝트 목록 로드 실패', err); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, orgId]);

  // S-GATE-4 RC: 현재 프로젝트의 내 role 을 **그 프로젝트의 team-members**에서 도출(/api/me 는 JWT
  // project_id 기준이라 탭≠JWT 면 부정확). team-members 는 project_id 쿼리 기준·user_id 로 매칭 가능·
  // 멤버 read 가능. project owner 면 gate-config 편집 허용에 사용(canEdit).
  useEffect(() => {
    if (!currentProjectId || !currentUserId) { setCurrentProjectRole('member'); return; }
    let cancelled = false;
    void (async () => {
      const res = await fetchWithAuth(`/api/team-members?project_id=${currentProjectId}&type=human`).catch(() => null);
      if (cancelled || !res?.ok) return;
      const json = await res.json() as { data?: Array<{ user_id?: string | null; role?: string }> };
      const mine = (json.data ?? []).find((m) => m.user_id === currentUserId);
      setCurrentProjectRole(mine?.role ?? 'member');
    })();
    return () => { cancelled = true; };
  }, [currentProjectId, currentUserId]);

  useEffect(() => {
    if (!memberProjectId) return;
    void refreshMemberData(memberProjectId).catch((err) => { console.error('멤버 데이터 로드 실패', err); });
  }, [memberProjectId]);

  // story #4231 3차 · 까디르 QA(ccef5258a [P2]) — 이동 이유는 탭(activeTab)이고 프로젝트는 싣는 값일 뿐이다. flatHref를 deps에 넣으면
  // 프로젝트가 «모름 → A → 대기 B → A»로 바뀌는 동안 이동이 여러 번 나가(Next가 앞 이동을 버리는 경로) — 발사 순간의 최신 값을 ref로 읽는다.
  const flatHrefRef = useRef(flatHref);
  useEffect(() => { flatHrefRef.current = flatHref; }, [flatHref]);

  // api-keys 탭 접근 시 /agents(관리 탭)으로 자동 전환 (레거시 리다이렉트)
  useEffect(() => {
    // 에이전트 관리 IA 통일(story d63d3f73) — Members 서브탭 흡수, /agents(관리 탭)으로 재타겟.
    if (activeTab === 'api-keys') {
      const flatHref = flatHrefRef.current;
      router.push(flatHref('/organization/workforce'));
    }
  }, [activeTab, router]);

  const applySettingOptimistic = (eventType: string, newEnabled: boolean) => {
    setSettings((prev) => {
      const existing = prev.find((s) => s.event_type === eventType && s.channel === 'in_app');
      if (existing) return prev.map((s) => (s.id === existing.id ? { ...s, enabled: newEnabled } : s));
      return [...prev, { id: `temp-${eventType}`, channel: 'in_app', event_type: eventType, enabled: newEnabled }];
    });
  };

  const toggleSetting = async (eventType: string, currentEnabled: boolean) => {
    const newEnabled = !currentEnabled;
    applySettingOptimistic(eventType, newEnabled);
    try {
      const res = await fetch('/api/notification-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'in_app', event_type: eventType, enabled: newEnabled }),
      });
      if (!res.ok) {
        applySettingOptimistic(eventType, currentEnabled);
        addToast({ type: 'error', title: t('notificationSaveError') });
      }
    } catch {
      applySettingOptimistic(eventType, currentEnabled);
      addToast({ type: 'error', title: t('notificationSaveError') });
    }
  };

  // story #2272 AC1 — 왕복 write→read: PUT 응답(DB RETURNING으로 실제 저장된 값)을 그대로
  // 반영한다(낙관적 아님). 형제(toggleSetting)와 달리 낙관적 갱신을 안 쓰는 이유는 이 값이
  // 3-way(all/mentions/mute) 단일 선택이라 실패 시 되돌릴 "이전 값"이 항상 명확해 서버 응답을
  // 기다리는 편이 더 정확하다.
  const handleSetGlobalPreferenceLevel = async (level: 'all' | 'mentions' | 'mute') => {
    if (savingPreferenceLevel || level === globalPreferenceLevel) return;
    setSavingPreferenceLevel(true);
    try {
      const res = await fetch('/api/notification-preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: [{ scope_type: 'global', scope_id: null, channel: 'in_app', level }] }),
      });
      if (res.ok) {
        const json = await res.json() as { data?: Array<{ scope_type: string; channel: string; level: 'all' | 'mentions' | 'mute' }> };
        const saved = (json.data ?? []).find((p) => p.scope_type === 'global' && p.channel === 'in_app');
        if (saved) setGlobalPreferenceLevel(saved.level);
      } else {
        addToast({ type: 'error', title: t('notificationSaveError') });
      }
    } catch {
      addToast({ type: 'error', title: t('notificationSaveError') });
    } finally {
      setSavingPreferenceLevel(false);
    }
  };

  const toggleCategory = async (categoryKey: NotificationCategoryKey, enable: boolean) => {
    const category = NOTIFICATION_CATEGORIES.find((c) => c.key === categoryKey);
    if (!category) return;
    const snapshot = Object.fromEntries(category.types.map((type) => [type, getEnabled(type)]));
    category.types.forEach((type) => applySettingOptimistic(type, enable));
    try {
      const results = await Promise.all(
        category.types.map((type) =>
          fetch('/api/notification-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: 'in_app', event_type: type, enabled: enable }),
          }),
        ),
      );
      if (results.some((r) => !r.ok)) {
        category.types.forEach((type) => applySettingOptimistic(type, snapshot[type] ?? !enable));
        addToast({ type: 'error', title: t('notificationSaveError') });
      }
    } catch {
      category.types.forEach((type) => applySettingOptimistic(type, snapshot[type] ?? !enable));
      addToast({ type: 'error', title: t('notificationSaveError') });
    }
  };

  const getEnabled = (eventType: string) => {
    const setting = settings.find((s) => s.event_type === eventType && s.channel === 'in_app');
    return setting?.enabled ?? true;
  };

  const isCategoryAllEnabled = (categoryKey: NotificationCategoryKey) => {
    const category = NOTIFICATION_CATEGORIES.find((c) => c.key === categoryKey);
    if (!category) return false;
    return category.types.every((type) => getEnabled(type));
  };

  const handleUpdateProject = async () => {
    if (!editingProjectId || !editProjectName.trim()) return;
    setSavingProject(true);
    const res = await fetch(`/api/projects/${editingProjectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editProjectName.trim(), description: editProjectDescription.trim() || null }),
    });
    if (res.ok) {
      const json = await res.json();
      setProjects((prev) => prev.map((p) => p.id === editingProjectId ? { ...p, name: json.data.name, description: json.data.description } : p));
      setEditingProjectId(null);
      setProjectActionMessage({ type: 'success', text: t('projectUpdated') });
      router.refresh();
    } else {
      // story #2485 — backend update_project()는 슬러그형식(400→BAD_REQUEST)·중복
      // (409→CONFLICT) plain-string 에러를 낸다(dict-coded 아니라 진짜 business code는
      // 없음, generic HTTP상태 매핑만). story #2488 전엔 packages/storage-api의
      // mapApiError가 404/403 외 전부 뭉개 이 code 자체가 여기 도달 못 했다 — 그 pipe를
      // #2488이 고쳐 이제 실분기 가능(#2489, 이 story가 그 follow-up).
      const json = await res.json().catch(() => null) as { error?: { code?: string } } | null;
      if (json?.error?.code === 'CONFLICT') {
        setProjectActionMessage({ type: 'error', text: t('projectSlugTaken') });
      } else if (json?.error?.code === 'BAD_REQUEST') {
        setProjectActionMessage({ type: 'error', text: t('projectSlugInvalid') });
      } else {
        setProjectActionMessage({ type: 'error', text: t('projectUpdateFailed') });
      }
    }
    setSavingProject(false);
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    if (!orgId) {
      setProjectActionMessage({ type: 'error', text: t('projectCreateOrgMissing') });
      return;
    }

    setCreatingProject(true);
    setProjectActionMessage(null);

    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: orgId,
        name: newProjectName.trim(),
        description: newProjectDescription.trim() || null,
      }),
    });

    const json = await res.json().catch(() => null) as {
      data?: ProjectOption;
      error?: { code?: string; message?: string; limit?: number };
    } | null;

    if (!res.ok) {
      // story #2485 — EE plan_limits.check_project_create_limit()이 실제로 이 code를
      // 낸다(verbatim proxy — mapApiError 경유 아님, 그라운딩 확認). 그 외 code는
      // backend가 generic HTTP상태만 준다 — raw 서버 message 노출 대신 고정 문구.
      setProjectActionMessage({
        type: 'error',
        text: json?.error?.code === 'PLAN_LIMIT_EXCEEDED'
          ? tOnboarding('projectLimitExceededError', { limit: json.error.limit ?? 1 })
          : t('projectCreateFailed'),
      });
      setCreatingProject(false);
      return;
    }

    const project = json?.data as ProjectOption | null;
    if (!project) {
      setProjectActionMessage({ type: 'error', text: t('projectCreateFailed') });
      setCreatingProject(false);
      return;
    }

    setCreatedProjectMembership({ projectId: project.id, projectName: project.name });
    setProjects((prev) => {
      const next = prev.some((item) => item.id === project.id) ? prev : [...prev, project];
      return next.slice().sort((a, b) => a.name.localeCompare(b.name));
    });
    setMemberProjectId(project.id);
    setNewProjectName('');
    setNewProjectDescription('');
    setProjectActionMessage({ type: 'success', text: t('projectCreated', { name: project.name }) });

    await refreshProjects().catch((err) => { console.error('프로젝트 생성 후 목록 갱신 실패', err); });
    router.refresh();
    setCreatingProject(false);
    // a WHOLE-PAGE load, not router.push: a client push would supersede the pending router.refresh() above and `/chats?p=<new>` could meet the old (stale) project memberships — and the v3 chat screen reads its
    // project from /api/me, not from `p`. A fresh load re-reads both; this happens once (the first project of a new organization).
    if (returnToChats) window.location.assign(withProjectParam(resolveChatsHref(navV3Flags), project.id));
  };

  const handleDeleteProject = async (projectId: string) => {
    setDeletingProjectId(projectId);
    setProjectActionMessage(null);

    const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    if (res.ok) {
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      setProjectActionMessage({ type: 'success', text: t('projectDeleted') });
      router.refresh();
    } else {
      // story #2485 — backend delete_project()는 generic HTTP상태 코드만 낸다
      // (진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
      setProjectActionMessage({ type: 'error', text: t('projectDeleteFailed') });
    }

    setDeletingProjectId(null);
    setDeleteProjectConfirmId(null);
  };


  const handleSaveWebhookUrl = async (memberId: string) => {
    const url = (webhookEditing[memberId] ?? '').trim();
    if (url && !isWebhookUrlAllowed(url)) {
      setWebhookErrors((prev) => ({ ...prev, [memberId]: t('webhookUrlInvalid') }));
      return;
    }
    setWebhookErrors((prev) => ({ ...prev, [memberId]: '' }));
    setWebhookSaving(memberId);
    try {
      // 1bc9fbae/선생님 webhook-save fix: 휴먼 webhook도 canonical webhook_configs(member_id)에 write.
      // 기존 team_member.webhook_url PATCH는 apply_anchor_update가 agent profile로 오라우팅→휴먼 drop +
      // dispatch가 webhook_configs만 read라 미발송. 에이전트와 동일 store로 통일(persist AND 발송).
      if (!url) {
        // 비우기 = 기존 config DELETE(by id).
        const existing = webhooks.find((w) => w.member_id === memberId);
        if (existing) {
          await fetch(`/api/webhooks/config?id=${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
        }
      } else {
        const res = await fetch('/api/webhooks/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: memberId, url, project_id: currentProjectId, is_active: true }),
        });
        if (!res.ok) {
          // story #2485 — backend upsert_webhook_config()는 generic HTTP상태 코드만
          // 낸다(진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 제거.
          setWebhookErrors((prev) => ({ ...prev, [memberId]: t('webhookSaveFailed') }));
          return;
        }
      }
      setWebhookEditing((prev) => { const next = { ...prev }; delete next[memberId]; return next; });
      // webhook_configs 갱신 — status 배지(is_active) 정합.
      const refresh = await fetch('/api/webhooks/config');
      if (refresh.ok) { const j = await refresh.json() as { data?: WebhookConfig[] }; setWebhooks(j.data ?? []); }
    } catch {
      setWebhookErrors((prev) => ({ ...prev, [memberId]: t('webhookNetworkError') }));
    } finally {
      setWebhookSaving(null);
    }
  };

  const navGroups = settingsNavGroups({ adminChecked, isAdmin, inPhoneApp, supportWidget: isSupportWidgetEnabled(), billing: isEEEnabled() });
  const activeLabelKey = navGroups.flatMap((g) => g.items).find((i) => i.kind === 'tab' && i.id === activeTab)?.labelKey;

  // suppress unused variable warning — createdProjectMembership used in future flows
  void createdProjectMembership;
  void projectMemberships;

  return (
    <>
      {/* story #4130 — 셸이 더 이상 뷰포트 높이 캡을 안 주므로(min-h-0 제거, #4121 픽스) LNB+
          콘텐츠 split(각자 독립 overflow-y-auto)이 자기 높이를 잃는다 — 여기서 직접 앵커
          (h-[calc(100svh-var(--shell-chrome-h))] — story #4131, --shell-chrome-h가 TopBar
          표시 여부+모바일 탭바를 CSS만으로 합성한 SSOT. /settings는 showTopBar=false라
          이 값이 0으로 떨어져 TopBar 몫을 안 뺀다 — #4130의 하드코딩 3rem이 여기서
          48px를 과다 차감하던 것도 같이 해소). */}
      <Tabs value={activeTab} onValueChange={handleTabChange} orientation="vertical" className="h-[calc(100svh-var(--shell-chrome-h))] min-h-0 gap-0">
        {/* story 4891 (UI-8 AC4) — the section list drawn with the ds parts (settings-nav-list.tsx · which sections: settings-nav.ts). ≥lg (1024 — the breakpoint SSOT): always beside the pane. Below it (a phone · a tablet): the list FIRST — the whole screen
            while `lnbOpen` (no `?tab=` on arrival) — and the pane with a back row after a section is picked (it used to be a hamburger over a 208px column squeezed next to the pane) */}
        <div className={`focus-inset shrink-0 overflow-y-auto border-ds-line lg:w-56 lg:border-r ${lnbOpen ? 'flex w-full flex-col' : 'hidden'} lg:flex lg:flex-col`} data-testid="settings-nav-column">
          <h1 className="px-4 pb-2 pt-4 text-ds-title font-semibold text-ds-ink">{t('title')}</h1>
          <SettingsNav groups={navGroups} activeTab={activeTab} integrationsHref={flatHref('/settings/integrations')} />
        </div>

        {/* Right content */}
        <div className={`focus-inset min-w-0 flex-1 overflow-y-auto ${lnbOpen ? 'hidden lg:block' : ''}`} data-testid="settings-pane">
          {/* a phone, after a section is picked: back to the list (a 44px target) + where you are */}
          <div className="flex items-center gap-2 border-b border-ds-line px-2 py-1 lg:hidden" data-testid="settings-back-row">
            <IconButton label={t('backToList')} icon="arrow_back" size="lg" onClick={() => setLnbOpen(true)} />
            <span className="min-w-0 flex-1 truncate text-ds-card-title font-semibold text-ds-ink">{activeLabelKey ? t(activeLabelKey) : t('title')}</span>
          </div>
          {/* the pane's gutter: a phone's 16 (the 24 left a 342 px column on a 390 screen), ≥lg the 24 it had */}
          <div className="mx-auto w-full max-w-3xl p-4 lg:p-6">

            <TabsContent value="profile">
              <div className="space-y-6">
                {profileLoadFailed && (
                  <Banner tone="failed" action={<DsButton onClick={handleProfileTabRetry}>{tc('retry')}</DsButton>}>
                    {t('accountInfoLoadError')}
                  </Banner>
                )}
                {/* story #3772 — key=retryNonce로 넷을 통째 리마운트해 재-fetch(상세페이지
                    key-remount 정본). 섹션 각자의 onLoadError가 처음 하나만 배너를 올리면
                    되므로 중복 호출 무관(idempotent setState). */}
                <div key={profileRetryNonce} className="space-y-6">
                  <MyProfileSection onLoadError={handleProfileSectionLoadError} />
                  <SetPasswordSection onLoadError={handleProfileSectionLoadError} />
                  <LinkedAccountsSection onLoadError={handleProfileSectionLoadError} />
                  <TwoFactorSection onLoadError={handleProfileSectionLoadError} />
                  <OtherSessionsSection />
                </div>
                {currentProjectId && (
                  <MyNotificationChannelSection
                    projectId={currentProjectId}
                    projectName={projects.find((p) => p.id === currentProjectId)?.name ?? currentProjectId}
                  />
                )}
                <BlockedUsersSection />
              </div>
            </TabsContent>

            <TabsContent value="appearance">
              {/* story #4413(유나) — 언어는 테마 바로 아래 · 같은 행 모양(폰에서 언어를 바꿀 유일한 자리). */}
              <div className="space-y-6">
                <ThemeSettings />
                <LanguageSettings />
              </div>
            </TabsContent>

            <TabsContent value="desktop">
              {/* story 4668: the download card (+ the phone app's store links on a device that is not a Mac · 4654) — nothing else */}
              <div className="space-y-6" data-testid="settings-desktop-tab">
                <DesktopDownloadCard />
                <PhoneAppCard />
              </div>
            </TabsContent>

            {inPhoneApp && (
              <TabsContent value="this-phone">
                <div className="space-y-6" data-testid="settings-this-phone-tab">
                  <ThisPhoneCard />
                </div>
              </TabsContent>
            )}

            {isSupportWidgetEnabled() && (
              <TabsContent value="support">
                <SupportSettingsTabPanel />
              </TabsContent>
            )}

            <TabsContent value="api-keys">
              <ApiKeysMovedCard />
            </TabsContent>

            <TabsContent value="notifications">
              <NotificationsPane
                loading={loading}
                categories={NOTIFICATION_CATEGORIES}
                globalLevel={globalPreferenceLevel}
                savingLevel={savingPreferenceLevel}
                onSetLevel={(level) => void handleSetGlobalPreferenceLevel(level)}
                getEnabled={getEnabled}
                onToggle={(eventType, current) => void toggleSetting(eventType, current)}
                isCategoryAllEnabled={(key) => isCategoryAllEnabled(key as NotificationCategoryKey)}
                onToggleCategory={(key, enable) => void toggleCategory(key as NotificationCategoryKey, enable)}
                showSoonColumns={isEEEnabled()}
              />
              {currentProjectId ? (
                <div className="mt-6">
                  <StandupDeadlineSection projectId={currentProjectId} />
                </div>
              ) : null}
              {/* S-GATE-4: 프로젝트 게이트 정책 매트릭스. canEdit = org admin/owner OR **이 프로젝트의 owner**
                  — BE gate_config(PUT/DELETE scope='project')가 project owner 도 허용하므로 정합(RC①). project
                  admin 은 BE 비허용이라 제외(meRole==='owner'만 — over-permission 0). cross-project 인 #1562
                  grant 와 달리 자기 프로젝트 편집이라 보수적 org-admin-only 가 오히려 under-permissive 였음. */}
              {currentProjectId ? (
                <div className="mt-6">
                  <GateLevelMatrix
                    surface="project"
                    projectId={currentProjectId}
                    canEdit={currentOrgRole === 'owner' || currentOrgRole === 'admin' || currentProjectRole === 'owner'}
                  />
                </div>
              ) : null}
              <div className="mt-6">
                {/* story 4891: the same frame as every card of this tab (ds Card + SectionHeader) */}
                <SettingsSection title={t('autoRefresh')} description={t('autoRefreshDescription')}>
                  <RefreshSettings />
                </SettingsSection>
              </div>
            </TabsContent>

            <TabsContent value="organization">
              <div className="space-y-6">
                <OrganizationSection
                  orgInfo={orgInfo}
                  role={currentOrgRole}
                  name={editOrgName}
                  onNameChange={setEditOrgName}
                  onSave={() => void handleSaveOrgName()}
                  saving={savingOrgName}
                  nameError={orgNameError}
                />
                {/* S-GATE-4: 조직 게이트 정책(기본값) surface. #1571 clean org-PUT(/organizations/{id})로
                    org-scoped 설정 — 대표 project 경유 워크어라운드·project-0 엣지 제거. canEdit=org admin/owner. */}
                {orgInfo ? (
                  <GateLevelMatrix
                    surface="org"
                    orgId={orgInfo.id}
                    canEdit={currentOrgRole === 'owner' || currentOrgRole === 'admin'}
                  />
                ) : null}
                {/* story e0c1b24c — org 게이트 정책(posture·머지 게이트 기본 승인자). #3319/PR#3716로
                    백엔드(GET/PUT /api/v2/gate-config/policy)는 착지했으나 값 넣을 화면이 없었다 —
                    GateLevelMatrix(work_type×actor_type 매트릭스, 별개 개념)와 나란히 둔다. */}
                {orgInfo ? <OrgGatePolicySection canEdit={currentOrgRole === 'owner' || currentOrgRole === 'admin'} /> : null}
                {currentOrgRole === 'owner' && <OrgDangerSection onOpenDelete={() => void handleOpenDeleteOrg()} />}
              </div>
            </TabsContent>

            <TabsContent value="org-members">
              {orgId && orgInfo ? (
                <OrgMembersSection orgId={orgId} currentRole={currentOrgRole} />
              ) : (
                <SkeletonGroup label={tc('loading')} className="space-y-3">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}
                </SkeletonGroup>
              )}
            </TabsContent>

            <TabsContent value="projects">
              <ProjectsSection
                projects={projects}
                currentProjectId={currentProjectId}
                isAdmin={isAdmin}
                editingId={editingProjectId}
                editName={editProjectName}
                editDescription={editProjectDescription}
                saving={savingProject}
                onEditStart={(project) => {
                  setEditingProjectId(project.id);
                  setEditProjectName(project.name);
                  setEditProjectDescription(project.description ?? '');
                }}
                onEditName={setEditProjectName}
                onEditDescription={setEditProjectDescription}
                onEditSave={() => void handleUpdateProject()}
                onEditCancel={() => setEditingProjectId(null)}
                deletingId={deletingProjectId}
                onDeleteAsk={setDeleteProjectConfirmId}
                message={projectActionMessage}
                newName={newProjectName}
                newDescription={newProjectDescription}
                creating={creatingProject}
                onNewName={setNewProjectName}
                onNewDescription={setNewProjectDescription}
                onCreate={() => void handleCreateProject()}
              />
            </TabsContent>

            <TabsContent value="members">
              {/* 에이전트 관리 IA 통일(story d63d3f73) — Members는 People 전용, 서브탭 제거.
                  에이전트 목록·추가·상세는 `/agents`(관리 탭)로 흡수. */}
              <div className="mb-6 flex items-center justify-between gap-3">
                <h2 className="text-ds-card-title font-semibold text-ds-ink">{t('membersTabPeople')}</h2>
                {isAdmin ? (
                  <DsButton variant="primary" className="shrink-0 gap-1.5" onClick={() => setAddMemberOpen(true)}>
                    <Plus className="size-3.5" /> {t('addMember')}
                  </DsButton>
                ) : null}
              </div>

              <div>
                {currentProjectId ? (
                  <div className="space-y-6">
                    <ProjectAccessSection
                      projectId={currentProjectId}
                    />
                    {/* 7519c3ea: 팀원 webhook inline — flat 탭 폐기분을 멤버별 surface(handleSaveWebhookUrl 재사용·status 한눈에). */}
                    <MemberWebhooksSection
                      members={projectMembers.filter((m) => m.type === 'human')}
                      webhooks={webhooks}
                      editing={webhookEditing}
                      errors={webhookErrors}
                      savingId={webhookSaving}
                      rowLabels={webhookRowLabels}
                      onEdit={(memberId, value) => setWebhookEditing((prev) => ({ ...prev, [memberId]: value }))}
                      onSave={(memberId) => void handleSaveWebhookUrl(memberId)}
                    />
                  </div>
                ) : (
                  <p className="text-ds-body text-ds-ink-3">{t('noProject')}</p>
                )}
              </div>
            </TabsContent>


            {/* E-SETTINGS-IA S2: deprecate 숨김. set 확장으로 trigger·content·딥링크(resolveSettingsTab) 일괄 차단. 컴포넌트 보존. */}
            {adminChecked && isAdmin && !HIDDEN_SETTINGS_TABS.has('workflow') ? (
            <TabsContent value="workflow">
              <div className="space-y-6">
                <WorkflowTriggerTypesSection />
                {currentProjectId ? <WorkflowTemplateGallerySection projectId={currentProjectId} orgId={orgId ?? undefined} /> : null}
                {currentProjectId ? <RecurringRecipesSection projectId={currentProjectId} /> : null}
                {currentProjectId ? <WorkflowExecutionHistorySection projectId={currentProjectId} /> : null}
              </div>
            </TabsContent>
            ) : null}

            {adminChecked && isAdmin ? (
            <TabsContent value="workflow-policies">
              <SettingsSection title={t('tabWorkflowPolicies')} description={t('workflowPoliciesDescription')} id="workflow-policies">
                {/* S34: 4모드(View[S29 active+simulator]/Edit/History/Diff) 라인 에디터 — View 내부에 기존 2-pane 포함 */}
                <WorkflowLineEditorSection projectId={currentProjectId} />
              </SettingsSection>
            </TabsContent>
            ) : null}

            {adminChecked && isAdmin && orgId ? (
              <TabsContent value="usage">
                <UsageDashboard
                  orgId={orgId}
                  currentProjectId={currentProjectId}
                  projects={projects}
                  defaultMonth={new Date().toISOString().slice(0, 7)}
                />
              </TabsContent>
            ) : null}

            {isEEEnabled() && BillingTab && orgId && (
              <TabsContent value="billing">
                <BillingTab orgId={orgId} />
              </TabsContent>
            )}

            <TabsContent value="danger">
              <AccountDangerSection onOpenDelete={() => setShowDeleteConfirm(true)} />
            </TabsContent>

            {/* 설정 전역 법적 고지 푸터 — 활성 탭 무관 상시 노출 (story #2865) */}
            <div className="mt-8 border-t border-ds-line pt-6" data-testid="settings-legal-footer">
              <h2 className="mb-3 text-ds-small font-semibold text-ds-ink">{tLegal('policiesHeading')}</h2>
              <LegalLinks className="justify-start text-ds-body text-ds-ink-3" />
              <div className="mt-4 border-t border-ds-line pt-4">
                <p className="mb-1.5 text-ds-small font-semibold text-ds-ink-3">{tLegal('businessInfoHeading')}</p>
                <BusinessInfoBlock className="justify-start text-ds-small text-ds-ink-3" />
              </div>
            </div>
          </div>
        </div>
      </Tabs>

      {showDeleteOrgConfirm && orgInfo ? (
        <OrgDeleteDialog
          orgName={orgInfo.name}
          impact={orgImpact}
          impactLoading={orgImpactLoading}
          confirmName={deleteOrgConfirmName}
          onConfirmName={setDeleteOrgConfirmName}
          confirmWithoutImpact={confirmWithoutImpact}
          onConfirmWithoutImpact={setConfirmWithoutImpact}
          deleting={deletingOrg}
          canSubmit={canSubmitOrgDelete({
            orgName: orgInfo.name,
            confirmName: deleteOrgConfirmName,
            deletingOrg,
            orgImpactLoading,
            hasActiveSubscription: orgImpact?.has_active_subscription ?? false,
            orgImpactFailed,
            confirmWithoutImpact,
          })}
          onRetryImpact={() => void fetchOrgImpact()}
          onClose={() => { setShowDeleteOrgConfirm(false); setDeleteOrgConfirmName(''); }}
          onConfirm={() => void handleDeleteOrg()}
        />
      ) : null}

      {showDeleteConfirm ? <DeleteAccountDialog onClose={() => setShowDeleteConfirm(false)} onDeleted={() => router.push('/login')} /> : null}

      {deleteProjectConfirmId ? (
        <ProjectDeleteDialog
          deleting={deletingProjectId === deleteProjectConfirmId}
          onClose={() => setDeleteProjectConfirmId(null)}
          onConfirm={() => void handleDeleteProject(deleteProjectConfirmId)}
        />
      ) : null}
      {orgId ? (
        <AddMemberModal
          open={addMemberOpen}
          onClose={() => setAddMemberOpen(false)}
          orgId={orgId}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          onAdded={(message) => {
            addToast({ type: 'success', title: message });
          }}
        />
      ) : null}
    </>
  );
}
