'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Loader2, MessageSquareShare, RefreshCcw, Search } from 'lucide-react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GlassPanel } from '@/components/ui/glass-panel';
import { OperatorInput, OperatorSelect } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { ToastContainer, useToast } from '@/components/ui/toast';

interface SlackProjectOption {
  id: string;
  name: string;
}

interface SlackChannelOption {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  member_count: number | null;
}

interface SlackChannelMapping {
  id: string;
  channel_id: string;
  channel_name: string;
  project_id: string;
  project_name: string;
}

interface SlackIntegrationPayload {
  status: 'disconnected' | 'connected' | 'channel_fetch_error';
  connect_url: string | null;
  workspace: {
    team_name: string;
    team_id: string;
    bot_user_id: string | null;
  } | null;
  channels: SlackChannelOption[];
  projects: SlackProjectOption[];
  mappings: SlackChannelMapping[];
  error: { code: string; message: string } | null;
}

interface RemapConflict {
  channelId: string;
  channelName: string;
  targetProjectId: string;
  existingProjectName: string;
}

const EMPTY_STATE: SlackIntegrationPayload = {
  status: 'disconnected',
  connect_url: null,
  workspace: null,
  channels: [],
  projects: [],
  mappings: [],
  error: null,
};

export function SlackIntegrationSettingsSection() {
  const t = useTranslations('settings.slackIntegration');
  const tc = useTranslations('common');
  const { projectId: currentProjectId } = useDashboardContext();
  const { toasts, addToast, dismissToast } = useToast();
  const [data, setData] = useState<SlackIntegrationPayload>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<Record<string, string>>({});
  const [initialProjects, setInitialProjects] = useState<Record<string, string>>({});
  const [remapConflict, setRemapConflict] = useState<RemapConflict | null>(null);

  const mappingIndex = useMemo(() => Object.fromEntries(data.mappings.map((mapping) => [mapping.channel_id, mapping])), [data.mappings]);
  const projectsById = useMemo(() => Object.fromEntries(data.projects.map((project) => [project.id, project])), [data.projects]);
  const currentProjectName = currentProjectId ? projectsById[currentProjectId]?.name ?? null : null;

  const hydrateSelections = (nextData: SlackIntegrationPayload) => {
    const mappingState = Object.fromEntries(nextData.mappings.map((mapping) => [mapping.channel_id, mapping.project_id]));
    setInitialProjects(mappingState);
    setSelectedProjects(mappingState);
  };

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/settings/slack-integration', { cache: 'no-store' });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error?.message ?? t('loadFailed'));
      const nextData = (json.data ?? EMPTY_STATE) as SlackIntegrationPayload;
      setData(nextData);
      hydrateSelections(nextData);
    } catch (error) {
      addToast({ title: t('loadFailedTitle'), body: error instanceof Error ? error.message : t('loadFailed'), type: 'warning' });
      setData({ ...EMPTY_STATE, status: 'channel_fetch_error', error: { code: 'load_failed', message: t('loadFailed') } });
      hydrateSelections(EMPTY_STATE);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredChannels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return data.channels;
    return data.channels.filter((channel) => {
      const mappedProject = mappingIndex[channel.id]?.project_name ?? '';
      return channel.name.toLowerCase().includes(query) || mappedProject.toLowerCase().includes(query);
    });
  }, [data.channels, mappingIndex, search]);

  const allDirtyChannels = useMemo(() => {
    return Object.entries(selectedProjects)
      .filter(([channelId, projectId]) => Boolean(projectId) && (initialProjects[channelId] ?? '') !== projectId)
      .map(([channelId]) => channelId);
  }, [initialProjects, selectedProjects]);

  const upsertMapping = (mapping: { channel_id: string; channel_name: string; project_id: string; project_name: string; id: string }) => {
    setData((prev) => {
      const nextMappings = prev.mappings.some((item) => item.channel_id === mapping.channel_id)
        ? prev.mappings.map((item) => (item.channel_id === mapping.channel_id ? mapping : item))
        : [...prev.mappings, mapping];
      return { ...prev, mappings: nextMappings };
    });
    setInitialProjects((prev) => ({ ...prev, [mapping.channel_id]: mapping.project_id }));
    setSelectedProjects((prev) => ({ ...prev, [mapping.channel_id]: mapping.project_id }));
  };

  const saveChannel = async (channelId: string, forceRemap = false) => {
    const projectId = selectedProjects[channelId];
    const channel = data.channels.find((item) => item.id === channelId);
    if (!projectId || !channel) return { ok: false } as const;

    const response = await fetch('/api/settings/slack-integration', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: channel.id,
        channel_name: channel.name,
        project_id: projectId,
        force_remap: forceRemap,
      }),
    });

    const json = await response.json();

    if (response.status === 409) {
      setRemapConflict({
        channelId: channel.id,
        channelName: channel.name,
        targetProjectId: projectId,
        existingProjectName: json?.data?.existing_project_name ?? t('unknownProject'),
      });
      return { ok: false, conflict: true } as const;
    }

    if (!response.ok) {
      throw new Error(json?.error?.message ?? t('saveFailed'));
    }

    upsertMapping(json.data as { channel_id: string; channel_name: string; project_id: string; project_name: string; id: string });
    return { ok: true } as const;
  };

  const handleSaveAll = async () => {
    if (allDirtyChannels.length === 0) return;
    setSaving(true);
    try {
      for (const channelId of allDirtyChannels) {
        const result = await saveChannel(channelId);
        if ('conflict' in result && result.conflict) {
          return;
        }
      }

      addToast({
        title: t('savedTitle'),
        body: t('savedBody', { count: allDirtyChannels.length }),
        type: 'success',
      });
      await load();
    } catch (error) {
      addToast({ title: t('saveFailedTitle'), body: error instanceof Error ? error.message : t('saveFailed'), type: 'warning' });
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmRemap = async () => {
    if (!remapConflict) return;
    setSaving(true);
    try {
      await saveChannel(remapConflict.channelId, true);
      addToast({
        title: t('remapSuccessTitle'),
        body: t('remapSuccessBody', { channel: remapConflict.channelName, project: projectsById[remapConflict.targetProjectId]?.name ?? t('unknownProject') }),
        type: 'success',
      });
      setRemapConflict(null);
      await load();
    } catch (error) {
      addToast({ title: t('saveFailedTitle'), body: error instanceof Error ? error.message : t('saveFailed'), type: 'warning' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SectionCard>
        <SectionCardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <MessageSquareShare className="size-4 text-[color:var(--operator-primary-soft)]" />
                <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('title')}</h2>
              </div>
              <p className="text-sm text-[color:var(--operator-muted)]">{t('description')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={data.status === 'connected' ? 'success' : data.status === 'channel_fetch_error' ? 'destructive' : 'outline'}>
                {data.status === 'connected' ? t('statusConnected') : data.status === 'channel_fetch_error' ? t('statusFetchError') : t('statusDisconnected')}
              </Badge>
              {currentProjectName ? <Badge variant="chip">{t('currentProject', { project: currentProjectName })}</Badge> : null}
            </div>
          </div>
        </SectionCardHeader>
        <SectionCardBody className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_360px]">
            <GlassPanel className="overflow-hidden border-white/8 bg-[color:var(--operator-surface-soft)]/40">
              <div className="border-b border-white/8 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-[0.24em] text-[color:var(--operator-muted)]">{t('workspaceLabel')}</p>
                    <h3 className="text-lg font-semibold text-[color:var(--operator-foreground)]">
                      {data.workspace?.team_name ?? t('workspaceDisconnected')}
                    </h3>
                    <p className="text-sm text-[color:var(--operator-muted)]">
                      {data.workspace?.team_id ? t('workspaceConnectedSummary', { teamId: data.workspace.team_id }) : t('workspaceDisconnectedSummary')}
                    </p>
                  </div>
                  <Button
                    variant="hero"
                    size="lg"
                    disabled={!data.connect_url}
                    onClick={() => {
                      if (data.connect_url) window.location.href = data.connect_url;
                    }}
                  >
                    <MessageSquareShare className="mr-2 size-4" />
                    {data.status === 'connected' ? t('manageConnection') : t('connectCta')}
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 px-5 py-4 sm:grid-cols-3">
                <div className="rounded-2xl border border-white/8 bg-black/10 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('metricChannels')}</p>
                  <p className="mt-2 text-2xl font-semibold text-[color:var(--operator-foreground)]">{data.channels.length}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-black/10 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('metricMapped')}</p>
                  <p className="mt-2 text-2xl font-semibold text-[color:var(--operator-foreground)]">{data.mappings.length}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-black/10 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('metricDirty')}</p>
                  <p className="mt-2 text-2xl font-semibold text-[color:var(--operator-foreground)]">{allDirtyChannels.length}</p>
                </div>
              </div>
            </GlassPanel>

            <GlassPanel className="border-white/8 bg-[color:var(--operator-surface-soft)]/40 p-5">
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-[color:var(--operator-foreground)]">
                  <CheckCircle2 className="size-4 text-emerald-300" />
                  {t('actionPanelTitle')}
                </div>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('actionPanelDescription')}</p>
                <Button variant="hero" size="lg" className="w-full" disabled={allDirtyChannels.length === 0 || saving} onClick={() => void handleSaveAll()}>
                  {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  {allDirtyChannels.length > 0 ? t('savePending', { count: allDirtyChannels.length }) : t('saveIdle')}
                </Button>
                <Button variant="glass" size="lg" className="w-full" onClick={() => void load()} disabled={loading}>
                  {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCcw className="mr-2 size-4" />}
                  {t('refresh')}
                </Button>
                <div className="rounded-2xl border border-white/8 bg-black/10 px-4 py-3 text-xs text-[color:var(--operator-muted)]">
                  {t('helperText')}
                </div>
              </div>
            </GlassPanel>
          </div>

          {data.status === 'channel_fetch_error' ? (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">{t('fetchErrorTitle')}</p>
                  <p className="text-amber-100/80">{data.error?.message ?? t('fetchErrorBody')}</p>
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <label className="relative block w-full md:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--operator-muted)]" />
              <OperatorInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('searchPlaceholder')} className="pl-9" />
            </label>
            <p className="text-xs text-[color:var(--operator-muted)]">{t('resultCount', { count: filteredChannels.length })}</p>
          </div>

          {loading ? (
            <div className="grid gap-3">
              {[1, 2, 3].map((item) => (
                <div key={item} className="h-28 animate-pulse rounded-3xl border border-white/8 bg-[color:var(--operator-surface-soft)]/45" />
              ))}
            </div>
          ) : data.status === 'disconnected' ? (
            <GlassPanel className="border-dashed border-white/14 bg-[color:var(--operator-surface-soft)]/28 p-6 text-center">
              <MessageSquareShare className="mx-auto size-9 text-[color:var(--operator-primary-soft)]" />
              <h3 className="mt-4 text-lg font-semibold text-[color:var(--operator-foreground)]">{t('disconnectedTitle')}</h3>
              <p className="mx-auto mt-2 max-w-2xl text-sm text-[color:var(--operator-muted)]">{t('disconnectedBody')}</p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <Button variant="hero" size="lg" disabled={!data.connect_url} onClick={() => data.connect_url && (window.location.href = data.connect_url)}>
                  <MessageSquareShare className="mr-2 size-4" />
                  {t('connectCta')}
                </Button>
                <Button variant="glass" size="lg" onClick={() => void load()}>
                  <RefreshCcw className="mr-2 size-4" />
                  {t('refresh')}
                </Button>
              </div>
            </GlassPanel>
          ) : filteredChannels.length === 0 ? (
            <GlassPanel className="border-dashed border-white/14 bg-[color:var(--operator-surface-soft)]/28 p-6 text-center">
              <MessageSquareShare className="mx-auto size-9 text-[color:var(--operator-primary-soft)]" />
              <h3 className="mt-4 text-lg font-semibold text-[color:var(--operator-foreground)]">{t('emptyTitle')}</h3>
              <p className="mx-auto mt-2 max-w-2xl text-sm text-[color:var(--operator-muted)]">{t('emptyBody')}</p>
            </GlassPanel>
          ) : (
            <div className="grid gap-3">
              {filteredChannels.map((channel) => {
                const currentMapping = mappingIndex[channel.id] ?? null;
                const selectedProjectId = selectedProjects[channel.id] ?? currentMapping?.project_id ?? '';
                const selectedProjectName = selectedProjectId ? projectsById[selectedProjectId]?.name ?? t('unknownProject') : null;
                const isDirty = Boolean(selectedProjectId) && selectedProjectId !== (initialProjects[channel.id] ?? '');
                const mappedElsewhere = Boolean(currentProjectId && currentMapping?.project_id && currentMapping.project_id !== currentProjectId);

                return (
                  <GlassPanel key={channel.id} className="border-white/8 bg-[color:var(--operator-surface-soft)]/42 p-4">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">#{channel.name}</h3>
                          {channel.is_private ? <Badge variant="outline">{t('privateBadge')}</Badge> : <Badge variant="outline">{t('publicBadge')}</Badge>}
                          {channel.is_member ? <Badge variant="success">{t('joinedBadge')}</Badge> : <Badge variant="outline">{t('notJoinedBadge')}</Badge>}
                          {mappedElsewhere ? <Badge variant="info">{t('mappedElsewhereBadge')}</Badge> : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-[color:var(--operator-muted)]">
                          <span>{t('channelId', { id: channel.id })}</span>
                          {channel.member_count ? <span>{t('memberCount', { count: channel.member_count })}</span> : null}
                        </div>
                        <div className="rounded-2xl border border-white/8 bg-black/10 px-3 py-3 text-sm">
                          <p className="text-[color:var(--operator-muted)]">{t('mappedProjectLabel')}</p>
                          <p className="mt-1 font-medium text-[color:var(--operator-foreground)]">{currentMapping?.project_name ?? t('unmapped')}</p>
                        </div>
                      </div>

                      <div className="grid flex-1 gap-3 xl:max-w-xl xl:grid-cols-[minmax(0,1fr)_auto]">
                        <div className="space-y-2">
                          <label className="text-xs uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('selectProjectLabel')}</label>
                          <OperatorSelect
                            value={selectedProjectId}
                            onChange={(event) => setSelectedProjects((prev) => ({ ...prev, [channel.id]: event.target.value }))}
                          >
                            <option value="">{t('selectProjectPlaceholder')}</option>
                            {data.projects.map((project) => (
                              <option key={project.id} value={project.id}>{project.name}</option>
                            ))}
                          </OperatorSelect>
                        </div>
                        <div className="flex items-end">
                          <Button
                            variant={isDirty ? 'hero' : 'glass'}
                            size="lg"
                            className="w-full xl:min-w-[136px]"
                            disabled={!selectedProjectId || saving}
                            onClick={async () => {
                              setSaving(true);
                              try {
                                const result = await saveChannel(channel.id);
                                if (!('conflict' in result && result.conflict)) {
                                  addToast({
                                    title: t('savedSingleTitle'),
                                    body: t('savedSingleBody', { channel: `#${channel.name}`, project: selectedProjectName ?? t('unknownProject') }),
                                    type: 'success',
                                  });
                                  await load();
                                }
                              } catch (error) {
                                addToast({ title: t('saveFailedTitle'), body: error instanceof Error ? error.message : t('saveFailed'), type: 'warning' });
                              } finally {
                                setSaving(false);
                              }
                            }}
                          >
                            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                            {isDirty ? t('saveRow') : t('saveLabel')}
                          </Button>
                        </div>
                        {mappedElsewhere ? (
                          <div className="xl:col-span-2 rounded-2xl border border-[color:var(--operator-primary)]/18 bg-[color:var(--operator-primary)]/10 px-3 py-3 text-sm text-[color:var(--operator-primary-soft)]">
                            {t('mappedElsewhereHint', { project: currentMapping?.project_name ?? t('unknownProject') })}
                          </div>
                        ) : null}
                        {isDirty ? (
                          <div className="xl:col-span-2 rounded-2xl border border-amber-400/16 bg-amber-400/10 px-3 py-3 text-sm text-amber-100">
                            {t('pendingHint', { project: selectedProjectName ?? t('unknownProject') })}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </GlassPanel>
                );
              })}
            </div>
          )}
        </SectionCardBody>
      </SectionCard>

      {allDirtyChannels.length > 0 ? (
        <div className="fixed inset-x-3 bottom-24 z-40 sm:bottom-6 lg:static lg:inset-auto lg:z-auto">
          <GlassPanel className="border-[color:var(--operator-primary)]/20 bg-[color:var(--operator-panel)]/92 p-3 shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('stickyBarTitle', { count: allDirtyChannels.length })}</p>
                <p className="text-xs text-[color:var(--operator-muted)]">{t('stickyBarBody')}</p>
              </div>
              <Button variant="hero" size="lg" disabled={saving} onClick={() => void handleSaveAll()}>
                {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                {t('savePending', { count: allDirtyChannels.length })}
              </Button>
            </div>
          </GlassPanel>
        </div>
      ) : null}

      <Dialog open={Boolean(remapConflict)} onOpenChange={(open) => { if (!open) setRemapConflict(null); }}>
        <DialogContent className="max-w-lg rounded-3xl border border-white/10 bg-[color:var(--operator-panel)] text-[color:var(--operator-foreground)] shadow-[0_30px_80px_rgba(0,0,0,0.42)]">
          <DialogHeader>
            <DialogTitle>{t('remapDialogTitle')}</DialogTitle>
            <DialogDescription className="text-[color:var(--operator-muted)]">
              {remapConflict ? t('remapDialogBody', { channel: `#${remapConflict.channelName}`, project: remapConflict.existingProjectName }) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-2xl border border-amber-400/16 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>{t('remapDialogWarning')}</p>
            </div>
          </div>
          <DialogFooter className="border-t border-white/8 bg-transparent">
            <Button variant="glass" onClick={() => setRemapConflict(null)}>{tc('cancel')}</Button>
            <Button variant="hero" onClick={() => void handleConfirmRemap()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {t('confirmRemap')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
