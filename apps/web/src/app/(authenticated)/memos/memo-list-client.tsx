'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search, X } from 'lucide-react';
import { MemoFeed } from '@/components/memos/memo-feed';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import type { MemoSummaryState } from '@/components/memos/memo-state';

interface MemoListClientProps {
  selectedMemoId?: string | null;
  onNewMemo?: () => void;
}

interface Member {
  id: string;
  name: string;
  type: string;
}

export function MemoListClient({ selectedMemoId, onNewMemo }: MemoListClientProps) {
  const t = useTranslations('memos');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { projectId } = useDashboardContext();

  const [memos, setMemos] = useState<MemoSummaryState[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedMemberIds = useMemo(() => {
    const raw = searchParams.get('member_ids');
    return raw ? raw.split(',').filter(Boolean) : [];
  }, [searchParams]);

  const selectedAgentIds = useMemo(() => {
    const raw = searchParams.get('agent_ids');
    return raw ? raw.split(',').filter(Boolean) : [];
  }, [searchParams]);

  const hasActiveFilters = selectedMemberIds.length > 0 || selectedAgentIds.length > 0;
  const humanMembers = useMemo(() => members.filter((m) => m.type !== 'agent'), [members]);
  const agentMembers = useMemo(() => members.filter((m) => m.type === 'agent'), [members]);
  const memberMap = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m.name])), [members]);

  const filteredMemos = useMemo(() => {
    if (!hasActiveFilters) return memos;
    const allSelectedIds = new Set([...selectedMemberIds, ...selectedAgentIds]);
    return memos.filter((memo) => memo.assigned_to !== null && allSelectedIds.has(memo.assigned_to));
  }, [memos, hasActiveFilters, selectedMemberIds, selectedAgentIds]);

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

  const fetchMemos = useCallback(async (q?: string, cursor?: string | null, filterIds?: string[]) => {
    if (!projectId) return;
    try {
      const params = new URLSearchParams();
      params.append('project_id', projectId);
      params.append('limit', '10');
      if (q?.trim()) params.append('q', q.trim());
      if (cursor) params.append('cursor', cursor);
      if (filterIds?.length) params.append('assigned_to', filterIds.join(','));
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
    } catch {
      // silently fail - list will show empty
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [projectId]);

  const fetchMembers = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/team-members?project_id=${projectId}&is_active=true`);
      if (!res.ok) return;
      const { data } = await res.json();
      setMembers(data ?? []);
    } catch {
      // non-critical
    }
  }, [projectId]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    await fetchMemos(debouncedQuery || undefined, nextCursor);
  }, [fetchMemos, debouncedQuery, hasMore, loadingMore, nextCursor]);

  useEffect(() => {
    void Promise.all([fetchMemos(), fetchMembers()]);
  }, [fetchMemos, fetchMembers]);

  useEffect(() => {
    setNextCursor(null);
    setHasMore(false);
    const allFilterIds = [...selectedMemberIds, ...selectedAgentIds];
    void fetchMemos(debouncedQuery, null, allFilterIds.length ? allFilterIds : undefined);
  }, [debouncedQuery, fetchMemos, selectedMemberIds, selectedAgentIds]);

  useAutoRefresh('memo-list', () => void fetchMemos(debouncedQuery));

  const handleSelectMemo = useCallback((memoId: string) => {
    router.push(`/memos/${memoId}`);
  }, [router]);

  return (
    <div className="flex h-full flex-col">
      {/* Search + filters */}
      <div className="flex-shrink-0 border-b border-border/80 px-3 py-2 space-y-2">
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

        {(humanMembers.length > 0 || agentMembers.length > 0) && (
          <div className="space-y-1.5">
            {humanMembers.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <span className="flex items-center text-[10px] font-medium text-muted-foreground pr-1">{t('filterMembers')}</span>
                {humanMembers.map((m) => {
                  const active = selectedMemberIds.includes(m.id);
                  return (
                    <button key={m.id} type="button" onClick={() => toggleMemberId(m.id)}
                      className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${active ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
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
                    <button key={m.id} type="button" onClick={() => toggleAgentId(m.id)}
                      className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${active ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
                      {m.name}
                    </button>
                  );
                })}
              </div>
            )}
            {hasActiveFilters && (
              <button type="button" onClick={clearFilters}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />{t('clearFilters')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Memo list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          </div>
        ) : hasActiveFilters && filteredMemos.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4">
            <p className="text-center text-sm text-muted-foreground">{t('noFilteredMemos')}</p>
          </div>
        ) : (
          <MemoFeed
            memos={filteredMemos}
            onSelectMemo={handleSelectMemo}
            selectedMemoId={selectedMemoId ?? null}
            memberMap={memberMap}
            onNewMemo={onNewMemo}
          />
        )}
        {hasMore && !hasActiveFilters && (
          <div className="px-3 py-2">
            <Button variant="ghost" size="sm" className="w-full text-muted-foreground"
              onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? t('loading') : t('loadMore')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
