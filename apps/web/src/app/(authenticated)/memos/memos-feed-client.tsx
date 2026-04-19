'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Plus, X } from 'lucide-react';
import { MemoFeed } from '@/components/memos/memo-feed';
import { MemoThread } from '@/components/memos/memo-thread';
import { MemoCreateForm } from '@/components/memos/memo-create-form';
import { Button } from '@/components/ui/button';
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
  const [memos, setMemos] = useState<MemoSummaryState[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedMemo, setSelectedMemo] = useState<MemoDetailState | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');

  const fetchMemos = useCallback(async () => {
    if (!projectId) return;

    try {
      const params = new URLSearchParams();
      params.append('project_id', projectId);
      params.append('limit', '50');

      const res = await fetch(`/api/memos?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch memos');

      const { data } = await res.json();
      setMemos(data || []);
    } catch (error) {
      console.error('Failed to fetch memos:', error);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

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

  const handleSelectMemo = useCallback(async (memoId: string) => {
    await fetchMemoDetail(memoId);
    setMobileView('detail');
  }, [fetchMemoDetail]);

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

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
      </div>
    );
  }

  const feedHeader = (
    <div className="flex-shrink-0 border-b border-white/10 px-4 py-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t('title')}</h1>
        <Button size="sm" onClick={handleNewMemo}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
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
    />
  ) : (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-[color:var(--operator-muted)]">{t('selectMemo')}</p>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:h-full lg:flex-row">
      {/* Desktop: left feed panel (lg+) */}
      <div className="hidden w-80 flex-shrink-0 flex-col border-r border-white/10 lg:flex">
        {feedHeader}
        <div className="flex-1 overflow-y-auto">
          <MemoFeed
            memos={memos}
            onSelectMemo={handleSelectMemo}
            selectedMemoId={selectedMemo?.id ?? null}
          />
        </div>
      </div>

      {/* Desktop: right thread panel (lg+) */}
      <div className="hidden flex-1 flex-col bg-[color:var(--operator-surface)] lg:flex">
        {detailContent}
      </div>

      {/* Mobile: list view (< lg) */}
      {mobileView === 'list' && (
        <div className="flex flex-1 flex-col lg:hidden">
          {feedHeader}
          <div className="flex-1 overflow-y-auto">
            <MemoFeed
              memos={memos}
              onSelectMemo={handleSelectMemo}
              selectedMemoId={selectedMemo?.id ?? null}
            />
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
              className="flex items-center gap-1 py-1 text-sm text-[color:var(--operator-muted)] hover:text-[color:var(--operator-foreground)]"
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
  );
}
