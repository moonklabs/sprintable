'use client';

import { useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ChatListView } from '@/components/chat/chat-list-view';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { EmptyState } from '@/components/ui/empty-state';

export default function ChatsPage() {
  const t = useTranslations('chats');
  const { currentTeamMemberId, projectId } = useDashboardContext();

  if (!currentTeamMemberId || !projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <EmptyState title="로딩 중…" description="" className="w-full max-w-xs" />
      </div>
    );
  }

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ChatListView projectId={projectId} currentTeamMemberId={currentTeamMemberId} />
      </div>
    </>
  );
}
