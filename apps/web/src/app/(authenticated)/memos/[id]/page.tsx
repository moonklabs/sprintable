'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ChatView } from '@/components/chat/chat-view';
import { useDashboardContext } from '../../../dashboard/dashboard-shell';

interface MemoSummary {
  id: string;
  title: string | null;
}

export default function MemoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useTranslations('memos');
  const { currentTeamMemberId } = useDashboardContext();

  const [memo, setMemo] = useState<MemoSummary | null>(null);

  const fetchMemoTitle = useCallback(async () => {
    try {
      const res = await fetch(`/api/memos/${id}`);
      if (!res.ok) return;
      const { data } = await res.json();
      setMemo({ id: data.id, title: data.title });
      await fetch(`/api/memos/${id}/read`, { method: 'PATCH' }).catch(() => null);
    } catch {
      // non-critical — ChatView will still render
    }
  }, [id]);

  useEffect(() => {
    void fetchMemoTitle();
  }, [fetchMemoTitle]);

  if (!currentTeamMemberId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noTeamMember')}</p>
      </div>
    );
  }

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => router.push('/memos')}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('title')}
            </button>
            <span className="hidden truncate text-sm font-medium lg:block">
              {memo?.title ?? t('title')}
            </span>
          </div>
        }
        actions={
          <Button size="sm" variant="outline" onClick={() => router.push('/memos/new')}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('newMemo')}
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col bg-background overflow-hidden">
        <ChatView
          threadId={id}
          currentTeamMemberId={currentTeamMemberId}
          threadTitle={memo?.title ?? undefined}
        />
      </div>
    </>
  );
}
