'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Plus, Search, X } from 'lucide-react';
import { MemoFeed } from '@/components/memos/memo-feed';
import { MemoThread } from '@/components/memos/memo-thread';
import { MemoCreateForm } from '@/components/memos/memo-create-form';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { summarizeMemo, mergeMemoDetailIntoList, type MemoDetailState, type MemoSummaryState } from '@/components/memos/memo-state';

interface MemosFeedClientProps {
  currentTeamMemberId: string;
  projectId?: string;
}

/**
 * Message feed + thread redesign of memos UI
 * Replaces permanent LNB with contextual panel
 */
interface Member {
  id: string;
  name: string;
  type: string;
}

export function MemosFeedClient({ currentTeamMemberId, projectId }: MemosFeedClientProps) {
  const t = useTranslations('memos');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [memos, setMemos] = useState<MemoSummaryState[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedMemo, setSelectedMemo] = useState<MemoDetailState | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Member/Agent filter — stored in URL params
  const selectedMemberIds = useMemo(() => {
    const raw = searchParams.get('member_ids');
    return raw ? raw.split(',').filter(Boolean) : [];
  }, [searchParams]);

  const selectedAgentIds = useMemo(() => {
    const raw = searchParams.get('agent_ids');
    return raw ? raw.split(',').filter(Boolean) : [];
  }, [searchParams]);

  const hasActiveFilters = selectedMemberIds.length > 0 || selectedAgentIds.length > 0;

  const toggleMemberId = useCallback((id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    const current = params.get('member_ids')?.split(',').filter(Boolean) ?? [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    if (next.length > 0) params.set('member_ids', next.join(','));
    else params.delete('member_ids');
    router.replace(`/memos${params.size > 0 ? `?${params.toString()}` : ''}`, { scroll: false });
  }, [router, searchParams]);

  const toggleAgentId = useCallback((id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    const current = params.get('agent_ids')?.split(',').filter(Boolean) ?? [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    if (next.length > 0) params.set('agent_ids', next.join(','));
    else params.delete('agent_ids');
    router.replace(`/memos${params.size > 0 ? `?${params.toString()}` : ''}`, { scroll: false });
  }, [router, searchParams]);

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('member_ids');
    params.delete('agent_ids');
    router.replace(`/memos${params.size > 0 ? `?${params.toString()}` : ''}`, { scroll: false });
  }, [router, searchParams]);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(value), 300);
  };

  const memberMap = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, m.name])),
    [members],
  );

  const memberInfoMap = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, { name: m.name, type: m.type }])),
    [members],
  );

  const humanMembers = useMemo(() => members.filter((m) => m.type !== 'agent'), [members]);
  const agentMembers = useMemo(() => members.filter((m) => m.type === 'agent'), [members]);

  const filteredMemos = useMemo(() => {
    if (!hasActiveFilters) return memos;
    const allSelectedIds = new Set([...selectedMemberIds, ...selectedAgentIds]);
    return memos.filter((memo) => memo.assigned_to !== null && allSelectedIds.has(memo.assigned_to));
  }, [memos, hasActiveFilters, selectedMemberIds, selectedAgentIds]);

  const fetchMemos = useCallback(async (q?: string, cursor?: string | null) => {
    if (!projectId) return;

    try {
      const params = new URLSearchParams();
      params.append('project_id', projectId);
      params.append('limit', '10');
      if (q?.trim()) params.append('q', q.trim());
      if (cursor) params.append('cursor', cursor);

      const res = await fetch(`/api/memos?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch memos');

      const { data, meta } = await res.json();
      if (cursor) {
        setMemos((prev) => [...prev, ...(data ?? [])]);
      } else {
        setMemos(data ?? []);
      }
      setHasMore(meta?.hasMore ?? false);
      setNextCursor(meta?.nextCursor ?? null);
    } catch (error) {
      console.error('Failed to fetch memos:', error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [projectId]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    await fetchMemos(debouncedQuery || undefined, nextCursor);
  }, [fetchMemos, debouncedQuery, hasMore, loadingMore, nextCursor]);

  const fetchMembers = useCallback(async () => {
    if (!projectId) return;

    try {
      const res = await fetch(`/api/team-members?project_id=${projectId}`);
      if (!res.ok) throw new Error('Failed to fetch members');

      const { data } = await res.json();
      setMembers(data || []);
    } catch (error) {
      console.error('Failed to fetch members:', error);
    }
  }, [projectId]);

  const markMemoRead = useCallback(async (memoId: string) => {
    try {
      await fetch(`/api/memos/${memoId}/read`, {
        method: 'PATCH',
      });
    } catch (error) {
      console.error('Failed to mark memo as read:', error);
    }
  }, []);

  const fetchMemoDetail = useCallback(async (memoId: string) => {
    try {
      const res = await fetch(`/api/memos/${memoId}`);
      if (!res.ok) throw new Error('Failed to fetch memo');

      const { data } = await res.json();
      setSelectedMemo(data);
      setMemos((prev) => mergeMemoDetailIntoList(prev, data));

      // Auto mark as read when thread is opened
      await markMemoRead(memoId);
    } catch (error) {
      console.error('Failed to fetch memo detail:', error);
    }
  }, [markMemoRead]);

  const handleSelectMemo = useCallback((memoId: string) => {
    router.push(`/memos/${memoId}`);
  }, [router]);

  const handleNewMemo = useCallback(() => {
    setShowCreate(true);
    setMobileView('detail');
  }, []);

  const handleCancelCreate = useCallback(() => {
    setShowCreate(false);
    setMobileView('list');
  }, []);

  const handleReply = useCallback(async (content: string) => {
    if (!selectedMemo) return;

    const res = await fetch(`/api/memos/${selectedMemo.id}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!res.ok) throw new Error('Failed to submit reply');

    const { data: reply } = await res.json();

    setSelectedMemo((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        replies: [...(prev.replies || []), reply],
      };
    });

    setMemos((prev) =>
      prev.map((m) =>
        m.id === selectedMemo.id
          ? { ...m, reply_count: (m.reply_count ?? 0) + 1 }
          : m
      )
    );
  }, [selectedMemo]);

  const handleResolve = useCallback(async () => {
    if (!selectedMemo) return;

    const res = await fetch(`/api/memos/${selectedMemo.id}/resolve`, {
      method: 'PATCH',
    });

    if (!res.ok) throw new Error('Failed to resolve memo');

    setSelectedMemo((prev) => (prev ? { ...prev, status: 'resolved' } : null));
    setMemos((prev) =>
      prev.map((m) => (m.id === selectedMemo.id ? { ...m, status: 'resolved' } : m))
    );
  }, [selectedMemo]);

  const handleCreate = useCallback(async (data: { title: string; content: string; memo_type: string; assigned_to_ids: string[] }) => {
    if (!projectId) return false;

    if (data.assigned_to_ids.length === 0) {
      console.error('[MemosFeedClient.handleCreate] assigned_to_ids is empty', { title: data.title });
    }

    try {
      const res = await fetch('/api/memos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          project_id: projectId,
        }),
      });

      if (!res.ok) throw new Error('Failed to create memo');

      const { data: newMemo } = await res.json();

      setMemos((prev) => [summarizeMemo(newMemo), ...prev]);
      setSelectedMemo(newMemo);
      setShowCreate(false);

      return true;
    } catch (error) {
      console.error('Failed to create memo:', error);
      return false;
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.all([fetchMemos(), fetchMembers()]);
  }, [fetchMemos, fetchMembers]);

  useEffect(() => {
    setNextCursor(null);
    setHasMore(false);
    void fetchMemos(debouncedQuery);
  }, [debouncedQuery, fetchMemos]);

  if (loading) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <div className="flex h-64 items-center justify-center">
          <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
        </div>
      </>
    );
  }

  const feedHeader = (
    <div className="flex-shrink-0 border-b border-border/80 px-3 py-2 space-y-2">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder={t('searchMemosPlaceholder')}
          className="w-full rounded-md border border-border bg-muted/30 py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => handleSearchChange('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {/* Member / Agent filter chips */}
      {(humanMembers.length > 0 || agentMembers.length > 0) && (
        <div className="space-y-1.5">
          {humanMembers.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="flex items-center text-[10px] font-medium text-muted-foreground pr-1">{t('filterMembers')}</span>
              {humanMembers.map((m) => {
                const active = selectedMemberIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleMemberId(m.id)}
                    className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                      active
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    {m.name}
                  </button>
                );
              })}
            </div>
          )}
          {agentMembers.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="flex items-center text-[10px] font-medium text-muted-foreground pr-1">{t('filterAgents')}</span>
              {agentMembers.map((m) => {
                const active = selectedAgentIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleAgentId(m.id)}
                    className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                      active
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    {m.name}
                  </button>
                );
              })}
            </div>
          )}
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
              {t('clearFilters')}
            </button>
          )}
        </div>
      )}
    </div>
  );

  const detailContent = showCreate ? (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('createTitle')}</h2>
          <Button variant="ghost" size="sm" onClick={handleCancelCreate}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <MemoCreateForm
          members={members}
          onSubmit={handleCreate}
          onCancel={handleCancelCreate}
        />
      </div>
    </div>
  ) : selectedMemo ? (
    <MemoThread
      memo={selectedMemo}
      currentUserId={currentTeamMemberId}
      onReply={handleReply}
      onResolve={handleResolve}
      memberMap={memberInfoMap}
    />
  ) : (
    <div className="flex h-full items-center justify-center p-4">
      <EmptyState
        title={t('title')}
        description={t('selectMemo')}
        className="w-full max-w-lg bg-background/70"
        action={
          <Button size="sm" onClick={handleNewMemo}>
            <Plus className="mr-1 h-4 w-4" />
            {t('newMemo')}
          </Button>
        }
      />
    </div>
  );

  return (
    <>
    <TopBarSlot
      title={<h1 className="text-sm font-medium">{t('title')}</h1>}
      actions={
        <Button size="sm" variant="outline" onClick={handleNewMemo}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('newMemo')}
        </Button>
      }
    />
    <div className="flex min-h-0 flex-1 flex-col lg:h-full lg:flex-row lg:overflow-hidden">
      {/* Desktop: left feed panel (lg+) */}
      <div className="hidden w-[340px] flex-shrink-0 flex-col border-r border-border/80 bg-background lg:flex">
        {feedHeader}
        <div className="flex-1 overflow-y-auto">
          {hasActiveFilters && filteredMemos.length === 0 ? (
            <div className="flex h-32 items-center justify-center px-4">
              <p className="text-center text-sm text-muted-foreground">{t('noFilteredMemos')}</p>
            </div>
          ) : (
            <MemoFeed
              memos={filteredMemos}
              onSelectMemo={handleSelectMemo}
              selectedMemoId={selectedMemo?.id ?? null}
              memberMap={memberMap}
              onNewMemo={handleNewMemo}
            />
          )}
          {hasMore && !hasActiveFilters && (
            <div className="px-3 py-2">
              <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? t('loading') : t('loadMore')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Desktop: right thread panel (lg+) */}
      <div className="hidden min-w-0 flex-1 flex-col bg-background lg:flex">
        {detailContent}
      </div>

      {/* Mobile: list view (< lg) */}
      {mobileView === 'list' && (
        <div className="flex flex-1 flex-col lg:hidden">
          {feedHeader}
          <div className="flex-1 overflow-y-auto">
            {hasActiveFilters && filteredMemos.length === 0 ? (
              <div className="flex h-32 items-center justify-center px-4">
                <p className="text-center text-sm text-muted-foreground">{t('noFilteredMemos')}</p>
              </div>
            ) : (
              <MemoFeed
                memos={filteredMemos}
                onSelectMemo={handleSelectMemo}
                selectedMemoId={selectedMemo?.id ?? null}
                memberMap={memberMap}
                onNewMemo={handleNewMemo}
              />
            )}
            {hasMore && !hasActiveFilters && (
              <div className="px-3 py-2">
                <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? t('loading') : t('loadMore')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mobile: detail view (< lg) */}
      {mobileView === 'detail' && (
        <div className="flex flex-1 flex-col lg:hidden">
          <div className="flex-shrink-0 border-b border-white/10 px-4 py-2">
            <button
              type="button"
              onClick={() => { setMobileView('list'); setShowCreate(false); }}
              className="flex min-h-[44px] items-center gap-1 px-1 text-sm text-[color:var(--operator-muted)] hover:text-[color:var(--operator-foreground)]"
            >
              <ChevronLeft className="size-4" />
              {t('title')}
            </button>
          </div>
          <div className="flex-1 overflow-hidden bg-[color:var(--operator-surface)]">
            {detailContent}
          </div>
        </div>
      )}
    </div>
    </>
  );
}
