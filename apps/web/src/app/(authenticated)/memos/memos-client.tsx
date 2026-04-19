'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronLeft, Menu, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { MemoList } from '@/components/memos/memo-list';
import { MemoDetail } from '@/components/memos/memo-detail';
import { MemoCreateForm } from '@/components/memos/memo-create-form';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { ContextualPanelLayout, useContextualPanelState } from '@/components/ui/contextual-panel-layout';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { mergeMemoDetailIntoList, summarizeMemo, type MemoDetailState, type MemoReply, type MemoSummaryState } from '@/components/memos/memo-state';
import { useRealtimeMemos } from '@/hooks/use-realtime-memos';
import { useMemoRefreshGuard } from '@/hooks/use-memo-refresh-guard';
import {
  countMemoChannelMatches,
  countUnreadMemoMatches,
  createMemoDraftStorageKey,
  createMemoWorkspaceStorageKey,
  filterMemoSummaries,
  normalizeMemoChannelId,
  parseMemoWorkspaceSnapshot,
  serializeMemoWorkspaceSnapshot,
  type MemoChannelId,
  type MemoWorkspaceView,
} from '@/components/memos/memo-workspace';

interface Member {
  id: string;
  name: string;
  type: string;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

type WorkspaceChannel = MemoChannelId;

interface MemosClientProps {
  currentTeamMemberId: string;
  projectId?: string;
}

const CHANNEL_ORDER: WorkspaceChannel[] = ['inbox', 'assigned', 'created', 'open', 'resolved', 'requests', 'decisions', 'tasks', 'all'];

type WorkspaceSearchParams = Pick<URLSearchParams, 'get' | 'has'>;

interface WorkspaceQueryState {
  channel: WorkspaceChannel;
  search: string;
  unreadOnly: boolean;
  activeViewId: string | null;
  showCreate: boolean;
}

function readWorkspaceQueryState(searchParams: WorkspaceSearchParams): WorkspaceQueryState {
  return {
    channel: normalizeMemoChannelId(searchParams.get('channel'), 'inbox'),
    search: searchParams.get('q') ?? '',
    unreadOnly: searchParams.get('unread') === '1' || searchParams.get('unread') === 'true',
    activeViewId: searchParams.get('view'),
    showCreate: searchParams.get('action') === 'create',
  };
}

function getWorkspaceQuerySignature(searchParams: WorkspaceSearchParams) {
  return [
    `channel=${searchParams.get('channel') ?? ''}`,
    `q=${searchParams.get('q') ?? ''}`,
    `view=${searchParams.get('view') ?? ''}`,
    `unread=${searchParams.get('unread') ?? ''}`,
    `action=${searchParams.get('action') ?? ''}`,
  ].join('&');
}

export function MemosClient({ currentTeamMemberId, projectId }: MemosClientProps) {
  const t = useTranslations('memos');
  const tc = useTranslations('common');
  const router = useRouter();
  const searchParams = useSearchParams();

  const queryChannel = searchParams.get('channel');
  const querySearch = searchParams.get('q');
  const queryViewId = searchParams.get('view');
  const queryUnreadOnly = searchParams.get('unread');
  const queryShowCreate = searchParams.get('action') === 'create';
  const queryProjectFilter = searchParams.get('project_filter');

  const [memos, setMemos] = useState<MemoSummaryState[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedMemo, setSelectedMemo] = useState<MemoDetailState | null>(null);
  const [channel, setChannel] = useState<WorkspaceChannel>(normalizeMemoChannelId(queryChannel, 'inbox'));
  const [searchQuery, setSearchQuery] = useState(querySearch ?? '');
  const [unreadOnly, setUnreadOnly] = useState(queryUnreadOnly === '1' || queryUnreadOnly === 'true');
  const [savedViews, setSavedViews] = useState<MemoWorkspaceView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(queryViewId);
  const [showCreate, setShowCreate] = useState(queryShowCreate);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [convertForm, setConvertForm] = useState<{ memoId: string; title: string; description: string } | null>(null);
  const [showSaveViewForm, setShowSaveViewForm] = useState(false);
  const [selectedProjectFilter, setSelectedProjectFilter] = useState<string | 'all'>(queryProjectFilter ?? 'all');
  const [saveViewDraftName, setSaveViewDraftName] = useState('');
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>(searchParams.get('id') ? 'detail' : 'list');

  const selectedMemoIdRef = useRef(selectedMemo?.id);
  const loadedWorkspaceKeyRef = useRef<string | null>(null);
  const lastSyncedWorkspaceQueryRef = useRef<string | null>(null);
  const { clear, suppress, shouldIgnore } = useMemoRefreshGuard();

  const workspaceStorageKey = useMemo(() => createMemoWorkspaceStorageKey(projectId, currentTeamMemberId), [projectId, currentTeamMemberId]);
  const draftStorageKey = useMemo(() => createMemoDraftStorageKey(projectId, currentTeamMemberId), [projectId, currentTeamMemberId]);
  const memoQueueStorageKey = useMemo(() => `memos:queue-panel:${projectId ?? 'no-project'}:${currentTeamMemberId}`, [currentTeamMemberId, projectId]);
  const memoQueuePanel = useContextualPanelState({ storageKey: memoQueueStorageKey, defaultOpen: true });
  const {
    supportsInlinePanel: memoQueueSupportsInlinePanel,
    inlinePanelOpen: memoQueueInlinePanelOpen,
    drawerOpen: memoQueueDrawerOpen,
    setDrawerOpen: setMemoQueueDrawerOpen,
    openPanel: openMemoQueuePanel,
    closeDrawer: closeMemoQueueDrawer,
    togglePanel: toggleMemoQueuePanel,
  } = memoQueuePanel;
  const autoOpenedQueueRef = useRef(false);

  useEffect(() => {
    selectedMemoIdRef.current = selectedMemo?.id;
  }, [selectedMemo?.id]);

  useEffect(() => {
    autoOpenedQueueRef.current = false;
  }, [projectId]);

  const memberMap = useMemo(() => Object.fromEntries(members.map((member) => [member.id, member.name])), [members]);
  const currentTeamMemberName = memberMap[currentTeamMemberId];
  const selectedView = useMemo(() => savedViews.find((view) => view.id === activeViewId) ?? null, [activeViewId, savedViews]);

  useEffect(() => {
    if (!workspaceStorageKey) {
      loadedWorkspaceKeyRef.current = null;
      lastSyncedWorkspaceQueryRef.current = getWorkspaceQuerySignature(searchParams);
      setWorkspaceReady(true);
      return;
    }

    if (loadedWorkspaceKeyRef.current === workspaceStorageKey) return;
    loadedWorkspaceKeyRef.current = workspaceStorageKey;
    setWorkspaceReady(false);

    let snapshot = null;
    try {
      snapshot = parseMemoWorkspaceSnapshot(window.localStorage.getItem(workspaceStorageKey));
    } catch {
      snapshot = null;
    }

    const nextSavedViews = snapshot?.savedViews ?? [];
    const nextViewId = queryViewId ?? snapshot?.activeViewId ?? null;
    const hasWorkspaceQuery = searchParams.has('channel') || searchParams.has('q') || searchParams.has('view') || searchParams.has('unread') || searchParams.has('action');

    let nextChannel = snapshot?.channel ?? 'inbox';
    let nextSearch = snapshot?.search ?? '';
    let nextUnreadOnly = snapshot?.unreadOnly ?? false;
    let nextActiveViewId = snapshot?.activeViewId ?? null;

    if (snapshot?.activeViewId) {
      const matchedSnapshotView = nextSavedViews.find((view) => view.id === snapshot.activeViewId);
      if (matchedSnapshotView) {
        nextChannel = matchedSnapshotView.channel;
        nextSearch = matchedSnapshotView.search;
        nextUnreadOnly = matchedSnapshotView.unreadOnly;
      }
    }

    if (searchParams.has('channel')) {
      nextChannel = normalizeMemoChannelId(queryChannel, nextChannel);
    }
    if (searchParams.has('q')) {
      nextSearch = querySearch ?? '';
    }
    if (searchParams.has('unread')) {
      nextUnreadOnly = queryUnreadOnly === '1' || queryUnreadOnly === 'true';
    }

    if (searchParams.has('view')) {
      const matchedView = nextSavedViews.find((view) => view.id === nextViewId);
      if (matchedView) {
        nextChannel = matchedView.channel;
        nextSearch = matchedView.search;
        nextUnreadOnly = matchedView.unreadOnly;
        nextActiveViewId = matchedView.id;
      } else {
        nextActiveViewId = null;
      }
    } else if (hasWorkspaceQuery) {
      nextActiveViewId = null;
    }

    setSavedViews(nextSavedViews);
    setChannel(nextChannel);
    setSearchQuery(nextSearch);
    setUnreadOnly(nextUnreadOnly);
    setActiveViewId(nextActiveViewId && nextSavedViews.some((view) => view.id === nextActiveViewId) ? nextActiveViewId : null);
    setShowCreate(queryShowCreate);
    setWorkspaceReady(true);
    lastSyncedWorkspaceQueryRef.current = getWorkspaceQuerySignature(searchParams);
  }, [queryChannel, querySearch, queryShowCreate, queryUnreadOnly, queryViewId, searchParams, workspaceStorageKey]);

  useEffect(() => {
    if (!workspaceReady || !workspaceStorageKey) return;

    const snapshot = {
      version: 1 as const,
      activeViewId,
      channel,
      search: searchQuery,
      unreadOnly,
      savedViews,
    };

    try {
      window.localStorage.setItem(workspaceStorageKey, serializeMemoWorkspaceSnapshot(snapshot));
    } catch {
      // ignore storage errors
    }
  }, [activeViewId, channel, searchQuery, unreadOnly, savedViews, workspaceReady, workspaceStorageKey]);

  useEffect(() => {
    if (!workspaceReady || !projectId) return;

    const params = new URLSearchParams(searchParams.toString());
    params.set('channel', channel);

    if (searchQuery.trim()) params.set('q', searchQuery.trim());
    else params.delete('q');

    if (unreadOnly) params.set('unread', '1');
    else params.delete('unread');

    if (activeViewId) params.set('view', activeViewId);
    else params.delete('view');

    if (showCreate) params.set('action', 'create');
    else params.delete('action');

    const nextQueryKey = getWorkspaceQuerySignature(params);
    const currentQueryKey = getWorkspaceQuerySignature(searchParams);
    if (nextQueryKey === currentQueryKey || nextQueryKey === lastSyncedWorkspaceQueryRef.current) return;

    lastSyncedWorkspaceQueryRef.current = nextQueryKey;
    router.replace(nextQueryKey ? `/memos?${params.toString()}` : '/memos', { scroll: false });
  }, [activeViewId, channel, projectId, router, searchParams, searchQuery, showCreate, unreadOnly, workspaceReady]);

  useEffect(() => {
    if (!workspaceReady || !projectId) return;

    const nextQueryKey = getWorkspaceQuerySignature(searchParams);
    if (nextQueryKey === lastSyncedWorkspaceQueryRef.current) return;

    const queryState = readWorkspaceQueryState(searchParams);
    const matchedView = queryState.activeViewId ? savedViews.find((view) => view.id === queryState.activeViewId) ?? null : null;

    let nextChannel = queryState.channel;
    let nextSearch = queryState.search;
    let nextUnreadOnly = queryState.unreadOnly;

    if (matchedView) {
      nextChannel = matchedView.channel;
      nextSearch = matchedView.search;
      nextUnreadOnly = matchedView.unreadOnly;
    }

    setChannel(nextChannel);
    setSearchQuery(nextSearch);
    setUnreadOnly(nextUnreadOnly);
    setActiveViewId(matchedView ? matchedView.id : null);
    setShowCreate(queryState.showCreate);
    lastSyncedWorkspaceQueryRef.current = nextQueryKey;
  }, [projectId, savedViews, searchParams, workspaceReady]);

  const fetchMemos = useCallback(async (options?: { background?: boolean; cursor?: string | null; append?: boolean; query?: string }) => {
    if (!options?.background) {
      setLoading(true);
      setFetchError('');
    }

    try {
      const params = new URLSearchParams();
      params.set('limit', '30');

      // Workspace view vs Project view
      if (selectedProjectFilter !== 'all') {
        params.set('project_id', selectedProjectFilter);
      }
      // If 'all', don't set project_id - API will return workspace-wide memos

      const query = options?.query ?? searchQuery.trim();
      if (query) params.set('q', query);
      if (options?.cursor) params.set('cursor', options.cursor);

      const res = await fetch(`/api/memos?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load memos');

      const json = await res.json();
      const data = Array.isArray(json.data) ? json.data as MemoSummaryState[] : [];
      setMemos((prev) => (options?.append ? [...prev, ...data] : data));
      setNextCursor(json.meta?.nextCursor ?? null);
    } catch (error) {
      console.error('[Memos] fetch error:', error);
      setFetchError(t('fetchError'));
    } finally {
      if (!options?.background) setLoading(false);
    }
  }, [selectedProjectFilter, searchQuery, t]);

  const fetchMembers = useCallback(async () => {
    if (!projectId) return;

    const res = await fetch(`/api/team-members?project_id=${projectId}`);
    if (!res.ok) return;

    const json = await res.json();
    setMembers(Array.isArray(json.data) ? json.data : []);
  }, [projectId]);

  const fetchProjects = useCallback(async () => {
    const res = await fetch('/api/projects');
    if (!res.ok) return;

    const json = await res.json();
    setProjects(Array.isArray(json.data) ? json.data : []);
  }, []);

  const visibleMemos = useMemo(() => filterMemoSummaries(memos, {
    channel,
    search: searchQuery,
    unreadOnly,
    currentTeamMemberId,
    memberNameLookup: (memberId) => memberMap[memberId],
  }), [channel, currentTeamMemberId, memberMap, memos, searchQuery, unreadOnly]);

  const channelCounts = useMemo(() => countMemoChannelMatches(memos, currentTeamMemberId), [currentTeamMemberId, memos]);
  const unreadCount = useMemo(() => countUnreadMemoMatches(memos, currentTeamMemberId), [currentTeamMemberId, memos]);

  const stats = useMemo(() => ({
    open: memos.filter((memo) => memo.status === 'open').length,
    assigned: memos.filter((memo) => memo.assigned_to === currentTeamMemberId).length,
    replies: memos.reduce((acc, memo) => acc + (memo.reply_count ?? 0), 0),
    views: savedViews.length,
  }), [currentTeamMemberId, memos, savedViews]);

  const handleMemoChange = useCallback((updatedMemo: MemoDetailState) => {
    setSelectedMemo(updatedMemo);
    setMemos((prev) => mergeMemoDetailIntoList(prev, updatedMemo));
  }, []);

  const selectMemoById = useCallback(async (memoId: string, options?: { updateUrl?: boolean }) => {
    const res = await fetch(`/api/memos/${memoId}`);
    if (!res.ok) return;

    const json = await res.json();
    setSelectedMemo(json.data);
    setMemos((prev) => (
      prev.some((item) => item.id === json.data.id)
        ? mergeMemoDetailIntoList(prev, json.data)
        : [summarizeMemo(json.data), ...prev]
    ));

    if (options?.updateUrl) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('id', memoId);
      const nextQuery = params.toString();
      if (nextQuery !== searchParams.toString()) {
        router.replace(`/memos?${nextQuery}`, { scroll: false });
      }
    }
  }, [router, searchParams]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Fetch memos for workspace view (no projectId) or project view (with projectId)
      await Promise.all([fetchMemos({ query: searchQuery.trim() }), fetchMembers(), fetchProjects()]);
      if (!cancelled) setFetchError('');
    })().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [fetchMemos, fetchMembers, fetchProjects, projectId, searchQuery]);

  useEffect(() => {
    if (memoQueueSupportsInlinePanel || memoQueueDrawerOpen || loading || autoOpenedQueueRef.current) return;
    if (selectedMemo || visibleMemos.length === 0) return;

    autoOpenedQueueRef.current = true;
    openMemoQueuePanel();
  }, [loading, memoQueueDrawerOpen, memoQueueSupportsInlinePanel, openMemoQueuePanel, selectedMemo, visibleMemos.length]);

  useRealtimeMemos({
    currentTeamMemberId,
    onNewMemo: useCallback(async () => {
      await fetchMemos({ background: true });
    }, [fetchMemos]),
    onNewReply: useCallback(async (reply: { id: string; memo_id: string; created_by: string | null; created_at: string }) => {
      if (reply.created_by === currentTeamMemberId && shouldIgnore(reply.memo_id)) return;
      await fetchMemos({ background: true });
      if (selectedMemoIdRef.current === reply.memo_id) {
        await selectMemoById(reply.memo_id, { updateUrl: false });
      }
    }, [currentTeamMemberId, fetchMemos, selectMemoById, shouldIgnore]),
    onMemoUpdated: useCallback(async (memo: { id: string }) => {
      if (shouldIgnore(memo.id)) return;
      await fetchMemos({ background: true });
      if (selectedMemoIdRef.current === memo.id) {
        await selectMemoById(memo.id, { updateUrl: false });
      }
    }, [fetchMemos, selectMemoById, shouldIgnore]),
  });

  useEffect(() => {
    const deepId = searchParams.get('id');
    if (!deepId || selectedMemo?.id === deepId || memos.length === 0) return;

    const target = memos.find((memo) => memo.id === deepId);

    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await selectMemoById(target?.id ?? deepId, { updateUrl: false });
      if (!cancelled) setMobileView('detail');
    })().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [memos, searchParams, selectedMemo?.id, selectMemoById]);

  const handleSelectMemo = useCallback(async (memo: MemoSummaryState) => {
    await selectMemoById(memo.id, { updateUrl: true });
    setMobileView('detail');
    if (!memoQueueSupportsInlinePanel) {
      closeMemoQueueDrawer();
    }
  }, [closeMemoQueueDrawer, memoQueueSupportsInlinePanel, selectMemoById]);

  const handleReply = useCallback(async (memoId: string, content: string) => {
    suppress(memoId);
    try {
      const res = await fetch(`/api/memos/${memoId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        clear(memoId);
        return null;
      }
      const json = await res.json();
      return json.data as MemoReply | null;
    } catch {
      clear(memoId);
      return null;
    }
  }, [clear, suppress]);

  const handleResolve = useCallback(async (memoId: string) => {
    suppress(memoId);
    try {
      const res = await fetch(`/api/memos/${memoId}/resolve`, { method: 'PATCH' });
      if (!res.ok) {
        clear(memoId);
        return false;
      }
      return true;
    } catch {
      clear(memoId);
      return false;
    }
  }, [clear, suppress]);

  const handleConvertToStory = useCallback(async (memoId: string) => {
    const memo = memos.find((item) => item.id === memoId) ?? selectedMemo;
    if (!memo) return;
    setConvertForm({ memoId, title: memo.title || memo.content.slice(0, 100), description: memo.content });
  }, [memos, selectedMemo]);

  const submitConvert = useCallback(async () => {
    if (!convertForm) return;
    const res = await fetch('/api/memos/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memo_id: convertForm.memoId, title: convertForm.title, description: convertForm.description }),
    });
    if (res.ok) {
      const json = await res.json();
      alert(`${t('convertedToStory')} SID:${json.data.story_id}`);
      setConvertForm(null);
      await fetchMemos({ background: true });
      if (selectedMemoIdRef.current === convertForm.memoId) {
        await selectMemoById(convertForm.memoId, { updateUrl: false });
      }
    }
  }, [convertForm, fetchMemos, selectMemoById, t]);

  const handleCreate = useCallback(async (data: { title: string; content: string; memo_type: string; assigned_to_ids: string[] }) => {
    // [DIAG] Warn if assigned_to_ids is empty before dispatching
    if (data.assigned_to_ids.length === 0) {
      console.error('[MemosClient.handleCreate] assigned_to_ids is empty', { title: data.title });
    }
    const res = await fetch('/api/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) return false;

    const json = await res.json();
    setShowCreate(false);
    await fetchMemos({ background: true });
    if (json.data?.id) {
      await selectMemoById(json.data.id, { updateUrl: true });
    }
    return true;
  }, [fetchMemos, selectMemoById]);

  const channelLabelMap = useMemo<Record<WorkspaceChannel, string>>(() => ({
    all: t('channelAll'),
    inbox: t('channelInbox'),
    assigned: t('channelAssigned'),
    created: t('channelCreated'),
    open: t('channelOpen'),
    resolved: t('channelResolved'),
    requests: t('channelRequests'),
    decisions: t('channelDecisions'),
    tasks: t('channelTasks'),
  }), [t]);

  const saveCurrentView = useCallback(() => {
    const trimmedName = saveViewDraftName.trim();
    if (!trimmedName) return;

    const existing = savedViews.find((view) => view.name.trim().toLowerCase() === trimmedName.toLowerCase());
    const nextViewId = existing?.id ?? activeViewId ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;

    setSavedViews((current) => {
      const nextView: MemoWorkspaceView = {
        id: nextViewId,
        name: trimmedName,
        channel,
        search: searchQuery.trim(),
        unreadOnly,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      const next = current.filter((view) => view.id !== nextViewId);
      next.unshift(nextView);
      return next;
    });

    setActiveViewId(nextViewId);
    setShowSaveViewForm(false);
    setSaveViewDraftName('');
  }, [activeViewId, channel, savedViews, saveViewDraftName, searchQuery, unreadOnly]);

  const applySavedView = useCallback((viewId: string) => {
    const view = savedViews.find((item) => item.id === viewId);
    if (!view) {
      setActiveViewId(null);
      return;
    }

    setChannel(view.channel);
    setSearchQuery(view.search);
    setUnreadOnly(view.unreadOnly);
    setActiveViewId(view.id);
    setShowSaveViewForm(false);
  }, [savedViews]);

  const deleteSavedView = useCallback((viewId: string) => {
    setSavedViews((current) => current.filter((view) => view.id !== viewId));
    setActiveViewId((current) => (current === viewId ? null : current));
  }, []);

  const handleChannelChange = useCallback((nextChannel: WorkspaceChannel) => {
    setChannel(nextChannel);
    setActiveViewId(null);
  }, []);

  const handleSearchChange = useCallback((nextSearch: string) => {
    setSearchQuery(nextSearch);
    setActiveViewId(null);
  }, []);

  const handleUnreadChange = useCallback((nextUnreadOnly: boolean) => {
    setUnreadOnly(nextUnreadOnly);
    setActiveViewId(null);
  }, []);

  const handleSaveViewButton = useCallback(() => {
    const defaultNameParts = [selectedView?.name, channelLabelMap[channel], unreadOnly ? t('unreadOnly') : null, searchQuery.trim() || null].filter(Boolean);
    const defaultName = defaultNameParts.length > 0 ? defaultNameParts.join(' · ') : channelLabelMap[channel];
    setSaveViewDraftName(defaultName);
    setShowSaveViewForm(true);
  }, [channel, channelLabelMap, searchQuery, selectedView?.name, t, unreadOnly]);

  const handleCancelCreate = useCallback(() => {
    setShowCreate(false);
  }, []);

  const handleNewMemoClick = useCallback(() => {
    setShowCreate(true);
  }, []);

  const selectedMemoIsVisible = visibleMemos.some((memo) => memo.id === selectedMemo?.id);

  const queueToggleLabel = memoQueueInlinePanelOpen || memoQueueDrawerOpen ? t('hideQueue') : t('openQueue');

  const renderMemoQueuePanel = ({ mode, closePanel }: { mode: 'inline' | 'drawer'; closePanel: () => void }) => (
    <SectionCard className="flex h-full min-h-0 flex-col">
      <SectionCardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('queueTitle')}</div>
            <div className="text-sm text-foreground">{channelLabelMap[channel]} · {t('queueSummary', { count: visibleMemos.length })}</div>
          </div>
          {mode === 'drawer' ? (
            <Button type="button" variant="glass" size="icon-sm" onClick={closePanel} aria-label={t('closeQueue')}>
              <X />
            </Button>
          ) : null}
        </div>
      </SectionCardHeader>
      <SectionCardBody className="flex min-h-0 flex-1 flex-col px-0 py-0">
        {fetchError ? (
          <div className="px-5 py-4">
            <EmptyState title={fetchError} />
          </div>
        ) : loading ? (
          <div className="space-y-3 px-5 py-4">{[1, 2, 3].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-muted/60" />)}</div>
        ) : visibleMemos.length > 0 ? (
          <div className="min-h-0 overflow-y-auto">
            <MemoList memos={visibleMemos} memberMap={memberMap} onSelect={handleSelectMemo} selectedId={selectedMemo?.id} />
            {nextCursor ? (
              <div className="px-5 py-4 text-center">
                <Button
                  type="button"
                  variant="glass"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    void fetchMemos({ cursor: nextCursor, append: true, query: searchQuery.trim() }).finally(() => setLoadingMore(false));
                  }}
                >
                  <ChevronDown className="mr-1 size-4" />
                  {loadingMore ? tc('loading') : t('loadMore')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="px-5 py-4">
            <EmptyState
              title={t('noMemos')}
              description={searchQuery.trim() ? t('noMatchingMemos') : t('selectMemo')}
            />
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );

  return (
    <div className="bg-background p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-4">

        {/* ── Mobile header + compact stats (< lg) ───────── */}
        <div className="lg:hidden">
          <div className="mb-3 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
            <button
              type="button"
              onClick={handleNewMemoClick}
              className="rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
            >
              {t('newMemo')}
            </button>
          </div>
          <div className="flex items-center gap-4 rounded-xl bg-muted/30 px-3 py-2">
            <span className="text-xs text-muted-foreground">{t('statsOpen')} <strong className="text-foreground">{stats.open}</strong></span>
            <span className="text-xs text-muted-foreground">{t('statsAssigned')} <strong className="text-foreground">{stats.assigned}</strong></span>
          </div>
        </div>

        {/* ── Desktop stats 4-card grid (lg+) ─────────────── */}
        <SectionCard className="hidden lg:block">
          <SectionCardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
                <p className="text-sm text-muted-foreground">{t('surfaceDescription')}</p>
              </div>
              <button onClick={handleNewMemoClick} className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
                {t('newMemo')}
              </button>
            </div>
          </SectionCardHeader>
          <SectionCardBody className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl bg-muted/40 p-3">
              <div className="text-xs text-muted-foreground">{t('statsOpen')}</div>
              <div className="text-2xl font-semibold">{stats.open}</div>
            </div>
            <div className="rounded-xl bg-muted/40 p-3">
              <div className="text-xs text-muted-foreground">{t('statsAssigned')}</div>
              <div className="text-2xl font-semibold">{stats.assigned}</div>
            </div>
            <div className="rounded-xl bg-muted/40 p-3">
              <div className="text-xs text-muted-foreground">{t('statsReplies')}</div>
              <div className="text-2xl font-semibold">{stats.replies}</div>
            </div>
            <div className="rounded-xl bg-muted/40 p-3">
              <div className="text-xs text-muted-foreground">{t('statsSavedViews')}</div>
              <div className="text-2xl font-semibold">{stats.views}</div>
            </div>
          </SectionCardBody>
        </SectionCard>

        {/* ── Mobile compact channel filter (< lg, list view only) ── */}
        {mobileView === 'list' && (
          <div className="space-y-2 lg:hidden">
            <select
              value={channel}
              onChange={(e) => handleChannelChange(e.target.value as WorkspaceChannel)}
              className="w-full rounded-xl border border-input bg-[color:var(--operator-surface-soft)] px-3 py-2 text-sm text-foreground"
            >
              {CHANNEL_ORDER.map((id) => (
                <option key={id} value={id}>{channelLabelMap[id]} ({channelCounts[id]})</option>
              ))}
            </select>
            <Input value={searchQuery} onChange={(event) => handleSearchChange(event.target.value)} placeholder={t('searchMemosPlaceholder')} />
          </div>
        )}

        {/* ── Desktop full filter section (lg+) ─────────────── */}
        <SectionCard className="hidden lg:block">
          <SectionCardBody className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_240px_240px_280px]">
              <div className="space-y-2 min-w-0">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('channels')}</div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {CHANNEL_ORDER.map((id) => {
                    const active = channel === id;
                    const count = channelCounts[id];
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => handleChannelChange(id)}
                        className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-muted/50 text-foreground hover:bg-muted'}`}
                      >
                        {channelLabelMap[id]} <span className="opacity-80">{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('projectFilter')}</div>
                <select
                  value={selectedProjectFilter}
                  onChange={(e) => setSelectedProjectFilter(e.target.value)}
                  className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
                >
                  <option value="all">{t('allProjects')}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('searchMemos')}</div>
                <Input value={searchQuery} onChange={(event) => handleSearchChange(event.target.value)} placeholder={t('searchMemosPlaceholder')} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('savedViews')}</div>
                  <button type="button" onClick={handleSaveViewButton} className="text-xs font-medium text-primary hover:underline">
                    {t('saveCurrentView')}
                  </button>
                </div>
                <div className="flex gap-2">
                  <select
                    value={activeViewId ?? ''}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (!next) {
                        setActiveViewId(null);
                        return;
                      }
                      applySavedView(next);
                    }}
                    className="min-w-0 flex-1 rounded-xl border border-input px-3 py-2 text-sm"
                  >
                    <option value="">{t('savedViewSelectPlaceholder')}</option>
                    {savedViews.map((view) => (
                      <option key={view.id} value={view.id}>
                        {view.name}
                      </option>
                    ))}
                  </select>
                  {activeViewId ? (
                    <button type="button" onClick={() => deleteSavedView(activeViewId)} className="rounded-xl border border-input px-3 py-2 text-xs text-muted-foreground hover:bg-muted">
                      {t('deleteView')}
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleUnreadChange(false)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${!unreadOnly ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-muted/50 text-foreground hover:bg-muted'}`}
                  >
                    {t('allMemos')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUnreadChange(true)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${unreadOnly ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-muted/50 text-foreground hover:bg-muted'}`}
                  >
                    {t('unreadOnly')} <span className="opacity-80">({unreadCount})</span>
                  </button>
                </div>
                {showSaveViewForm ? (
                  <div className="flex gap-2">
                    <Input value={saveViewDraftName} onChange={(event) => setSaveViewDraftName(event.target.value)} placeholder={t('viewNamePlaceholder')} />
                    <button type="button" onClick={saveCurrentView} className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
                      {tc('save')}
                    </button>
                    <button type="button" onClick={() => setShowSaveViewForm(false)} className="rounded-xl border border-input px-4 py-2 text-sm text-muted-foreground hover:bg-muted">
                      {tc('cancel')}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            {selectedView ? (
              <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {t('activeView')}: <span className="font-medium text-foreground">{selectedView.name}</span>
                <span className="ml-2">({channelLabelMap[selectedView.channel]}{selectedView.unreadOnly ? ` · ${t('unreadOnly')}` : ''})</span>
              </div>
            ) : null}
          </SectionCardBody>
        </SectionCard>

        {/* ── Desktop: create form + queue toggle + contextual panel (lg+) ── */}
        <div className="hidden lg:block">
          <div className="space-y-4">
            {showCreate ? (
              <MemoCreateForm
                members={members}
                onSubmit={handleCreate}
                onCancel={handleCancelCreate}
                initialTitle={searchParams.get('title') ?? undefined}
                draftStorageKey={draftStorageKey}
              />
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="glass" size="sm" onClick={toggleMemoQueuePanel}>
                  <Menu />
                  {queueToggleLabel}
                </Button>
                <div className="rounded-full border border-white/8 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground">
                  {channelLabelMap[channel]}
                </div>
                <div className="rounded-full border border-white/8 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground">
                  {t('queueSummary', { count: visibleMemos.length })}
                </div>
              </div>
              <Button type="button" variant="glass" size="sm" onClick={() => setShowCreate((prev) => !prev)}>
                {showCreate ? t('hideCreateForm') : t('showCreateForm')}
              </Button>
            </div>

            <ContextualPanelLayout
              renderPanel={renderMemoQueuePanel}
              inlinePanelOpen={memoQueueInlinePanelOpen}
              drawerOpen={memoQueueDrawerOpen}
              onDrawerOpenChange={setMemoQueueDrawerOpen}
              drawerAriaLabel={t('openQueue')}
              inlineColumnsClassName="2xl:grid-cols-[340px_minmax(0,1fr)]"
              panelClassName="min-h-[36rem]"
              contentClassName="min-h-[36rem]"
            >
              <SectionCard className="min-h-[36rem]">
                {selectedMemo ? (
                  <div className="flex h-full flex-col">
                    {!selectedMemoIsVisible ? (
                      <div className="border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">{t('selectedMemoOutsideView')}</div>
                    ) : null}
                    <MemoDetail
                      memo={selectedMemo}
                      memberMap={memberMap}
                      projectId={projectId}
                      currentTeamMemberId={currentTeamMemberId}
                      currentTeamMemberName={currentTeamMemberName}
                      onReply={handleReply}
                      onResolve={handleResolve}
                      onConvertToStory={handleConvertToStory}
                      onMemoChange={handleMemoChange}
                    />
                  </div>
                ) : (
                  <SectionCardBody className="flex min-h-[36rem] items-center justify-center">
                    <EmptyState title={t('selectMemo')} description={t('detailDescription')} />
                  </SectionCardBody>
                )}
              </SectionCard>
            </ContextualPanelLayout>
          </div>
        </div>

        {/* ── Mobile: full-screen list ↔ detail (< lg) ─────── */}
        <div className="lg:hidden">
          {showCreate ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleCancelCreate}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="size-4" />
                {t('title')}
              </button>
              <MemoCreateForm
                members={members}
                onSubmit={handleCreate}
                onCancel={handleCancelCreate}
                initialTitle={searchParams.get('title') ?? undefined}
                draftStorageKey={draftStorageKey}
              />
            </div>
          ) : mobileView === 'detail' && selectedMemo ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setMobileView('list')}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="size-4" />
                {t('title')}
              </button>
              <SectionCard>
                <div className="flex h-full flex-col">
                  {!selectedMemoIsVisible ? (
                    <div className="border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">{t('selectedMemoOutsideView')}</div>
                  ) : null}
                  <MemoDetail
                    memo={selectedMemo}
                    memberMap={memberMap}
                    projectId={projectId}
                    currentTeamMemberId={currentTeamMemberId}
                    currentTeamMemberName={currentTeamMemberName}
                    onReply={handleReply}
                    onResolve={handleResolve}
                    onConvertToStory={handleConvertToStory}
                    onMemoChange={handleMemoChange}
                  />
                </div>
              </SectionCard>
            </div>
          ) : loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-muted/60" />)}
            </div>
          ) : fetchError ? (
            <EmptyState title={fetchError} />
          ) : visibleMemos.length === 0 ? (
            <EmptyState title={t('noMemos')} description={searchQuery.trim() ? t('noMatchingMemos') : t('selectMemo')} />
          ) : (
            <>
              <MemoList memos={visibleMemos} memberMap={memberMap} onSelect={handleSelectMemo} selectedId={selectedMemo?.id} />
              {nextCursor ? (
                <div className="mt-3 text-center">
                  <Button
                    type="button"
                    variant="glass"
                    size="sm"
                    disabled={loadingMore}
                    onClick={() => {
                      setLoadingMore(true);
                      void fetchMemos({ cursor: nextCursor, append: true, query: searchQuery.trim() }).finally(() => setLoadingMore(false));
                    }}
                  >
                    <ChevronDown className="mr-1 size-4" />
                    {loadingMore ? tc('loading') : t('loadMore')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {convertForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-card p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">{t('convertToStory')}</h3>
            <div className="space-y-3">
              <input type="text" value={convertForm.title} onChange={(e) => setConvertForm({ ...convertForm, title: e.target.value })} className="w-full rounded-xl border border-input px-3 py-2 text-sm" />
              <textarea value={convertForm.description} onChange={(e) => setConvertForm({ ...convertForm, description: e.target.value })} rows={6} className="w-full rounded-xl border border-input px-3 py-2 text-sm" />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConvertForm(null)} className="rounded-xl border border-input px-4 py-2 text-sm">{tc('cancel')}</button>
              <button onClick={submitConvert} className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground">{t('convertToStory')}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
