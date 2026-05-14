'use client';

import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ChatView } from '@/components/chat/chat-view';
import { useDashboardContext } from '../../../dashboard/dashboard-shell';

export default function ConversationPage() {
  const { conversation_id } = useParams<{ conversation_id: string }>();
  const router = useRouter();
  const { currentTeamMemberId, projectId } = useDashboardContext();

  if (!currentTeamMemberId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">로딩 중…</p>
      </div>
    );
  }

  return (
    <>
      <TopBarSlot
        title={
          <button
            type="button"
            onClick={() => router.push('/chats')}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden"
          >
            <ChevronLeft className="h-4 w-4" />
            채팅
          </button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <ChatView
          key={conversation_id}
          threadId={conversation_id}
          currentTeamMemberId={currentTeamMemberId}
          projectId={projectId}
        />
      </div>
    </>
  );
}
