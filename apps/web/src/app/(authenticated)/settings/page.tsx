'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bell, Bot, CreditCard, FolderKanban, Key, Palette, Trash2, User, Users, Zap } from 'lucide-react';
import { AgentApiKeysSection } from '@/components/settings/agent-api-keys-section';
import { AiSettingsSection } from '@/components/settings/ai-settings';
import { MyProfileSection } from '@/components/settings/my-profile-section';
import { ByomKeyManagement } from '@/components/settings/byom-key-management';
import { McpConnectionSettings } from '@/components/settings/mcp-connection-settings';
import { SlackIntegrationSettingsSection } from '@/components/settings/slack-integration-settings';
import { ThemeSettings } from '@/components/settings/theme-settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput, OperatorSelect } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

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
}

const EVENT_TYPES = ['story_assigned', 'memo_received', 'reward_granted', 'story_status_changed'];

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const router = useRouter();

  const [orgId, setOrgId] = useState<string | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projectMemberships, setProjectMemberships] = useState<Array<{ projectId: string; projectName: string }>>([]);
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
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deleteProjectConfirmId, setDeleteProjectConfirmId] = useState<string | null>(null);
  const [projectInviteEmail, setProjectInviteEmail] = useState('');
  const [projectInviteProjectId, setProjectInviteProjectId] = useState('');
  const [projectInviting, setProjectInviting] = useState(false);
  const [projectInviteResult, setProjectInviteResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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
      setIsAdmin(true);
      setAdminChecked(true);
      setInvitations(json.data ?? []);
      return;
    }

    if (res.status === 403) {
      setIsAdmin(false);
      setAdminChecked(true);
    }
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
      // Get current project
      const projectRes = await fetch('/api/current-project');
      if (projectRes.ok) {
        const projectJson = await projectRes.json();
        const projectId = projectJson?.data?.project_id ?? null;
        const orgId = projectJson?.data?.org_id ?? null;
        setCurrentProjectId(projectId);
        setOrgId(orgId);

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
    if (!isAdmin || !memberProjectId) return;
    void refreshMemberData(memberProjectId).catch(() => {});
  }, [isAdmin, memberProjectId]);

  const toggleSetting = async (eventType: string, currentEnabled: boolean) => {
    const newEnabled = !currentEnabled;
    await fetch('/api/notification-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'in_app', event_type: eventType, enabled: newEnabled }),
    });
    setSettings((prev) => {
      const existing = prev.find((s) => s.event_type === eventType && s.channel === 'in_app');
      if (existing) return prev.map((s) => (s.id === existing.id ? { ...s, enabled: newEnabled } : s));
      return [...prev, { id: `temp-${eventType}`, channel: 'in_app', event_type: eventType, enabled: newEnabled }];
    });
  };

  const getEnabled = (eventType: string) => {
    const setting = settings.find((s) => s.event_type === eventType && s.channel === 'in_app');
    return setting?.enabled ?? true;
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
    <div className="flex h-full">
      <Tabs defaultValue="profile" orientation="vertical" className="flex flex-1 min-h-0 gap-0">
        {/* Left nav */}
        <div className="w-52 shrink-0 border-r overflow-y-auto p-4">
          <h1 className="mb-4 px-2 text-sm font-semibold">{t('title')}</h1>
          <TabsList variant="line" className="w-full flex-col items-stretch">
            <span className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{t('myAccount')}</span>
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
                <span className="px-2 pb-1 pt-4 text-xs text-muted-foreground">{t('projectSettings')}</span>
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

            {adminChecked && isAdmin ? (
              <>
                <span className="px-2 pb-1 pt-4 text-xs text-muted-foreground truncate">{t('organizationSettings')}</span>
                <TabsTrigger value="projects">
                  <FolderKanban className="h-4 w-4" />
                  {t('tabProjects')}
                </TabsTrigger>
                <TabsTrigger value="members">
                  <Users className="h-4 w-4" />
                  {t('tabMembers')}
                </TabsTrigger>
                <TabsTrigger value="integrations">
                  <Zap className="h-4 w-4" />
                  {t('tabIntegrations')}
                </TabsTrigger>
                {process.env.NEXT_PUBLIC_OSS_MODE !== 'true' ? (
                  <TabsTrigger value="subscription">
                    <CreditCard className="h-4 w-4" />
                    {t('tabSubscription')}
                  </TabsTrigger>
                ) : null}
              </>
            ) : null}

            <span className="px-2 pb-1 pt-4 text-xs text-muted-foreground">{t('dangerZone')}</span>
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
          <div className="w-full max-w-3xl mx-auto p-6">

            <TabsContent value="profile">
              <MyProfileSection />
            </TabsContent>

            <TabsContent value="appearance">
              <ThemeSettings />
            </TabsContent>

            <TabsContent value="api-keys">
              {currentProjectId && isAdmin ? (
                <AgentApiKeysSection projectId={currentProjectId} />
              ) : null}
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
                    <div className="space-y-3">
                      {EVENT_TYPES.map((eventType) => (
                        <div key={eventType} className="flex items-center justify-between rounded-md border border-border bg-muted/30 p-3">
                          <span className="text-sm text-foreground">{t(`event_${eventType}`)}</span>
                          <button
                            onClick={() => toggleSetting(eventType, getEnabled(eventType))}
                            className={`relative h-6 w-11 rounded-full transition ${getEnabled(eventType) ? 'bg-primary' : 'bg-muted'}`}
                            type="button"
                          >
                            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${getEnabled(eventType) ? 'left-[22px]' : 'left-0.5'}`} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </SectionCardBody>
              </SectionCard>
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
              <div className="space-y-6">
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
                      <OperatorSelect value={inviteProjectId} onChange={(e) => setInviteProjectId(e.target.value)}>
                        <option value="">{t('orgWideInvite')}</option>
                        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                      </OperatorSelect>
                      <OperatorSelect value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}>
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </OperatorSelect>
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
                          <div key={invitation.id} className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs">
                            <span className="text-foreground">{invitation.email}</span>
                            <span className="shrink-0 text-muted-foreground">
                              {invitation.projects?.name ?? t('orgWide')}
                            </span>
                            <span className={`shrink-0 ${invitation.accepted_at ? 'text-emerald-300' : new Date(invitation.expires_at) < new Date() ? 'text-rose-300' : 'text-amber-200'}`}>
                              {invitation.accepted_at ? t('accepted') : new Date(invitation.expires_at) < new Date() ? t('expired') : t('pending')}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </SectionCardBody>
                </SectionCard>

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
                      <OperatorSelect value={projectInviteProjectId} onChange={(e) => setProjectInviteProjectId(e.target.value)}>
                        <option value="">{t('selectProject')}</option>
                        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                      </OperatorSelect>
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

                <SectionCard>
                  <SectionCardHeader>
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-foreground">{t('memberManagement')}</h2>
                      <p className="text-sm text-muted-foreground">{t('memberManagementDescription')}</p>
                    </div>
                  </SectionCardHeader>
                  <SectionCardBody className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_auto]">
                      <OperatorSelect value={memberProjectId} onChange={(e) => setMemberProjectId(e.target.value)}>
                        <option value="">{t('selectProject')}</option>
                        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                      </OperatorSelect>
                      <OperatorSelect value={selectedOrgMemberUserId} onChange={(e) => setSelectedOrgMemberUserId(e.target.value)} disabled={!memberProjectId || assignableMembers.length === 0}>
                        <option value="">{assignableMembers.length ? t('chooseMember') : t('noAssignableMembers')}</option>
                        {assignableMembers.map((member) => <option key={member.user_id} value={member.user_id ?? ''}>{member.name}</option>)}
                      </OperatorSelect>
                      <Button variant="hero" size="lg" onClick={handleAddProjectMember} disabled={!memberProjectId || !selectedOrgMemberUserId || addingMember}>
                        {addingMember ? '...' : t('addToProject')}
                      </Button>
                    </div>

                    {memberActionMessage ? (
                      <div className={`rounded-md border p-3 text-xs ${memberActionMessage.type === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-destructive/20 bg-destructive/10 text-destructive'}`}>
                        {memberActionMessage.text}
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('projectMembers')}</div>
                      {projectMembers.length > 0 ? (
                        projectMembers.map((member) => (
                          <div key={member.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
                            <div className="min-w-0">
                              <div className="font-medium text-foreground">{member.name}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <Badge variant={member.type === 'agent' ? 'secondary' : 'info'}>{member.type === 'agent' ? t('agentMember') : t('humanMember')}</Badge>
                                <Badge variant="outline">{member.role}</Badge>
                              </div>
                            </div>
                            <Button variant="glass" size="sm" onClick={() => handleRemoveProjectMember(member.id)} disabled={removingMemberId === member.id}>
                              {removingMemberId === member.id ? '...' : t('removeFromProject')}
                            </Button>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                          {t('noProjectMembers')}
                        </div>
                      )}
                    </div>
                  </SectionCardBody>
                </SectionCard>
              </div>
            </TabsContent>

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
                      <OperatorSelect value={newWebhookProjectId} onChange={(e) => setNewWebhookProjectId(e.target.value)}>
                        <option value="">{t('defaultWebhook')}</option>
                        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                      </OperatorSelect>
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

            {process.env.NEXT_PUBLIC_OSS_MODE !== 'true' ? (
              <TabsContent value="subscription">
                <SectionCard>
                  <SectionCardHeader>
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-foreground">{t('manageSubscription')}</h2>
                      <p className="text-sm text-muted-foreground">{t('subscriptionDescription')}</p>
                    </div>
                  </SectionCardHeader>
                  <SectionCardBody>
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
    </div>
  );
}
