'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { GlassPanel } from '@/components/ui/glass-panel';
import { MemoList } from '@/components/memos/memo-list';
import { MemoDetail } from '@/components/memos/memo-detail';
import { MemoCreateForm } from '@/components/memos/memo-create-form';
import { mergeMemoDetailIntoList, type MemoDetailState, type MemoSummaryState } from '@/components/memos/memo-state';
import { createMemoDraftStorageKey } from '@/components/memos/memo-workspace';
import { useRealtimeMemos } from '@/hooks/use-realtime-memos';
import { useMemoRefreshGuard } from '@/hooks/use-memo-refresh-guard';

interface Member { id: string; name: string; type: string }

interface MemoSidebarProps {
  open: boolean;
  onClose: () => void;
  currentTeamMemberId?: string;
  projectId?: string;
}

export function MemoSidebar({ open, onClose, currentTeamMemberId, projectId }: MemoSidebarProps) {
  const t = useTranslations('memos');
  const tc = useTranslations('common');
  const [memos, setMemos] = useState<MemoSummaryState[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedMemo, setSelectedMemo] = useState<MemoDetailState | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { clear, suppress, shouldIgnore } = useMemoRefreshGuard();

  const memberMap: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = {};
    for (const member of members) map[member.id] = member.name;
    return map;
  }, [members]);

  const currentTeamMemberName = currentTeamMemberId ? memberMap[currentTeamMemberId] : undefined;

  const fetchMemos = useCallback(async (options?: { background?: boolean; cursor?: string | null; append?: boolean }) => {
    if (!projectId) return;
    if (!options?.background) setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('project_id', projectId);
      params.set('limit', '30');
      if (options?.cursor) params.set('cursor', options.cursor);

      const res = await fetch(`/api/memos?${params.toString()}`);
      if (!res.ok) return;
      const json = await res.json();
      const rows = (json.data ?? []) as MemoSummaryState[];
      setMemos((prev) => (options?.append ? [...prev, ...rows] : rows));
      setNextCursor(json.meta?.nextCursor ?? null);
    } finally {
      if (!options?.background) setLoading(false);
    }
  }, [projectId]);

  const fetchMembers = useCallback(async () => {
    if (!projectId) return;
    const res = await fetch(`/api/team-members?project_id=${projectId}`);
    if (!res.ok) return;
    const json = await res.json();
    setMembers(json.data ?? []);
  }, [projectId]);

  const fetchMemoDetail = useCallback(async (memoId: string) => {
    const res = await fetch(`/api/memos/${memoId}`);
    if (!res.ok) return;
    const json = await res.json();
    setSelectedMemo(json.data);
    setMemos((prev) => mergeMemoDetailIntoList(prev, json.data));
  }, []);

  const handleMemoChange = useCallback((updatedMemo: MemoDetailState) => {
    setSelectedMemo(updatedMemo);
    setMemos((prev) => mergeMemoDetailIntoList(prev, updatedMemo));
  }, []);

  const markMemoNotificationsRead = useCallback(async () => {
    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true, type: 'memo' }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    void Promise.all([fetchMemos(), fetchMembers(), markMemoNotificationsRead()]);
  }, [open, fetchMemos, fetchMembers, markMemoNotificationsRead]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useRealtimeMemos({
    currentTeamMemberId,
    onNewMemo: useCallback(async () => {
      if (!open) return;
      await fetchMemos({ background: true });
    }, [open, fetchMemos]),
    onNewReply: useCallback(async (reply: { id: string; memo_id: string; created_by: string | null; created_at: string }) => {
      if (!open) return;
      if (reply.created_by === currentTeamMemberId && shouldIgnore(reply.memo_id)) return;
      await fetchMemos({ background: true });
      if (selectedMemo?.id === reply.memo_id) {
        await fetchMemoDetail(reply.memo_id);
      }
    }, [currentTeamMemberId, fetchMemos, fetchMemoDetail, open, selectedMemo?.id, shouldIgnore]),
    onMemoUpdated: useCallback(async (memo: { id: string }) => {
      if (!open || shouldIgnore(memo.id)) return;
      await fetchMemos({ background: true });
      if (selectedMemo?.id === memo.id) {
        await fetchMemoDetail(memo.id);
      }
    }, [fetchMemos, fetchMemoDetail, open, selectedMemo?.id, shouldIgnore]),
  });

  const handleSelectMemo = useCallback(async (memo: MemoSummaryState) => {
    await fetchMemoDetail(memo.id);
    setMobileView('detail');
  }, [fetchMemoDetail]);

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
      return json.data ?? null;
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

  const handleCreate = useCallback(async (data: { title: string; content: string; memo_type: string; assigned_to_ids: string[] }) => {
    // [DIAG] Warn if assigned_to_ids is empty before dispatching — may indicate upstream nullification
    if (data.assigned_to_ids.length === 0) {
      console.error('[MemoSidebar.handleCreate] assigned_to_ids is empty', { title: data.title });
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
      await fetchMemoDetail(json.data.id);
    }
    return true;
  }, [fetchMemos, fetchMemoDetail]);

  if (!open) return null;

  return (
    <>
      <button className="fixed inset-0 z-40 bg-black/30" aria-label={t('closeSidebar')} onClick={onClose} />
      <div
        ref={panelRef}
        className="fixed inset-0 z-50 flex flex-col bg-background shadow-xl md:inset-y-0 md:left-auto md:right-0 md:w-[88vw] md:max-w-5xl md:border-l md:border-border"
        aria-label={t('sidebarTitle')}
        role="complementary"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {mobileView === 'detail' && selectedMemo && (
              <button
                onClick={() => setMobileView('list')}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted md:hidden"
                aria-label="Back to list"
              >
                ←
              </button>
            )}
            <div>
              <h2 className="text-lg font-semibold text-foreground">{t('sidebarTitle')}</h2>
              <p className="hidden text-xs text-muted-foreground sm:block">{t('sidebarSubtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCreate((prev) => !prev)}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              {t('newMemo')}
            </button>
            <button
              onClick={onClose}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            >
              ✕
            </button>
          </div>
        </div>

        {showCreate && (
          <div className="border-b border-border bg-muted/30 p-4">
            <MemoCreateForm members={members} onSubmit={handleCreate} onCancel={() => setShowCreate(false)} draftStorageKey={createMemoDraftStorageKey(projectId, currentTeamMemberId)} />
          </div>
        )}

        <div className="grid min-h-0 flex-1 md:grid-cols-[320px_minmax(0,1fr)]">
          <section className={`min-h-0 overflow-y-auto border-r border-border bg-muted/10 ${mobileView === 'detail' ? 'hidden md:block' : 'block'}`}>
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">{tc('loading')}</div>
            ) : (
              <div className="space-y-3 p-0">
                <MemoList memos={memos} memberMap={memberMap} onSelect={handleSelectMemo} selectedId={selectedMemo?.id} />
                {nextCursor ? (
                  <div className="px-4 pb-4 text-center">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loadingMore}
                      onClick={async () => {
                        if (!nextCursor) return;
                        setLoadingMore(true);
                        await fetchMemos({ background: true, cursor: nextCursor, append: true });
                        setLoadingMore(false);
                      }}
                    >
                      {loadingMore ? tc('loading') : t('loadMore')}
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </section>
          <section className={`min-h-0 overflow-y-auto bg-background ${mobileView === 'list' && !selectedMemo ? 'hidden md:flex' : 'block'}`}>
            {selectedMemo ? (
              <MemoDetail
                memo={selectedMemo}
                memberMap={memberMap}
                projectId={projectId}
                currentTeamMemberId={currentTeamMemberId}
                currentTeamMemberName={currentTeamMemberName}
                onReply={handleReply}
                onResolve={handleResolve}
                onMemoChange={handleMemoChange}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('selectMemo')}</div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
