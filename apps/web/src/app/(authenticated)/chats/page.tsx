'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ChatListView } from '@/components/chat/chat-list-view';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { EmptyState } from '@/components/ui/empty-state';

export default function ChatsPage() {
  const t = useTranslations('chats');
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const [showModal, setShowModal] = useState(false);

  if (!currentTeamMemberId || !projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <EmptyState title="로딩 중…" description="" className="w-full max-w-xs" />
      </div>
    );
  }

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button size="sm" variant="outline" onClick={() => setShowModal(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('newConversation')}
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ChatListView
          projectId={projectId}
          currentTeamMemberId={currentTeamMemberId}
          open={showModal}
          onOpenChange={setShowModal}
        />
      </div>
    </>
  );
}
