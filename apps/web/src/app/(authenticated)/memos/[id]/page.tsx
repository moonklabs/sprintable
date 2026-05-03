'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { MemoThread } from '@/components/memos/memo-thread';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { useDashboardContext } from '../../../dashboard/dashboard-shell';
import type { MemoDetailState } from '@/components/memos/memo-state';

interface Member {
  id: string;
  name: string;
}

export default function MemoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useTranslations('memos');
  const { currentTeamMemberId, projectId } = useDashboardContext();

  const [memo, setMemo] = useState<MemoDetailState | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));

  const fetchMemo = useCallback(async () => {
    try {
      const res = await fetch(`/api/memos/${id}`);
      if (!res.ok) throw new Error('Failed to fetch memo');
      const { data } = await res.json();
      setMemo(data);
      await fetch(`/api/memos/${id}/read`, { method: 'PATCH' }).catch(() => null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchMembers = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/team-members?project_id=${projectId}`);
      if (!res.ok) return;
      const { data } = await res.json();
      setMembers(data ?? []);
    } catch {
      // non-critical
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.all([fetchMemo(), fetchMembers()]);
  }, [fetchMemo, fetchMembers]);

  const handleReply = useCallback(async (content: string) => {
    if (!memo) return;
    const res = await fetch(`/api/memos/${memo.id}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error('Failed to submit reply');
    const { data: reply } = await res.json();
    setMemo((prev) => prev ? { ...prev, replies: [...(prev.replies ?? []), reply] } : null);
  }, [memo]);

  const handleResolve = useCallback(async () => {
    if (!memo) return;
    const res = await fetch(`/api/memos/${memo.id}/resolve`, { method: 'PATCH' });
    if (!res.ok) throw new Error('Failed to resolve memo');
    setMemo((prev) => prev ? { ...prev, status: 'resolved' } : null);
  }, [memo]);

  return (
    <>
      <TopBarSlot
        title={
          <button
            type="button"
            onClick={() => router.push('/memos')}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('title')}
          </button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {loading && (
          <div className="flex h-64 items-center justify-center">
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          </div>
        )}
        {!loading && error && (
          <div className="flex h-64 items-center justify-center">
            <p className="text-sm text-destructive">{t('loadError')}</p>
          </div>
        )}
        {!loading && memo && currentTeamMemberId && (
          <MemoThread
            memo={memo}
            currentUserId={currentTeamMemberId}
            onReply={handleReply}
            onResolve={handleResolve}
            memberMap={memberMap}
          />
        )}
      </div>
    </>
  );
}
