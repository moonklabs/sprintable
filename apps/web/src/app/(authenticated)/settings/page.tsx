'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BarChart2, Bell, Bot, Check, CheckCircle2, CreditCard, FolderKanban, GitBranch, Menu, Palette, Plus, Trash2, User, Users, Webhook, X } from 'lucide-react';
import { UsageDashboard } from '@/components/settings/usage-dashboard';
import { OrgMembersSection } from '@/components/settings/org-members-section';
import { AddMemberModal } from '@/components/settings/add-member-modal';
import { ProjectAccessSection } from '@/components/settings/project-access-section';

import { AiSettingsSection } from '@/components/settings/ai-settings';
import { MyProfileSection } from '@/components/settings/my-profile-section';
import { MyNotificationChannelSection } from '@/components/settings/my-notification-channel-section';
import { ByomKeyManagement } from '@/components/settings/byom-key-management';
import { McpConnectionSettings } from '@/components/settings/mcp-connection-settings';
import { WorkflowTriggerTypesSection } from '@/components/settings/workflow-trigger-types-section';
import { WorkflowExecutionHistorySection } from '@/components/settings/workflow-execution-history-section';
import { WorkflowTemplateGallerySection } from '@/components/settings/workflow-template-gallery-section';
import { ThemeSettings } from '@/components/settings/theme-settings';
import { RefreshSettings } from '@/components/settings/refresh-settings';
import { StandupDeadlineSection } from '@/components/settings/standup-deadline-section';
import { GateLevelMatrix } from '@/components/settings/gate-level-matrix';
import { TwoFactorSection } from '@/components/settings/two-factor-section';
import { SetPasswordSection } from '@/components/settings/set-password-section';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { MemberRow } from '@/components/ui/member-row';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { NOTIFICATION_TYPES } from '@/lib/notification-types';
import { isEEEnabled } from '@/lib/ee';
import dynamic from 'next/dynamic';

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

interface InvitationItem {
  id: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked';
  accepted_at: string | null;
  expires_at: string;
  project_id: string | null;
  projects: { id: string; name: string } | null;
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

interface NewAgentResult {
  name: string;
  fakechat_port: number | null;
  mcp_config: Record<string, unknown> | null;
  api_key: string | null;
}

const NOTIFICATION_CATEGORIES = [

  { key: 'story', types: ['story', 'story_assigned'] },
  { key: 'task', types: ['task', 'task_assigned', 'task_completed'] },
  { key: 'sprint', types: ['sprint_closed'] },
  { key: 'system', types: ['info', 'warning', 'system', 'standup_reminder', 'reward', 'invitation'] },
] as const satisfies ReadonlyArray<{ key: string; types: ReadonlyArray<(typeof NOTIFICATION_TYPES)[number]> }>;

type NotificationCategoryKey = typeof NOTIFICATION_CATEGORIES[number]['key'];

function isWebhookUrlAllowed(url: string): boolean {
  if (!url) return true;
  if (/^https:\/\//i.test(url)) return true;
  return /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/i.test(url);
}

// E-SETTINGS-IA: deprecate(숨김)된 settings 탭. 컴포넌트/route는 보존(reversible) —
// 탭 트리거·콘텐츠·딥링크(?tab=)만 차단한다. 재노출 시 이 set에서 제거만 하면 IA 위치 복원.
const HIDDEN_SETTINGS_TABS = new Set<string>(['ai', 'workflow']);
const DEFAULT_SETTINGS_TAB = 'profile';

// ?tab= 딥링크가 숨김 탭을 가리키면 기본 탭으로 폴백 (빈 화면 방지).
function resolveSettingsTab(tab: string | null): string {
  if (!tab || HIDDEN_SETTINGS_TABS.has(tab)) return DEFAULT_SETTINGS_TAB;
  return tab;
}

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const router = useRouter();
  const searchParamsHook = useSearchParams();
  const { orgId: ctxOrgId, orgMemberships } = useDashboardContext();
  const [activeTab, setActiveTab] = useState(() => resolveSettingsTab(searchParamsHook.get('tab')));
  const [lnbOpen, setLnbOpen] = useState(false);
  const { toasts, addToast, dismissToast } = useToast();

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    setLnbOpen(false); // 모바일에서 탭 선택 시 LNB 자동 접기
  };

