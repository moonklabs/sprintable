'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ChatView } from '@/components/chat/chat-view';
import { useDashboardContext } from '../../../dashboard/dashboard-shell';

interface ConversationMeta {
  title: string | null;
  type: 'dm' | 'group';
}

export default function ConversationPage() {
  const { conversation_id } = useParams<{ conversation_id: string }>();
  const router = useRouter();
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const [meta, setMeta] = useState<ConversationMeta | null>(null);

  const fetchMeta = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/conversations?project_id=${projectId}`);
      if (!res.ok) return;
      const json = await res.json() as { data: Array<{ id: string; title: string | null; type: 'dm' | 'group' }> };
      const conv = json.data.find((c) => c.id === conversation_id);
      if (conv) setMeta({ title: conv.title, type: conv.type });
    } catch { /* non-critical */ }
  }, [conversation_id, projectId]);

  useEffect(() => { void fetchMeta(); }, [fetchMeta]);

  if (!currentTeamMemberId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">로딩 중…</p>
      </div>
    );
  }

  const headerTitle = meta?.title ?? (meta?.type === 'dm' ? 'DM' : '그룹 채팅');

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => router.push('/chats')}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden"
            >
              <ChevronLeft className="h-4 w-4" />
              채팅
            </button>
            <span className="hidden truncate text-sm font-medium lg:block">
              {headerTitle}
            </span>
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <ChatView
          key={conversation_id}
          threadId={conversation_id}
          currentTeamMemberId={currentTeamMemberId}
          threadTitle={headerTitle}
          projectId={projectId}
          apiPrefix="/api/conversations"
        />
      </div>
    </>
  );
}
