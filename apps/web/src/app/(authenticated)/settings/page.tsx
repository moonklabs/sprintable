'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BarChart2, Bell, Bot, Check, CreditCard, FolderKanban, GitBranch, Key, Menu, Palette, Trash2, User, Users, X, Zap } from 'lucide-react';
import { UsageDashboard } from '@/components/settings/usage-dashboard';
import { AiSettingsSection } from '@/components/settings/ai-settings';
import { MyProfileSection } from '@/components/settings/my-profile-section';
import { ByomKeyManagement } from '@/components/settings/byom-key-management';
import { McpConnectionSettings } from '@/components/settings/mcp-connection-settings';
import { SlackIntegrationSettingsSection } from '@/components/settings/slack-integration-settings';
import { WorkflowTriggerTypesSection } from '@/components/settings/workflow-trigger-types-section';
import { WorkflowExecutionHistorySection } from '@/components/settings/workflow-execution-history-section';
import { WorkflowTemplateGallerySection } from '@/components/settings/workflow-template-gallery-section';
import { ThemeSettings } from '@/components/settings/theme-settings';
import { RefreshSettings } from '@/components/settings/refresh-settings';
import { StandupDeadlineSection } from '@/components/settings/standup-deadline-section';
import { TwoFactorSection } from '@/components/settings/two-factor-section';
import { SetPasswordSection } from '@/components/settings/set-password-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { NOTIFICATION_TYPES } from '@/lib/notification-types';

interface NotificationSetting {
  id: string;
  channel: string;
  event_type: string;
  enabled: boolean;
}

interface WebhookConfig {
  id: string;
  url: string;
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
  { key: 'memo', types: ['memo', 'memo_reply', 'memo_mention'] },
  { key: 'story', types: ['story', 'story_assigned'] },
  { key: 'task', types: ['task', 'task_assigned', 'task_completed'] },
  { key: 'sprint', types: ['sprint_closed'] },
  { key: 'system', types: ['info', 'warning', 'system', 'standup_reminder', 'reward', 'invitation'] },
] as const satisfies ReadonlyArray<{ key: string; types: ReadonlyArray<(typeof NOTIFICATION_TYPES)[number]> }>;