  useEffect(() => {
    const tab = searchParamsHook.get('tab');
    if (tab) setActiveTab(resolveSettingsTab(tab));
  }, [searchParamsHook]);

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
  const [projectMemberships] = useState<Array<{ projectId: string; projectName: string }>>([]);
  const [settings, setSettings] = useState<NotificationSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);
  const [inviteProjectId, setInviteProjectId] = useState('');
  const [memberProjectId, setMemberProjectId] = useState('');
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [orgMembers, setOrgMembers] = useState<ProjectMember[]>([]);
  const [selectedOrgMemberUserId, setSelectedOrgMemberUserId] = useState('');
  const [memberActionMessage, setMemberActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [addingMember, setAddingMember] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminChecked, setAdminChecked] = useState(false);
  const [currentProjectRole, setCurrentProjectRole] = useState<string>('member'); // S-GATE-4: 현재 프로젝트 effective role
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deleteProjectConfirmId, setDeleteProjectConfirmId] = useState<string | null>(null);

  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null);
  const [resendResult, setResendResult] = useState<{ id: string; url: string } | null>(null);
  const [graceUntil, setGraceUntil] = useState<string | null>(null);
  const [membersSubTab, setMembersSubTab] = useState<'people' | 'agents'>('people');
  const [addMemberOpen, setAddMemberOpen] = useState(false); // 7363ec8a: 통합 "+멤버 추가" 모달
  const [orgAgents, setOrgAgents] = useState<ProjectMember[]>([]);
  const [newAgentName, setNewAgentName] = useState('');
  // org-agent S5: 단일 project_id → scope 인지(전체/특정) 멀티프로젝트 생성으로 업그레이드.
  const [newAgentRole, setNewAgentRole] = useState<'member' | 'admin'>('member');
  const [newAgentScopeMode, setNewAgentScopeMode] = useState<'org' | 'projects'>('projects');
  const [newAgentProjectIds, setNewAgentProjectIds] = useState<string[]>([]);
  const [addingAgent, setAddingAgent] = useState(false);
  const [deactivatingAgentId, setDeactivatingAgentId] = useState<string | null>(null);
  const [agentActionMessage, setAgentActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newAgentResult, setNewAgentResult] = useState<NewAgentResult | null>(null);
  const [newAgentMcpCopied, setNewAgentMcpCopied] = useState(false);
  const [webhookEditing, setWebhookEditing] = useState<Record<string, string>>({});
  const [webhookSaving, setWebhookSaving] = useState<string | null>(null);
  const [webhookErrors, setWebhookErrors] = useState<Record<string, string>>({});

  // DashboardCtx에서 현재 org의 role을 derive — fetch 완료 전에도 올바른 role 반영
  const ctxRole = orgMemberships.find(o => o.orgId === (orgId ?? ctxOrgId))?.role;
  const currentOrgRole = (orgInfo?.role ?? ctxRole ?? 'member') as string;

  const handleOpenDeleteOrg = async () => {
    if (!orgInfo) return;
    setShowDeleteOrgConfirm(true);
    setDeleteOrgConfirmName('');
    setOrgImpact(null);
    setOrgImpactLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgInfo.id}/impact`).catch(() => null);
      if (res?.ok) {
        const json = await res.json() as { data?: { project_count: number; member_count: number; has_active_subscription: boolean } };
        setOrgImpact(json.data ?? null);
      }
    } finally {
      setOrgImpactLoading(false);
    }
  };

  const handleDeleteOrg = async () => {
    if (!orgInfo || deleteOrgConfirmName !== orgInfo.name || deletingOrg) return;
    setDeletingOrg(true);
    try {
      const res = await fetch(`/api/organizations/${orgInfo.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: orgInfo.name }),
      });
      if (res.ok) {
        window.location.href = '/onboarding';
      } else {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? 'Organization 삭제에 실패했습니다.' });
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
      const res = await fetch(`/api/organizations/${orgInfo.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editOrgName.trim() }),
      });
      const json = await res.json() as { data?: { name: string }; error?: { message?: string } };
      if (!res.ok) {
        setOrgNameError(json.error?.message ?? t('orgNameSaveFailed'));
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

  const refreshInvitations = async () => {
    if (!orgId) return; // d3619e80: org_invites canonical(레거시 /api/invitations 폐기).
    const res = await fetch(`/api/organizations/${orgId}/invites`);
    if (res.ok) {
      const json = await res.json();
      setInvitations(json.data ?? []);
      const statusRes = await fetch('/api/subscription/status');
      if (statusRes.ok) {
        const statusJson = await statusRes.json() as { data?: { grace_until?: string | null } };
        setGraceUntil(statusJson.data?.grace_until ?? null);
      }
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    if (!orgId) return;
    setRevokingInviteId(inviteId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invites/${inviteId}`, { method: 'DELETE' });
      if (res.ok) await refreshInvitations();
    } finally {
      setRevokingInviteId(null);
    }
  };

  const handleResendInvite = async (inviteId: string) => {
    if (!orgId) return;
    setResendingInviteId(inviteId);
    setResendResult(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invites/${inviteId}/resend`, { method: 'POST' });
      if (res.ok) {
        const json = await res.json();
        setResendResult({ id: inviteId, url: json.data?.invite_url ?? '' });
        await refreshInvitations();
      }
    } finally {
      setResendingInviteId(null);
    }
  };

  const refreshOrgAgents = async () => {
    const res = await fetch('/api/team-members?type=agent&include_inactive=true');
    if (!res.ok) return;
    const json = await res.json();
    setOrgAgents((json.data ?? []) as ProjectMember[]);
  };

  const toggleNewAgentProject = (id: string) => {
    setNewAgentProjectIds((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]);
  };

  const handleAddAgent = async () => {
    if (!newAgentName.trim()) return;
    if (newAgentScopeMode === 'projects' && newAgentProjectIds.length === 0) return;
    setAddingAgent(true);
    setAgentActionMessage(null);
    setNewAgentResult(null);
    // org-agent S5: v1 단일프로젝트(/api/team-members) → v2 org-level scope(/api/agents).
    // org_id·인가는 BE 가 verified context 로 해소 → body 미포함. scope_mode='org'면 project_ids 무시.
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newAgentName.trim(),
        role: newAgentRole,
        scope_mode: newAgentScopeMode,
        project_ids: newAgentScopeMode === 'projects' ? newAgentProjectIds : [],
      }),
    });
    if (res.ok) {
      const json = await res.json() as { data?: { fakechat_port?: number | null; mcp_config?: Record<string, unknown> | null; api_key?: string | null } };
      setNewAgentResult({
        name: newAgentName.trim(),
        fakechat_port: json.data?.fakechat_port ?? null,
        mcp_config: json.data?.mcp_config ?? null,
        api_key: json.data?.api_key ?? null,
      });
      setNewAgentName('');
      setNewAgentRole('member');
      setNewAgentScopeMode('projects');
      setNewAgentProjectIds([]);
      await refreshOrgAgents();
    } else {
      const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      setAgentActionMessage({ type: 'error', text: json?.error?.message ?? t('agentActionFailed') });
    }
    setAddingAgent(false);
  };

  const handleCopyNewAgentMcp = async () => {
    if (!newAgentResult?.mcp_config) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(newAgentResult.mcp_config, null, 2));
      setNewAgentMcpCopied(true);
      setTimeout(() => setNewAgentMcpCopied(false), 2000);
    } catch { /* noop */ }
  };

  const handleToggleAgentActive = async (agent: ProjectMember) => {
    setDeactivatingAgentId(agent.id);
    setAgentActionMessage(null);
    const res = await fetch(`/api/team-members/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !agent.is_active }),
    });
    if (res.ok) {
      setAgentActionMessage({ type: 'success', text: agent.is_active ? t('agentDeactivated') : t('agentActivated') });
      await refreshOrgAgents();
    } else {
      const json = await res.json().catch(() => null);
      setAgentActionMessage({ type: 'error', text: json?.error?.message ?? t('agentActionFailed') });
    }
    setDeactivatingAgentId(null);
  };

  const refreshMemberData = async (projectId: string) => {
    if (!projectId) return;

    const [projectMemberRes, orgMemberRes] = await Promise.all([
      fetch(`/api/team-members?project_id=${projectId}`),
      fetch('/api/org-members'),
    ]);

    if (projectMemberRes.ok) {
      const json = await projectMemberRes.json();
      setProjectMembers((json.data ?? []) as ProjectMember[]);
    }

    if (orgMemberRes.ok) {
      const json = await orgMemberRes.json();
      type OrgMemberRow = { id: string; user_id: string; role: string; email?: string; deleted_at?: string | null };
      const mapped: ProjectMember[] = (json.data ?? []).map((row: OrgMemberRow) => ({
        id: row.id,
        name: row.email ?? row.user_id,
        email: row.email,
        type: 'human' as const,
        role: row.role,
        user_id: row.user_id,
        project_id: projectId,
        is_active: !row.deleted_at,
      }));
      setOrgMembers(mapped);
    }
  };

  // Fetch org and project context
  useEffect(() => {
    async function loadContext() {
      // admin 감지: /api/me role 기반 (invitations 응답 결과에 의존하지 않음)
      try {
        const meRes = await fetch('/api/me');
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
        const projectRes = await fetch('/api/current-project');
        if (projectRes.ok) {
          const projectJson = await projectRes.json();
          const projectId = projectJson?.data?.project_id ?? null;
          const orgId = projectJson?.data?.org_id ?? null;
          setCurrentProjectId(projectId);
          setOrgId(orgId);

          // org 상세 정보 로드 — list API에서 orgId로 필터 (단건 API 미구현)
          if (orgId) {
            const orgListRes = await fetch('/api/organizations').catch(() => null);
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
          const settingsRes = await fetch('/api/notification-settings');
          if (settingsRes.ok) {
            const settingsJson = await settingsRes.json();
            setSettings(settingsJson.data ?? []);
          }

          // Get webhook configs
          const webhookRes = await fetch('/api/webhooks/config');
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

    void refreshInvitations().catch((err) => { console.error('초대 목록 로드 실패', err); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, orgId]);

  // S-GATE-4 RC: 현재 프로젝트의 내 role 을 **그 프로젝트의 team-members**에서 도출(/api/me 는 JWT
  // project_id 기준이라 탭≠JWT 면 부정확). team-members 는 project_id 쿼리 기준·user_id 로 매칭 가능·
  // 멤버 read 가능. project owner 면 gate-config 편집 허용에 사용(canEdit).
  useEffect(() => {
    if (!currentProjectId || !currentUserId) { setCurrentProjectRole('member'); return; }
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/team-members?project_id=${currentProjectId}&type=human`).catch(() => null);
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

  useEffect(() => {
    void refreshOrgAgents().catch((err) => { console.error('조직 에이전트 로드 실패', err); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // api-keys 탭 접근 시 Members > Agents로 자동 전환 (레거시 리다이렉트)
  useEffect(() => {
    if (activeTab === 'api-keys') {
      setActiveTab('members');
      setMembersSubTab('agents');
    }
  }, [activeTab]);

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

  const assignableMembers = useMemo(() => {
    const assignedUserIds = new Set(
      projectMembers
        .filter((member) => member.type === 'human' && member.user_id)
        .map((member) => member.user_id as string),
    );

    const deduped = new Map<string, ProjectMember>();
    for (const member of orgMembers) {
      if (member.type !== 'human' || !member.user_id || assignedUserIds.has(member.user_id)) continue;
      if (!deduped.has(member.user_id)) deduped.set(member.user_id, member);
    }

    return Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [orgMembers, projectMembers]);

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
      const json = await res.json().catch(() => null);
      setProjectActionMessage({ type: 'error', text: json?.error?.message ?? t('projectUpdateFailed') });
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

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      setProjectActionMessage({
        type: 'error',
        text: json?.error?.message ?? t('projectCreateFailed'),
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
    setInviteProjectId(project.id);
    setMemberProjectId(project.id);
    setNewProjectName('');
    setNewProjectDescription('');
    setProjectActionMessage({ type: 'success', text: t('projectCreated', { name: project.name }) });

    await refreshProjects().catch((err) => { console.error('프로젝트 생성 후 목록 갱신 실패', err); });
    router.refresh();
    setCreatingProject(false);
  };

  const handleAddProjectMember = async () => {
    if (!memberProjectId || !selectedOrgMemberUserId) return;
    const member = assignableMembers.find((item) => item.user_id === selectedOrgMemberUserId);
    if (!member) return;

    setAddingMember(true);
    setMemberActionMessage(null);

    const res = await fetch('/api/team-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: memberProjectId,
        user_id: selectedOrgMemberUserId,
        type: 'human',
        name: member.name,
        role: member.role ?? 'member',
      }),
    });

    if (res.ok) {
      await refreshMemberData(memberProjectId);
      setSelectedOrgMemberUserId('');
      setMemberActionMessage({ type: 'success', text: t('memberAdded') });
    } else {
      const json = await res.json().catch(() => null);
      setMemberActionMessage({ type: 'error', text: json?.error?.message ?? t('memberActionFailed') });
    }

    setAddingMember(false);
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
      const json = await res.json().catch(() => null);
      setProjectActionMessage({ type: 'error', text: json?.error?.message ?? t('projectDeleteFailed') });
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
          const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
          setWebhookErrors((prev) => ({ ...prev, [memberId]: json.error?.message ?? 'Webhook URL 저장 실패' }));
          return;
        }
      }
      setWebhookEditing((prev) => { const next = { ...prev }; delete next[memberId]; return next; });
      // webhook_configs 갱신 — status 배지(is_active) 정합.
      const refresh = await fetch('/api/webhooks/config');
      if (refresh.ok) { const j = await refresh.json() as { data?: WebhookConfig[] }; setWebhooks(j.data ?? []); }
    } catch {
      setWebhookErrors((prev) => ({ ...prev, [memberId]: '네트워크 오류 — 다시 시도하세요.' }));
    } finally {
      setWebhookSaving(null);
    }
  };

  const handleRemoveProjectMember = async (memberId: string) => {
    setRemovingMemberId(memberId);
    setMemberActionMessage(null);

    const res = await fetch(`/api/team-members/${memberId}`, { method: 'DELETE' });
    if (res.ok) {
      await refreshMemberData(memberProjectId);
      setMemberActionMessage({ type: 'success', text: t('memberRemoved') });
    } else {
      const json = await res.json().catch(() => null);
      const errorCode = json?.error?.code;
      setMemberActionMessage({
        type: 'error',
        text: errorCode === 'LAST_PROJECT_MEMBERSHIP' ? t('lastProjectMembership') : json?.error?.message ?? t('memberActionFailed'),
      });
    }

    setRemovingMemberId(null);
  };

  // suppress unused variable warning — createdProjectMembership used in future flows
  void createdProjectMembership;
  void projectMemberships;

  return (
    <>
      <Tabs value={activeTab} onValueChange={handleTabChange} orientation="vertical" className="flex-1 min-h-0 gap-0">
        {/* Left nav: desktop=always visible, mobile=toggle via lnbOpen */}
        <div className={`shrink-0 border-r overflow-y-auto p-4 flex-col w-52 ${lnbOpen ? 'flex' : 'hidden'} lg:flex`}>
          <h1 className="mb-4 px-2 text-sm font-semibold">{t('title')}</h1>
          <TabsList variant="line" className="w-full flex-col items-stretch">
            <span className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{t('myAccount')}</span>
            <TabsTrigger value="profile">
              <User className="h-4 w-4" />
              {t('tabProfile')}
            </TabsTrigger>
            <TabsTrigger value="appearance">
              <Palette className="h-4 w-4" />
              {t('tabAppearance')}
            </TabsTrigger>
            <TabsTrigger value="notifications">
              <Bell className="h-4 w-4" />
              {t('tabNotifications')}
            </TabsTrigger>

            <span className="px-2 pb-1 pt-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{t('projectSettings')}</span>
            {currentProjectId && !HIDDEN_SETTINGS_TABS.has('ai') ? (
              <TabsTrigger value="ai">
                <Bot className="h-4 w-4" />
                {t('tabAiAgents')}
              </TabsTrigger>
            ) : null}
            {adminChecked ? (
              <TabsTrigger value="members">
                <Users className="h-4 w-4" />
                {t('tabMembers')}
              </TabsTrigger>
            ) : null}
            {adminChecked && isAdmin && !HIDDEN_SETTINGS_TABS.has('workflow') ? (
              <TabsTrigger value="workflow">
                <GitBranch className="h-4 w-4" />
                {t('tabWorkflow')}
              </TabsTrigger>
            ) : null}

            {adminChecked ? (
              <>
                <span className="truncate px-2 pb-1 pt-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{t('organizationSettings')}</span>
                <TabsTrigger value="organization">
                  <FolderKanban className="h-4 w-4" />
                  {t('tabOrganization')}
                </TabsTrigger>
                <TabsTrigger value="org-members">
                  <Users className="h-4 w-4" />
                  {t('tabOrgMembers')}
                </TabsTrigger>
                <TabsTrigger value="projects">
                  <FolderKanban className="h-4 w-4" />
                  {t('tabProjects')}
                </TabsTrigger>
                {/* 7519c3ea: flat webhooks 탭 폐기 — webhook은 멤버/에이전트 관리(members)에 inline 통합. */}
              </>
            ) : null}

            {adminChecked && isAdmin ? (
              <>
                <span className="truncate px-2 pb-1 pt-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{t('billing')}</span>
                {isEEEnabled() && (
                  <TabsTrigger value="subscription">
                    <CreditCard className="h-4 w-4" />
                    {t('tabSubscription')}
                  </TabsTrigger>
                )}
                {isEEEnabled() && (
                  <TabsTrigger value="billing">
                    <CreditCard className="h-4 w-4" />
                    {t('tabBilling')}
                  </TabsTrigger>
                )}
                <TabsTrigger value="usage">
                  <BarChart2 className="h-4 w-4" />
                  {t('tabUsage')}
                </TabsTrigger>
              </>
            ) : null}

            <span className="px-2 pb-1 pt-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{t('dangerZone')}</span>
            <TabsTrigger
              value="danger"
              className="text-destructive hover:text-destructive data-active:text-destructive data-active:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" />
              {t('deleteAccount')}
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Right content */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {/* Mobile toggle button */}
          <div className="lg:hidden flex items-center gap-2 border-b px-4 py-2">
            <SidebarTrigger className="mr-1" />
            <button
              type="button"
              onClick={() => setLnbOpen((v) => !v)}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Toggle navigation"
            >
              {lnbOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <span className="text-sm font-medium">{t('title')}</span>
          </div>
          <div className="w-full max-w-3xl mx-auto p-6">

            <TabsContent value="profile">
              <div className="space-y-6">
                <MyProfileSection />
                <SetPasswordSection />
                <TwoFactorSection />
                {currentProjectId && (
                  <MyNotificationChannelSection
                    projectId={currentProjectId}
                    projectName={projects.find((p) => p.id === currentProjectId)?.name ?? currentProjectId}
                  />
                )}
              </div>
            </TabsContent>

            <TabsContent value="appearance">
              <ThemeSettings />
            </TabsContent>

            <TabsContent value="api-keys">
              <SectionCard>
                <SectionCardBody>
                  <p className="text-sm text-muted-foreground">
                    에이전트 API Key 관리는 <strong>Members → Agents</strong> 탭으로 이관됐습니다.
                  </p>
                  <button
                    type="button"
                    onClick={() => { setActiveTab('members'); setMembersSubTab('agents'); }}
                    className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
                  >
                    Members → Agents로 이동
                  </button>
                </SectionCardBody>
              </SectionCard>
            </TabsContent>

            <TabsContent value="notifications">
              <SectionCard>
                <SectionCardHeader>
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold text-foreground">{t('notifications')}</h2>
                    <p className="text-sm text-muted-foreground">{t('notificationDescription')}</p>
                  </div>
                </SectionCardHeader>
                <SectionCardBody>
                  {loading ? (
                    <div className="space-y-3">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
                      ))}
                    </div>
                  ) : (
                    <div>
                      {/* 채널 헤더 */}
                      <div className="mb-3 flex items-center overflow-x-auto border-b pb-2">
                        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t('notifications')}</span>
                        <div className="ml-auto flex shrink-0 gap-6 pl-4 text-center text-xs font-medium text-muted-foreground">
                          <span className="w-14">{t('notification_channel_in_app')}</span>
                          <span className="w-14 opacity-40">{t('notification_channel_webhook')}</span>
                          <span className="w-14 opacity-40">{t('notification_channel_email')}</span>
                        </div>
                      </div>

                      {/* 카테고리 그룹 */}
                      <div className="space-y-4">
                        {NOTIFICATION_CATEGORIES.map((category) => {
                          const allEnabled = isCategoryAllEnabled(category.key);
                          return (
                            <div key={category.key}>
                              {/* 카테고리 헤더 */}
                              <div className="mb-1 flex items-center justify-between">
                                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  {t(`notification_category_${category.key}`)}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void toggleCategory(category.key, !allEnabled)}
                                  className="text-xs text-muted-foreground transition hover:text-foreground"
                                >
                                  {allEnabled ? tc('disable_all') : tc('enable_all')}
                                </button>
                              </div>

                              {/* 이벤트 행 */}
                              <div className="space-y-1 rounded-md border border-border bg-muted/20">
                                {category.types.map((eventType) => {
                                  const enabled = getEnabled(eventType);
                                  return (
                                    <div
                                      key={eventType}
                                      className="flex items-center px-3 py-2.5"
                                    >
                                      <span className="min-w-0 flex-1 text-sm text-foreground">
                                        {t(`event_${eventType}`)}
                                      </span>
                                      <div className="ml-auto flex shrink-0 items-center gap-6">
                                        {/* in_app 토글 */}
                                        <div className="flex w-14 justify-center">
                                          <button
                                            type="button"
                                            onClick={() => void toggleSetting(eventType, enabled)}
                                            className={`relative h-6 w-11 rounded-full transition ${enabled ? 'bg-primary' : 'bg-muted'}`}
                                          >
                                            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                                          </button>
                                        </div>
                                        {isEEEnabled() && (
                                          <div className="flex w-14 justify-center">
                                            <span className="text-[11px] text-muted-foreground opacity-40">{t('notification_coming_soon')}</span>
                                          </div>
                                        )}
                                        {isEEEnabled() && (
                                          <div className="flex w-14 justify-center">
                                            <span className="text-[11px] text-muted-foreground opacity-40">{t('notification_coming_soon')}</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </SectionCardBody>
              </SectionCard>
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
                <SectionCard>
                  <SectionCardHeader>
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-foreground">{t('autoRefresh')}</h2>
                      <p className="text-sm text-muted-foreground">{t('autoRefreshDescription')}</p>
                    </div>
                  </SectionCardHeader>
                  <SectionCardBody>
                    <RefreshSettings />
                  </SectionCardBody>
                </SectionCard>
              </div>
            </TabsContent>

            {/* E-SETTINGS-IA: deprecate 숨김. activeTab은 resolveSettingsTab로 'ai' 도달 불가지만,
                content도 gate off하여 딥링크/forceMount 어떤 경로로도 렌더 안 되게 한다. 컴포넌트는 보존. */}
            {!HIDDEN_SETTINGS_TABS.has('ai') ? (
              <TabsContent value="ai">
                <div className="space-y-6">
                  {currentProjectId ? (
                    <>
                      <AiSettingsSection projectId={currentProjectId} />
                      <McpConnectionSettings projectId={currentProjectId} />
                      <ByomKeyManagement projectId={currentProjectId} />
                    </>
                  ) : null}
                </div>
              </TabsContent>
            ) : null}

            <TabsContent value="organization">
              <SectionCard>
                <SectionCardHeader>
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold text-foreground">Organization 설정</h2>
                    <p className="text-sm text-muted-foreground">Organization 기본 정보를 확인하고 수정합니다.</p>
                  </div>
                </SectionCardHeader>
                <SectionCardBody className="space-y-6">
                  {orgInfo ? (
                    <>
                      <div className="space-y-4">
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium text-foreground">이름</label>
                          {(currentOrgRole === 'owner' || currentOrgRole === 'admin') ? (
                            <div className="flex items-center gap-2">
                              <input
                                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                                value={editOrgName}
                                onChange={(e) => setEditOrgName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveOrgName(); }}
                              />
                              <Button
                                variant="hero"
                                size="sm"
                                disabled={!editOrgName.trim() || editOrgName === orgInfo.name || savingOrgName}
                                onClick={() => void handleSaveOrgName()}
                              >
                                {savingOrgName ? '저장 중…' : '저장'}
                              </Button>
                            </div>
                          ) : (
                            <p className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm text-foreground">{orgInfo.name}</p>
                          )}
                          {orgNameError && <p className="text-xs text-destructive">{orgNameError}</p>}
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-sm font-medium text-foreground">Slug</label>
                          <p className="rounded-md border border-input bg-muted/30 px-3 py-2 font-mono text-sm text-muted-foreground">{orgInfo.slug}</p>
                          <p className="text-xs text-muted-foreground">slug는 변경할 수 없습니다.</p>
                        </div>

                        {orgInfo.plan && (
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium text-foreground">플랜</label>
                            <p className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm text-foreground capitalize">{orgInfo.plan}</p>
                          </div>
                        )}

                        {currentOrgRole && (
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium text-foreground">내 역할</label>
                            <p className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm text-foreground capitalize">{currentOrgRole}</p>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="space-y-3">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
                      ))}
                    </div>
                  )}
                </SectionCardBody>
              </SectionCard>
              {/* S-GATE-4 2계층: 조직 게이트 정책(기본값) surface. scope='org'. PUT 은 대표 project 경유
                  (org_router 는 GET 만)·canEdit=org admin/owner. project 0개면 컴포넌트가 편집 불가 안내. */}
              {orgInfo ? (
                <div className="mt-6">
                  <GateLevelMatrix
                    surface="org"
                    orgId={orgInfo.id}
                    projectId={currentProjectId ?? projects[0]?.id}
                    canEdit={currentOrgRole === 'owner' || currentOrgRole === 'admin'}
                  />
                </div>
              ) : null}
              {currentOrgRole === 'owner' && (
                <SectionCard className="border-destructive/20 bg-destructive/10 mt-6">
                  <SectionCardHeader className="border-b border-destructive/20">
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-destructive">위험 구역</h2>
                      <p className="text-sm text-destructive/80">Organization을 삭제하면 모든 Project, Member, 데이터가 영구적으로 제거됩니다.</p>
                    </div>
                  </SectionCardHeader>
                  <SectionCardBody>
                    <Button variant="destructive" onClick={() => void handleOpenDeleteOrg()}>
                      Organization 삭제
                    </Button>
                  </SectionCardBody>
                </SectionCard>
              )}
            </TabsContent>

            <TabsContent value="org-members">
              {orgId && orgInfo ? (
                <OrgMembersSection orgId={orgId} currentRole={currentOrgRole} />
              ) : (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
                </div>
              )}
            </TabsContent>

            <TabsContent value="projects">
              <SectionCard>
                <SectionCardHeader>
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold text-foreground">{t('projectManagement')}</h2>
                    <p className="text-sm text-muted-foreground">{t('projectManagementDescription')}</p>
                  </div>
                </SectionCardHeader>
                <SectionCardBody className="space-y-4">
                  <div className="space-y-2">
                    {projects.length > 0 ? (
                      projects.map((project) => (
                        <div key={project.id} className="rounded-md border border-border bg-muted/30 px-4 py-3">
                          {editingProjectId === project.id ? (
                            <div className="space-y-2">
                              <OperatorInput
                                value={editProjectName}
                                onChange={(e) => setEditProjectName(e.target.value)}
                                placeholder={t('projectNamePlaceholder')}
                              />
                              <OperatorInput
                                value={editProjectDescription}
                                onChange={(e) => setEditProjectDescription(e.target.value)}
                                placeholder={t('projectDescriptionPlaceholder')}
                              />
                              <div className="flex gap-2">
                                <Button variant="hero" size="sm" onClick={handleUpdateProject} disabled={!editProjectName.trim() || savingProject}>
                                  {savingProject ? '...' : tc('save')}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setEditingProjectId(null)}>
                                  {tc('cancel')}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-medium text-foreground">{project.name}</div>
                                {project.description ? (
                                  <div className="mt-1 text-sm text-muted-foreground">{project.description}</div>
                                ) : null}
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                {project.id === currentProjectId ? <Badge variant="info">{t('currentProjectBadge')}</Badge> : null}
                                {isAdmin ? (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => {
                                        setEditingProjectId(project.id);
                                        setEditProjectName(project.name);
                                        setEditProjectDescription(project.description ?? '');
                                      }}
                                    >
                                      {tc('edit')}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                      onClick={() => setDeleteProjectConfirmId(project.id)}
                                      disabled={deletingProjectId === project.id}
                                    >
                                      {deletingProjectId === project.id ? '...' : t('deleteProject')}
                                    </Button>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                        {t('projectListEmpty')}
                      </div>
                    )}
                  </div>

                  {projectActionMessage ? (
                    <Alert variant={projectActionMessage.type === 'success' ? 'success' : 'destructive'}>
                      <AlertDescription>{projectActionMessage.text}</AlertDescription>
                    </Alert>
                  ) : null}

                  {isAdmin ? (
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <OperatorInput
                        value={newProjectName}
                        onChange={(event) => setNewProjectName(event.target.value)}
                        placeholder={t('projectNamePlaceholder')}
                      />
                      <OperatorInput
                        value={newProjectDescription}
                        onChange={(event) => setNewProjectDescription(event.target.value)}
                        placeholder={t('projectDescriptionPlaceholder')}
                      />
                      <Button variant="hero" size="lg" onClick={handleCreateProject} disabled={!newProjectName.trim() || creatingProject}>
                        {creatingProject ? '...' : t('createProjectAction')}
                      </Button>
                    </div>
                  ) : adminChecked ? (
                    <Alert variant="warning">
                      <AlertDescription>{t('projectAdminRequired')}</AlertDescription>
                    </Alert>
                  ) : null}
                </SectionCardBody>
              </SectionCard>

            </TabsContent>

            <TabsContent value="members">
              {/* 7363ec8a: People/Agents 공통 헤더 — 서브탭 토글 + "+멤버 추가" 단일 진입(분산 해소). */}
              <div className="mb-6 flex items-center gap-3">
                <div className="flex flex-1 gap-1 rounded-lg border border-border bg-muted/30 p-1">
                  <button
                    type="button"
                    onClick={() => setMembersSubTab('people')}
                    className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${membersSubTab === 'people' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {t('membersTabPeople')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMembersSubTab('agents')}
                    className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${membersSubTab === 'agents' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {t('membersTabAgents')}
                  </button>
                </div>
                {isAdmin ? (
                  <Button variant="hero" size="sm" className="shrink-0 gap-1.5" onClick={() => setAddMemberOpen(true)}>
                    <Plus className="size-3.5" /> {t('addMember')}
                  </Button>
                ) : null}
              </div>

              {membersSubTab === 'agents' ? (
                <div className="space-y-6">
                  <SectionCard>
                    <SectionCardHeader>
                      <div className="space-y-1">
                        <h2 className="text-base font-semibold text-foreground">{t('orgAgentsTitle')}</h2>
                        <p className="text-sm text-muted-foreground">{t('orgAgentsDescription')}</p>
                      </div>
                    </SectionCardHeader>
                    <SectionCardBody className="space-y-4">
                      {agentActionMessage ? (
                        <Alert variant={agentActionMessage.type === 'success' ? 'success' : 'destructive'}>
                          <AlertDescription>{agentActionMessage.text}</AlertDescription>
                        </Alert>
                      ) : null}

                      {newAgentResult ? (
                        <div className="rounded-md border border-success-border bg-success-tint p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-success">
                              {newAgentResult.name} 생성 완료
                            </p>
                            <button type="button" onClick={() => setNewAgentResult(null)} className="text-muted-foreground hover:text-foreground">
                              <X className="size-3.5" />
                            </button>
                          </div>
                          {newAgentResult.fakechat_port ? (
                            <div className="flex items-center gap-2 text-xs">
                              <Badge variant="info">SSE</Badge>
                              <span className="font-mono text-foreground">Port: {newAgentResult.fakechat_port}</span>
                              <span className="text-muted-foreground">— fakechat http://localhost:{newAgentResult.fakechat_port}/sse</span>
                            </div>
                          ) : null}
                          {newAgentResult.api_key ? (
                            <div className="space-y-1">
                              <p className="text-xs font-medium text-foreground">API Key — 지금만 표시됩니다.</p>
                              <code className="block break-all rounded bg-background border border-border p-2 text-xs font-mono text-foreground/80">
                                {newAgentResult.api_key}
                              </code>
                            </div>
                          ) : null}
                          {newAgentResult.mcp_config ? (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <p className="text-xs font-medium text-foreground">MCP Config (SSE)</p>
                                <Button variant="glass" size="sm" onClick={() => void handleCopyNewAgentMcp()}>
                                  {newAgentMcpCopied ? <Check className="size-3" /> : 'Copy'}
                                </Button>
                              </div>
                              <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground/80">
                                {JSON.stringify(newAgentResult.mcp_config, null, 2)}
                              </pre>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {orgAgents.length > 0 ? (
                        <div className="space-y-2">
                          {orgAgents.map((agent) => {
                            const projectName = projects.find((p) => p.id === agent.project_id)?.name ?? agent.project_id;
                            // 7519c3ea: webhook discoverability — 행에 status 한눈에(편집은 detail editor 링크=이름).
                            const agentWebhook = webhooks.find((w) => w.member_id === agent.id);
                            const webhookStatus: 'active' | 'inactive' | 'empty' = !agentWebhook?.url
                              ? 'empty'
                              : !agentWebhook.is_active ? 'inactive' : 'active';
                            return (
                              <div key={agent.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
                                <div className="min-w-0">
                                  <Link href={`/settings/members/agents/${agent.id}`} className="font-medium text-foreground hover:underline hover:text-primary">{agent.name}</Link>
                                  <div className="mt-1 flex flex-wrap items-center gap-2">
                                    <Badge variant="secondary">{t('agentMember')}</Badge>
                                    <Badge variant="outline">{agent.role}</Badge>
                                    <Badge variant="info">SSE</Badge>
                                    <Badge variant={webhookStatus === 'active' ? 'success' : webhookStatus === 'inactive' ? 'secondary' : 'outline'} className="gap-1">
                                      <Webhook className="size-3" aria-hidden />
                                      {webhookStatus === 'active' ? t('webhookStatusActive') : webhookStatus === 'inactive' ? t('webhookStatusInactive') : t('webhookStatusEmpty')}
                                    </Badge>
                                    {agent.fakechat_port ? <span className="font-mono text-[11px] text-muted-foreground">:{agent.fakechat_port}</span> : null}
                                    <span className="text-xs text-muted-foreground">{projectName}</span>
                                    {currentUserId && agent.created_by === currentUserId ? <Badge variant="outline" className="border-primary/40 text-primary text-[10px]">{t('agentOwner')}</Badge> : null}
                                    {!agent.is_active ? <Badge variant="destructive">inactive</Badge> : null}
                                  </div>
                                </div>
                                {isAdmin ? (
                                <Button
                                  variant="glass"
                                  size="sm"
                                  onClick={() => void handleToggleAgentActive(agent)}
                                  disabled={deactivatingAgentId === agent.id}
                                >
                                  {deactivatingAgentId === agent.id ? '...' : agent.is_active ? t('deactivateAgent') : t('activateAgent')}
                                </Button>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="rounded-md border border-dashed border-border px-3 py-8 text-center">
                          <p className="text-sm text-muted-foreground">{t('noOrgAgents')}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{t('noOrgAgentsCta')}</p>
                        </div>
                      )}

                      {/* org-agent S5: scope 인지 생성 폼 — agent-deployment-wizard scope 패턴 미러(신규 토큰 0). */}
                      <div className="space-y-4">
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-muted-foreground">{t('agentNameLabel')}</label>
                          <OperatorInput
                            value={newAgentName}
                            onChange={(e) => setNewAgentName(e.target.value)}
                            placeholder={t('agentNamePlaceholder')}
                          />
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-muted-foreground">{t('agentRoleLabel')}</label>
                          <OperatorDropdownSelect
                            value={newAgentRole}
                            onValueChange={(v) => setNewAgentRole(v as 'member' | 'admin')}
                            options={[
                              { value: 'member', label: t('agentRoleMember') },
                              { value: 'admin', label: t('agentRoleAdmin') },
                            ]}
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="text-xs font-medium text-muted-foreground">{t('agentScopeLabel')}</label>
                          <div className="grid gap-3 md:grid-cols-2">
                            {(['org', 'projects'] as const).map((mode) => {
                              const selected = newAgentScopeMode === mode;
                              return (
                                <button
                                  key={mode}
                                  type="button"
                                  onClick={() => setNewAgentScopeMode(mode)}
                                  className={`rounded-md border px-4 py-4 text-left transition ${selected ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted'}`}
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div>
                                      <p className="text-sm font-semibold text-foreground">{mode === 'org' ? t('agentScopeAllProjects') : t('agentScopeSpecificProjects')}</p>
                                      <p className="mt-1 text-sm text-muted-foreground">{mode === 'org' ? t('agentScopeAllProjectsBody') : t('agentScopeSpecificProjectsBody')}</p>
                                    </div>
                                    {selected ? <CheckCircle2 className="size-5 shrink-0 text-primary" /> : null}
                                  </div>
                                </button>
                              );
                            })}
                          </div>

                          {newAgentScopeMode === 'projects' ? (
                            <div className="grid max-h-72 gap-3 overflow-y-auto md:grid-cols-2 xl:grid-cols-3">
                              {projects.map((project) => {
                                const selected = newAgentProjectIds.includes(project.id);
                                return (
                                  <button
                                    key={project.id}
                                    type="button"
                                    onClick={() => toggleNewAgentProject(project.id)}
                                    className={`rounded-md border px-4 py-4 text-left transition ${selected ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted'}`}
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <p className="truncate text-sm font-semibold text-foreground">{project.name}</p>
                                      {selected ? <CheckCircle2 className="size-5 shrink-0 text-primary" /> : null}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                              {t('agentScopeAllProjectsHint', { count: projects.length })}
                            </div>
                          )}
                        </div>

                        <p className="text-xs text-muted-foreground">{t('agentSeatCaption')}</p>

                        <div className="flex justify-end">
                          <Button
                            variant="hero"
                            size="lg"
                            onClick={() => void handleAddAgent()}
                            disabled={!newAgentName.trim() || (newAgentScopeMode === 'projects' && newAgentProjectIds.length === 0) || addingAgent}
                          >
                            {addingAgent ? '...' : t('addAgent')}
                          </Button>
                        </div>
                      </div>
                    </SectionCardBody>
                  </SectionCard>
                </div>
              ) : (
              <div>
                {currentProjectId ? (
                  <div className="space-y-6">
                    <ProjectAccessSection
                      projectId={currentProjectId}
                      currentRole={currentOrgRole}
                    />
                    {/* 7519c3ea: 팀원 webhook inline — flat 탭 폐기분을 멤버별 surface(handleSaveWebhookUrl 재사용·status 한눈에). */}
                    <SectionCard>
                      <SectionCardHeader>
                        <div className="space-y-1">
                          <h2 className="text-base font-semibold text-foreground">{t('webhooks')}</h2>
                          <p className="text-sm text-muted-foreground">{t('webhookDescription')}</p>
                        </div>
                      </SectionCardHeader>
                      <SectionCardBody className="space-y-2">
                        {projectMembers.filter((m) => m.type === 'human').map((member) => {
                          // 휴먼 webhook도 canonical webhook_configs(member_id) 기준 — 에이전트와 통일.
                          const config = webhooks.find((w) => w.member_id === member.id);
                          const draft = webhookEditing[member.id] ?? config?.url ?? '';
                          const webhookStatus: 'active' | 'inactive' | 'empty' = !config?.url
                            ? 'empty'
                            : config.is_active ? 'active' : 'inactive';
                          const err = webhookErrors[member.id];
                          return (
                            <div key={member.id} className="rounded-md border border-border bg-muted/30 px-3 py-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{member.name}</span>
                                <Badge variant={webhookStatus === 'active' ? 'success' : webhookStatus === 'inactive' ? 'secondary' : 'outline'} className="gap-1">
                                  <Webhook className="size-3" aria-hidden />
                                  {webhookStatus === 'active' ? t('webhookStatusActive') : webhookStatus === 'inactive' ? t('webhookStatusInactive') : t('webhookStatusEmpty')}
                                </Badge>
                              </div>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <OperatorInput
                                  type="url"
                                  value={draft}
                                  onChange={(e) => setWebhookEditing((prev) => ({ ...prev, [member.id]: e.target.value }))}
                                  placeholder={t('webhookUrlPlaceholder')}
                                  className="min-w-0 flex-1 font-mono text-xs"
                                />
                                <Button
                                  variant="hero"
                                  size="sm"
                                  onClick={() => void handleSaveWebhookUrl(member.id)}
                                  disabled={webhookSaving === member.id}
                                >
                                  {webhookSaving === member.id ? '...' : tc('save')}
                                </Button>
                              </div>
                              {err ? <p className="mt-1 text-xs text-destructive">{err}</p> : null}
                            </div>
                          );
                        })}
                      </SectionCardBody>
                    </SectionCard>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">프로젝트를 선택해주세요.</p>
                )}
              </div>
              )}
            </TabsContent>


            {/* E-SETTINGS-IA S2: deprecate 숨김. set 확장으로 trigger·content·딥링크(resolveSettingsTab) 일괄 차단. 컴포넌트 보존. */}
            {adminChecked && isAdmin && !HIDDEN_SETTINGS_TABS.has('workflow') ? (
            <TabsContent value="workflow">
              <div className="space-y-6">
                <WorkflowTriggerTypesSection />
                {currentProjectId ? <WorkflowTemplateGallerySection projectId={currentProjectId} orgId={orgId ?? undefined} /> : null}
                {currentProjectId ? <WorkflowExecutionHistorySection projectId={currentProjectId} /> : null}
              </div>
            </TabsContent>
            ) : null}

            {isEEEnabled() && adminChecked && isAdmin ? (
            <TabsContent value="subscription">
              <SectionCard>
                <SectionCardHeader>
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold text-foreground">{t('manageSubscription')}</h2>
                    <p className="text-sm text-muted-foreground">{t('subscriptionDescription')}</p>
                  </div>
                </SectionCardHeader>
                <SectionCardBody className="space-y-3">
                  {graceUntil && new Date(graceUntil) > new Date() ? (
                    <Alert variant="warning">
                      <AlertDescription>{t('gracePeriodNotice', { date: new Date(graceUntil).toLocaleDateString('ko-KR') })}</AlertDescription>
                    </Alert>
                  ) : null}
                  <Button
                    variant="glass"
                    size="lg"
                    onClick={async () => {
                      try {
                        const res = await fetch('/api/subscription/portal', { method: 'POST' });
                        if (res.ok) {
                          const json = await res.json() as { data: { portalUrl: string } };
                          window.open(json.data.portalUrl, '_blank');
                        } else {
                          addToast({ type: 'error', title: t('billingPortalError') });
                        }
                      } catch (err) {
                        // 사용자 액션(결제 포털)인데 조용히 실패하면 버튼이 무반응처럼 보인다 — 안내.
                        console.error('결제 포털 열기 실패', err);
                        addToast({ type: 'error', title: t('billingPortalError') });
                      }
                    }}
                  >
                    {t('manageSubscriptionBtn')}
                  </Button>
                </SectionCardBody>
              </SectionCard>
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
              <SectionCard className="border-destructive/20 bg-destructive/10">
                <SectionCardHeader className="border-b border-destructive/20">
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold text-destructive">{t('dangerZone')}</h2>
                    <p className="text-sm text-destructive/80">{t('dangerDescription')}</p>
                  </div>
                </SectionCardHeader>
                <SectionCardBody>
                  <p className="mb-4 text-sm text-destructive/80">{t('deleteAccountDesc')}</p>
                  <Button variant="destructive" size="lg" onClick={() => setShowDeleteConfirm(true)}>
                    {t('deleteAccount')}
                  </Button>
                </SectionCardBody>
              </SectionCard>
            </TabsContent>

          </div>
        </div>
      </Tabs>

      {showDeleteOrgConfirm && orgInfo ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-destructive/30 bg-card p-6 shadow-md space-y-4">
            <h3 className="text-lg font-semibold text-destructive">Organization 삭제</h3>

            {/* 영향도 */}
            {orgImpactLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => <div key={i} className="h-6 animate-pulse rounded bg-muted" />)}
              </div>
            ) : orgImpact ? (
              <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1 text-sm">
                <p className="text-muted-foreground">삭제 시 영향 범위:</p>
                <ul className="space-y-0.5 text-foreground">
                  <li>• Project <span className="font-semibold">{orgImpact.project_count}개</span> 영구 삭제</li>
                  <li>• Member <span className="font-semibold">{orgImpact.member_count}명</span> 접근 불가</li>
                  {orgImpact.has_active_subscription && (
                    <li className="text-warning">• 활성 구독이 있습니다 — 삭제 전 구독을 취소해주세요.</li>
                  )}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">영향도 정보를 불러올 수 없습니다. 계속 진행해도 됩니다.</p>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                확인을 위해 Organization 이름 <span className="font-mono text-destructive">{orgInfo.name}</span>을 입력하세요.
              </label>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-destructive"
                placeholder={orgInfo.name}
                value={deleteOrgConfirmName}
                onChange={(e) => setDeleteOrgConfirmName(e.target.value)}
                autoFocus
              />
            </div>

            <div className="flex gap-3 pt-1">
              <Button
                variant="glass"
                className="flex-1"
                onClick={() => { setShowDeleteOrgConfirm(false); setDeleteOrgConfirmName(''); }}
                disabled={deletingOrg}
              >
                취소
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={() => void handleDeleteOrg()}
                disabled={deleteOrgConfirmName !== orgInfo.name || deletingOrg || (orgImpact?.has_active_subscription ?? false)}
              >
                {deletingOrg ? '삭제 중…' : '영구 삭제'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {showDeleteConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-md">
            <h3 className="text-lg font-semibold text-destructive">{t('deleteConfirmTitle')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('deleteConfirmDesc')}</p>
            <div className="mt-6 flex gap-3">
              <Button variant="glass" className="flex-1" onClick={() => setShowDeleteConfirm(false)}>
                {tc('cancel')}
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={async () => {
                  setDeleting(true);
                  const res = await fetch('/api/account/delete', { method: 'POST' });
                  if (res.ok) {
                    router.push('/login');
                  } else {
                    const json = await res.json().catch(() => null);
                    if (json?.error?.code === 'REAUTHENTICATION_REQUIRED') {
                      alert(t('reauthRequired'));
                    }
                    setDeleting(false);
                    setShowDeleteConfirm(false);
                  }
                }}
                disabled={deleting}
              >
                {deleting ? '...' : t('confirmDelete')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteProjectConfirmId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-md">
            <h3 className="text-lg font-semibold text-destructive">{t('projectDeleteConfirmTitle')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('projectDeleteConfirmDesc')}</p>
            <div className="mt-6 flex gap-3">
              <Button variant="glass" className="flex-1" onClick={() => setDeleteProjectConfirmId(null)}>
                {tc('cancel')}
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={() => handleDeleteProject(deleteProjectConfirmId)}
                disabled={deletingProjectId === deleteProjectConfirmId}
              >
                {deletingProjectId === deleteProjectConfirmId ? '...' : t('deleteProject')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {orgId ? (
        <AddMemberModal
          open={addMemberOpen}
          onClose={() => setAddMemberOpen(false)}
          orgId={orgId}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          defaultType={membersSubTab === 'agents' ? 'agent' : 'human'}
          onAdded={(type, message) => {
            addToast({ type: 'success', title: message });
            if (type === 'agent') void refreshOrgAgents();
          }}
        />
      ) : null}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