type NotificationCategoryKey = typeof NOTIFICATION_CATEGORIES[number]['key'];

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const router = useRouter();
  const searchParamsHook = useSearchParams();
  const [activeTab, setActiveTab] = useState(() => searchParamsHook.get('tab') ?? 'profile');
  const [lnbOpen, setLnbOpen] = useState(false);
  const { toasts, addToast, dismissToast } = useToast();

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    setLnbOpen(false); // 모바일에서 탭 선택 시 LNB 자동 접기
  };

  useEffect(() => {
    const tab = searchParamsHook.get('tab');
    if (tab) setActiveTab(tab);
  }, [searchParamsHook]);

  const [orgId, setOrgId] = useState<string | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [orgInfo, setOrgInfo] = useState<{ id: string; name: string; slug: string; plan?: string; role?: string } | null>(null);
  const [editOrgName, setEditOrgName] = useState('');
  const [savingOrgName, setSavingOrgName] = useState(false);
  const [orgNameError, setOrgNameError] = useState('');
  const [projectMemberships] = useState<Array<{ projectId: string; projectName: string }>>([]);
  const [settings, setSettings] = useState<NotificationSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [createdProjectMembership, setCreatedProjectMembership] = useState<{ projectId: string; projectName: string } | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWebhookProjectId, setNewWebhookProjectId] = useState('');
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
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deleteProjectConfirmId, setDeleteProjectConfirmId] = useState<string | null>(null);
  const [projectInviteEmail, setProjectInviteEmail] = useState('');
  const [projectInviteProjectId, setProjectInviteProjectId] = useState('');
  const [projectInviting, setProjectInviting] = useState(false);
  const [projectInviteResult, setProjectInviteResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null);
  const [resendResult, setResendResult] = useState<{ id: string; url: string } | null>(null);
  const [graceUntil, setGraceUntil] = useState<string | null>(null);
  const [membersSubTab, setMembersSubTab] = useState<'people' | 'agents'>('people');
  const [orgAgents, setOrgAgents] = useState<ProjectMember[]>([]);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentProjectId, setNewAgentProjectId] = useState('');
  const [addingAgent, setAddingAgent] = useState(false);
  const [deactivatingAgentId, setDeactivatingAgentId] = useState<string | null>(null);
  const [agentActionMessage, setAgentActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newAgentResult, setNewAgentResult] = useState<NewAgentResult | null>(null);
  const [newAgentMcpCopied, setNewAgentMcpCopied] = useState(false);
  const [webhookEditing, setWebhookEditing] = useState<Record<string, string>>({});
  const [webhookSaving, setWebhookSaving] = useState<string | null>(null);
  const [webhookErrors, setWebhookErrors] = useState<Record<string, string>>({});

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
    const res = await fetch('/api/invitations');
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
    setRevokingInviteId(inviteId);
    try {
      const res = await fetch(`/api/invitations/${inviteId}`, { method: 'DELETE' });
      if (res.ok) await refreshInvitations();
    } finally {
      setRevokingInviteId(null);
    }
  };

  const handleResendInvite = async (inviteId: string) => {
    setResendingInviteId(inviteId);
    setResendResult(null);
    try {
      const res = await fetch(`/api/invitations/${inviteId}/resend`, { method: 'POST' });
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

  const handleAddAgent = async () => {
    if (!newAgentName.trim() || !newAgentProjectId || !orgId) return;
    setAddingAgent(true);
    setAgentActionMessage(null);
    setNewAgentResult(null);
    const res = await fetch('/api/team-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, project_id: newAgentProjectId, name: newAgentName.trim(), type: 'agent', role: 'member' }),
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
      setNewAgentProjectId('');
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
      fetch('/api/team-members?include_inactive=true'),
    ]);

    if (projectMemberRes.ok) {
      const json = await projectMemberRes.json();
      setProjectMembers((json.data ?? []) as ProjectMember[]);
    }

    if (orgMemberRes.ok) {
      const json = await orgMemberRes.json();
      setOrgMembers((json.data ?? []) as ProjectMember[]);
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

      // Get current project
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
        setLoading(false);

        // Get webhook configs
        const webhookRes = await fetch('/api/webhooks/config');
        if (webhookRes.ok) {
          const webhookJson = await webhookRes.json();
          setWebhooks(webhookJson.data ?? []);
        }
      }
    }

    void loadContext().catch(() => {});

    void refreshProjects().catch(() => {});

    void refreshInvitations().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, orgId]);

  useEffect(() => {
    if (!memberProjectId) return;
    void refreshMemberData(memberProjectId).catch(() => {});
  }, [memberProjectId]);

  useEffect(() => {
    void refreshOrgAgents().catch(() => {});
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
    setNewWebhookProjectId(project.id);
    setNewProjectName('');
    setNewProjectDescription('');
    setProjectActionMessage({ type: 'success', text: t('projectCreated', { name: project.name }) });

    await refreshProjects().catch(() => {});
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

  const handleProjectInvite = async () => {
    if (!projectInviteEmail.trim() || !projectInviteProjectId) return;
    setProjectInviting(true);
    setProjectInviteResult(null);

    const res = await fetch(`/api/projects/${projectInviteProjectId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: projectInviteEmail.trim(), role: 'member' }),
    });

    if (res.ok) {
      const json = await res.json();
      setProjectInviteResult({ type: 'success', text: `${t('projectInviteSent')} ${json.data.invite_url}` });
      setProjectInviteEmail('');
    } else {
      const json = await res.json().catch(() => null);
      setProjectInviteResult({ type: 'error', text: json?.error?.message ?? t('projectInviteFailed') });
    }

    setProjectInviting(false);
  };

  const handleSaveWebhookUrl = async (memberId: string) => {
    const url = (webhookEditing[memberId] ?? '').trim();
    if (url && !/^https:\/\//i.test(url)) {
      setWebhookErrors((prev) => ({ ...prev, [memberId]: 'HTTPS URL만 허용됩니다 (https://)' }));
      return;
    }
    setWebhookErrors((prev) => ({ ...prev, [memberId]: '' }));
    setWebhookSaving(memberId);
    const prevMembers = projectMembers;
    setProjectMembers((prev) => prev.map((m) => m.id === memberId ? { ...m, webhook_url: url || null } : m));
    try {
      const res = await fetch(`/api/team-members/${memberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: url || null }),
      });
      if (!res.ok) {
        setProjectMembers(prevMembers);
        const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
        setWebhookErrors((prev) => ({ ...prev, [memberId]: json.error?.message ?? 'Webhook URL 저장 실패' }));
      } else {
        setWebhookEditing((prev) => { const next = { ...prev }; delete next[memberId]; return next; });
      }
    } catch {
      setProjectMembers(prevMembers);
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
            {currentProjectId && isAdmin ? (
              <TabsTrigger value="api-keys">
                <Key className="h-4 w-4" />
                {t('tabApiKeys')}
              </TabsTrigger>
            ) : null}

            {currentProjectId ? (
              <>
                <span className="px-2 pb-1 pt-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{t('projectSettings')}</span>
                <TabsTrigger value="notifications">
                  <Bell className="h-4 w-4" />
                  {t('tabNotifications')}
                </TabsTrigger>
                <TabsTrigger value="ai">
                  <Bot className="h-4 w-4" />
                  {t('tabAiAgents')}
                </TabsTrigger>
              </>
            ) : null}

            {adminChecked ? (
              <>
                <span className="truncate px-2 pb-1 pt-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{t('organizationSettings')}</span>
                <TabsTrigger value="organization">
                  <FolderKanban className="h-4 w-4" />
                  Organization
                </TabsTrigger>
                <TabsTrigger value="projects">
                  <FolderKanban className="h-4 w-4" />
                  {t('tabProjects')}
                </TabsTrigger>
                <TabsTrigger value="members">
                  <Users className="h-4 w-4" />
                  {t('tabMembers')}
                </TabsTrigger>
                {isAdmin ? (
                  <>
                    <TabsTrigger value="integrations">
                      <Zap className="h-4 w-4" />
                      {t('tabIntegrations')}
                    </TabsTrigger>
                    <TabsTrigger value="workflow">
                      <GitBranch className="h-4 w-4" />
                      {t('tabWorkflow')}
                    </TabsTrigger>
                    <TabsTrigger value="subscription">
                      <CreditCard className="h-4 w-4" />
                      {t('tabSubscription')}
                    </TabsTrigger>
                    <TabsTrigger value="usage">
                      <BarChart2 className="h-4 w-4" />
                      {t('tabUsage')}
                    </TabsTrigger>
                  </>
                ) : null}
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
                                        {/* webhook - 준비 중 */}
                                        <div className="flex w-14 justify-center">
                                          <span className="text-[11px] text-muted-foreground opacity-40">{t('notification_coming_soon')}</span>
                                        </div>
                                        {/* email - 준비 중 */}
                                        <div className="flex w-14 justify-center">
                                          <span className="text-[11px] text-muted-foreground opacity-40">{t('notification_coming_soon')}</span>
                                        </div>
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
                          {(orgInfo.role === 'owner' || orgInfo.role === 'admin') ? (
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

                        {orgInfo.role && (
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium text-foreground">내 역할</label>
                            <p className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm text-foreground capitalize">{orgInfo.role}</p>
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
                    <div className={`rounded-md border p-3 text-xs ${projectActionMessage.type === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-destructive/20 bg-destructive/10 text-destructive'}`}>
                      {projectActionMessage.text}
                    </div>
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
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
                      {t('projectAdminRequired')}
                    </div>
                  ) : null}
                </SectionCardBody>
              </SectionCard>
            </TabsContent>

            <TabsContent value="members">
              {/* People / Agents 서브탭 */}
              <div className="mb-6 flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
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
                        <div className={`rounded-md border p-3 text-xs ${agentActionMessage.type === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-destructive/20 bg-destructive/10 text-destructive'}`}>
                          {agentActionMessage.text}
                        </div>
                      ) : null}

                      {newAgentResult ? (
                        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-emerald-500">
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
                            return (
                              <div key={agent.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
                                <div className="min-w-0">
                                  <Link href={`/settings/members/agents/${agent.id}`} className="font-medium text-foreground hover:underline hover:text-primary">{agent.name}</Link>
                                  <div className="mt-1 flex flex-wrap items-center gap-2">
                                    <Badge variant="secondary">{t('agentMember')}</Badge>
                                    <Badge variant="outline">{agent.role}</Badge>
                                    <Badge variant="info">SSE</Badge>
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

                      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto]">
                        <OperatorInput
                          value={newAgentName}
                          onChange={(e) => setNewAgentName(e.target.value)}
                          placeholder={t('agentNamePlaceholder')}
                        />
                        <OperatorDropdownSelect
                          value={newAgentProjectId}
                          onValueChange={(v) => setNewAgentProjectId(v)}
                          options={[
                            { value: '', label: t('selectProject') },
                            ...projects.map((p) => ({ value: p.id, label: p.name })),
                          ]}
                        />
                        <Button
                          variant="hero"
                          size="lg"
                          onClick={() => void handleAddAgent()}
                          disabled={!newAgentName.trim() || !newAgentProjectId || addingAgent}
                        >
                          {addingAgent ? '...' : t('addAgent')}
                        </Button>
                      </div>
                    </SectionCardBody>
                  </SectionCard>
                </div>
              ) : (
              <div className="space-y-6">
                {isAdmin ? (
                <SectionCard>
                  <SectionCardHeader>
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-foreground">{t('inviteMembers')}</h2>
                      <p className="text-sm text-muted-foreground">{t('inviteDescription')}</p>
                    </div>
                  </SectionCardHeader>
                  <SectionCardBody className="space-y-4">
                    <div className="flex flex-col gap-3 md:flex-row">
                      <OperatorInput
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        placeholder={t('emailPlaceholder')}
                      />
                      <OperatorDropdownSelect
                        value={inviteProjectId}
                        onValueChange={(v) => setInviteProjectId(v)}
                        options={[
                          { value: '', label: t('orgWideInvite') },
                          ...projects.map((project) => ({ value: project.id, label: project.name })),
                        ]}
                      />
                      <OperatorDropdownSelect
                        value={inviteRole}
                        onValueChange={(v) => setInviteRole(v as 'member' | 'admin')}
                        options={[
                          { value: 'member', label: 'Member' },
                          { value: 'admin', label: 'Admin' },
                        ]}
                      />
                      <Button
                        variant="hero"
                        size="lg"
                        onClick={async () => {
                          if (!inviteEmail.trim()) return;
                          setInviting(true);
                          const res = await fetch('/api/invitations', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole, ...(inviteProjectId ? { project_id: inviteProjectId } : {}) }),
                          });
                          if (res.ok) {
                            const json = await res.json();
                            setInviteResult(json.data.invite_url);
                            setInviteEmail('');
                            setInviteProjectId('');
                            setInviteRole('member');
                            await refreshInvitations();
                          }
                          setInviting(false);
                        }}
                        disabled={inviting}
                      >
                        {inviting ? '...' : t('invite')}
                      </Button>
                    </div>

                    {inviteResult ? (
                      <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-400 break-all">
                        {t('inviteLinkCopied')}: {inviteResult}
                      </div>
                    ) : null}

                    {invitations.length > 0 ? (
                      <div className="space-y-2">
                        {invitations.map((invitation) => (
                          <div key={invitation.id}>
                            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs">
                              <span className="text-foreground">{invitation.email}</span>
                              <span className="shrink-0 text-muted-foreground">
                                {invitation.projects?.name ?? t('orgWide')}
                              </span>
                              <span className={`shrink-0 ${invitation.status === 'accepted' ? 'text-emerald-300' : invitation.status === 'revoked' ? 'text-muted-foreground line-through' : new Date(invitation.expires_at) < new Date() ? 'text-rose-300' : 'text-amber-200'}`}>
                                {invitation.status === 'accepted' ? t('accepted') : invitation.status === 'revoked' ? t('revoked') : new Date(invitation.expires_at) < new Date() ? t('expired') : t('pending')}
                              </span>
                              {invitation.status === 'pending' ? (
                                <div className="flex shrink-0 gap-1">
                                  <button
                                    type="button"
                                    className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
                                    disabled={resendingInviteId === invitation.id}
                                    onClick={() => handleResendInvite(invitation.id)}
                                  >
                                    {resendingInviteId === invitation.id ? '...' : t('resend')}
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded border border-rose-400/30 px-2 py-0.5 text-xs text-rose-400 transition-colors hover:border-rose-300/50 hover:text-rose-300 disabled:opacity-50"
                                    disabled={revokingInviteId === invitation.id}
                                    onClick={() => handleRevokeInvite(invitation.id)}
                                  >
                                    {revokingInviteId === invitation.id ? '...' : t('revoke')}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                            {resendResult?.id === invitation.id ? (
                              <p className="mt-1 break-all px-1 text-xs text-amber-200">{t('inviteLinkCopied')}: {resendResult.url}</p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </SectionCardBody>
                </SectionCard>
                ) : null}

                {isAdmin ? (
                <SectionCard>
                  <SectionCardHeader>
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-foreground">{t('projectInviteTitle')}</h2>
                      <p className="text-sm text-muted-foreground">{t('projectInviteDescription')}</p>
                    </div>
                  </SectionCardHeader>
                  <SectionCardBody className="space-y-4">
                    <div className="flex flex-col gap-3 md:flex-row">
                      <OperatorInput
                        type="email"
                        value={projectInviteEmail}
                        onChange={(e) => setProjectInviteEmail(e.target.value)}
                        placeholder={t('emailPlaceholder')}
                      />
                      <OperatorDropdownSelect
                        value={projectInviteProjectId}
                        onValueChange={(v) => setProjectInviteProjectId(v)}
                        options={[
                          { value: '', label: t('selectProject') },
                          ...projects.map((project) => ({ value: project.id, label: project.name })),
                        ]}
                      />
                      <Button
                        variant="hero"
                        size="lg"
                        onClick={handleProjectInvite}
                        disabled={projectInviting || !projectInviteEmail.trim() || !projectInviteProjectId}
                      >
                        {projectInviting ? '...' : t('invite')}
                      </Button>
                    </div>
                    {projectInviteResult ? (
                      <div className={`rounded-md border p-3 text-xs break-all ${projectInviteResult.type === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-destructive/20 bg-destructive/10 text-destructive'}`}>
                        {projectInviteResult.text}
                      </div>
                    ) : null}
                  </SectionCardBody>
                </SectionCard>
                ) : null}

                <SectionCard>
                  <SectionCardHeader>
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-foreground">{t('memberManagement')}</h2>
                      <p className="text-sm text-muted-foreground">{t('memberManagementDescription')}</p>
                    </div>
                  </SectionCardHeader>
                  <SectionCardBody className="space-y-4">
                    {isAdmin ? (
                    <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_auto]">
                      <OperatorDropdownSelect
                        value={memberProjectId}
                        onValueChange={(v) => setMemberProjectId(v)}
                        options={[
                          { value: '', label: t('selectProject') },
                          ...projects.map((project) => ({ value: project.id, label: project.name })),
                        ]}
                      />
                      <OperatorDropdownSelect
                        value={selectedOrgMemberUserId}
                        onValueChange={(v) => setSelectedOrgMemberUserId(v)}
                        disabled={!memberProjectId || assignableMembers.length === 0}
                        options={[
                          { value: '', label: assignableMembers.length ? t('chooseMember') : t('noAssignableMembers') },
                          ...assignableMembers.map((member) => ({ value: member.user_id ?? '', label: member.name })),
                        ]}
                      />
                      <Button variant="hero" size="lg" onClick={handleAddProjectMember} disabled={!memberProjectId || !selectedOrgMemberUserId || addingMember}>
                        {addingMember ? '...' : t('addToProject')}
                      </Button>
                    </div>
                    ) : null}

                    {memberActionMessage ? (
                      <div className={`rounded-md border p-3 text-xs ${memberActionMessage.type === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-destructive/20 bg-destructive/10 text-destructive'}`}>
                        {memberActionMessage.text}
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('projectMembers')}</div>
                      {projectMembers.filter((m) => m.type === 'human').length > 0 ? (
                        projectMembers.filter((m) => m.type === 'human').map((member) => {
                          const isEditingWebhook = member.id in webhookEditing;
                          const currentWebhookUrl = member.webhook_url ?? '';
                          return (
                          <div key={member.id} className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm space-y-2">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-medium text-foreground">{member.name}</div>
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  <Badge variant={member.type === 'agent' ? 'secondary' : 'info'}>{member.type === 'agent' ? t('agentMember') : t('humanMember')}</Badge>
                                  <Badge variant="outline">{member.role}</Badge>
                                </div>
                              </div>
                              {isAdmin ? (
                              <Button variant="glass" size="sm" onClick={() => handleRemoveProjectMember(member.id)} disabled={removingMemberId === member.id}>
                                {removingMemberId === member.id ? '...' : t('removeFromProject')}
                              </Button>
                              ) : null}
                            </div>
                            {/* Webhook URL */}
                            <div className="flex items-center gap-2">
                              {isEditingWebhook ? (
                                <>
                                  <input
                                    type="url"
                                    value={webhookEditing[member.id]}
                                    onChange={(e) => {
                                      setWebhookEditing((prev) => ({ ...prev, [member.id]: e.target.value }));
                                      setWebhookErrors((prev) => ({ ...prev, [member.id]: '' }));
                                    }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveWebhookUrl(member.id); if (e.key === 'Escape') setWebhookEditing((prev) => { const next = { ...prev }; delete next[member.id]; return next; }); }}
                                    placeholder="https://your-webhook.example.com"
                                    className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    autoFocus
                                  />
                                  <Button size="sm" variant="outline" className="shrink-0 h-7 text-xs" disabled={webhookSaving === member.id} onClick={() => void handleSaveWebhookUrl(member.id)}>
                                    {webhookSaving === member.id ? '...' : '저장'}
                                  </Button>
                                  <Button size="sm" variant="ghost" className="shrink-0 h-7 text-xs" onClick={() => setWebhookEditing((prev) => { const next = { ...prev }; delete next[member.id]; return next; })}>
                                    취소
                                  </Button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="flex-1 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
                                  title={currentWebhookUrl || 'Webhook URL 설정'}
                                  onClick={() => setWebhookEditing((prev) => ({ ...prev, [member.id]: currentWebhookUrl }))}
                                >
                                  {currentWebhookUrl ? (
                                    <span className="font-mono">{currentWebhookUrl.length > 50 ? `${currentWebhookUrl.slice(0, 50)}…` : currentWebhookUrl}</span>
                                  ) : (
                                    <span className="italic">Webhook URL 설정…</span>
                                  )}
                                </button>
                              )}
                            </div>
                            {webhookErrors[member.id] ? (
                              <p className="text-xs text-destructive">{webhookErrors[member.id]}</p>
                            ) : null}
                          </div>
                          );
                        })
                      ) : (
                        <div className="rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                          {t('noProjectMembers')}
                        </div>
                      )}
                    </div>
                  </SectionCardBody>
                </SectionCard>
              </div>
              )}
            </TabsContent>

            {adminChecked && isAdmin ? (
            <TabsContent value="integrations">
              <div className="space-y-6">
                <SlackIntegrationSettingsSection />
                <SectionCard>
                  <SectionCardHeader>
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-foreground">{t('webhooks')}</h2>
                      <p className="text-sm text-muted-foreground">{t('webhookDescription')}</p>
                    </div>
                  </SectionCardHeader>
                  <SectionCardBody className="space-y-4">
                    <div className="space-y-2">
                      {webhooks.map((webhook) => (
                        <div key={webhook.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs">
                          <span className="truncate text-foreground">{webhook.url}</span>
                          <span className="shrink-0 text-muted-foreground">{webhook.projects?.name ?? t('defaultWebhook')}</span>
                        </div>
                      ))}
                    </div>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto]">
                      <OperatorInput
                        type="url"
                        value={newWebhookUrl}
                        onChange={(e) => setNewWebhookUrl(e.target.value)}
                        placeholder={t('webhookUrlPlaceholder')}
                      />
                      <OperatorDropdownSelect
                        value={newWebhookProjectId}
                        onValueChange={(v) => setNewWebhookProjectId(v)}
                        options={[
                          { value: '', label: t('defaultWebhook') },
                          ...projects.map((project) => ({ value: project.id, label: project.name })),
                        ]}
                      />
                      <Button
                        variant="hero"
                        size="lg"
                        onClick={async () => {
                          if (!newWebhookUrl.trim()) return;
                          await fetch('/api/webhooks/config', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: newWebhookUrl.trim(), project_id: newWebhookProjectId || null }),
                          });
                          setNewWebhookUrl('');
                          setNewWebhookProjectId('');
                          const res = await fetch('/api/webhooks/config');
                          if (res.ok) {
                            const j = await res.json();
                            setWebhooks(j.data ?? []);
                          }
                        }}
                      >
                        {tc('save')}
                      </Button>
                    </div>
                  </SectionCardBody>
                </SectionCard>
              </div>
            </TabsContent>
            ) : null}

            {adminChecked && isAdmin ? (
            <TabsContent value="workflow">
              <div className="space-y-6">
                <WorkflowTriggerTypesSection />
                {currentProjectId ? <WorkflowTemplateGallerySection projectId={currentProjectId} orgId={orgId ?? undefined} /> : null}
                {currentProjectId ? <WorkflowExecutionHistorySection projectId={currentProjectId} /> : null}
              </div>
            </TabsContent>
            ) : null}

            {adminChecked && isAdmin ? (
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
                    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                      {t('gracePeriodNotice', { date: new Date(graceUntil).toLocaleDateString('ko-KR') })}
                    </p>
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
                        }
                      } catch {
                        // noop
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
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
