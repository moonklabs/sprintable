'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Plus, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { NewConversationModal } from './new-conversation-modal';
import { useChatSse } from '@/hooks/use-chat-sse';

interface ConversationItem {
  id: string;
  type: 'dm' | 'group';
  title: string | null;
  latest_message: { content: string; created_at: string } | null;
  updated_at: string;
  unread_count?: number;
}

interface ChatListViewProps {
  projectId: string;
  currentTeamMemberId: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return '어제';
  if (diffDays < 7) return `${diffDays}일 전`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function ConversationRow({
  conv,
  onClick,
}: {
  conv: ConversationItem;
  onClick: () => void;
}) {
  const t = useTranslations('chats');
  const displayName = conv.title ?? (conv.type === 'dm' ? t('dmWith') : '그룹 채팅');
  const preview = conv.latest_message?.content ?? t('noMessages');
  const time = conv.latest_message?.created_at ?? conv.updated_at;
  const unread = conv.unread_count ?? 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-muted/60 active:bg-muted"
    >
      {/* Avatar */}
      <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium ${
        conv.type === 'dm'
          ? 'bg-primary/15 text-primary'
          : 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
      }`}>
        {conv.type === 'dm' ? <MessageSquare className="h-4 w-4" /> : <Users className="h-4 w-4" />}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
          <span className="flex-shrink-0 text-[10px] text-muted-foreground">{formatTime(time)}</span>
        </div>
        <div className="flex items-center justify-between gap-1">
          <p className="truncate text-xs text-muted-foreground">{preview}</p>
          {unread > 0 && (
            <span className="flex-shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export function ChatListView({ projectId, currentTeamMemberId }: ChatListViewProps) {
  const t = useTranslations('chats');
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const convsRef = useRef(conversations);
  useEffect(() => { convsRef.current = conversations; }, [conversations]);

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations?project_id=${projectId}`);
      if (!res.ok) return;
      const json = await res.json() as { data: ConversationItem[] };
      setConversations(json.data ?? []);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void fetchConversations(); }, [fetchConversations]);

  // AC5: SSE conversation:message → 목록 갱신
  const handleConversationMessage = useCallback((payload: { conversation_id?: string; content?: string; created_at?: string }) => {
    const { conversation_id, content, created_at } = payload;
    if (!conversation_id) return;
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conversation_id);
      if (idx === -1) {
        // 새 대화 등장 시 전체 리페치
        void fetchConversations();
        return prev;
      }
      const updated = [...prev];
      const item = { ...updated[idx]! };
      if (content && created_at) {
        item.latest_message = { content, created_at };
        item.updated_at = created_at;
        item.unread_count = (item.unread_count ?? 0) + 1;
      }
      updated.splice(idx, 1);
      return [item, ...updated];
    });
  }, [fetchConversations]);

  useChatSse({
    currentTeamMemberId,
    onConversationMessage: handleConversationMessage,
  });

  const handleCreated = (conversationId: string) => {
    setShowModal(false);
    router.push(`/chats/${conversationId}`);
  };

  const dmConvs = conversations.filter((c) => c.type === 'dm');
  const groupConvs = conversations.filter((c) => c.type === 'group');

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border/80 px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <Button size="sm" variant="outline" onClick={() => setShowModal(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('newConversation')}
        </Button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">불러오는 중…</p>
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              title={t('noConversations')}
              description={t('startNewConversation')}
              className="w-full max-w-xs"
            />
          </div>
        ) : (
          <div className="space-y-4">
            {/* DM section */}
            {dmConvs.length > 0 && (
              <div>
                <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('dmSection')}
                </p>
                {dmConvs.map((conv) => (
                  <ConversationRow
                    key={conv.id}
                    conv={conv}
                    onClick={() => router.push(`/chats/${conv.id}`)}
                  />
                ))}
              </div>
            )}

            {/* Group section */}
            {groupConvs.length > 0 && (
              <div>
                <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('groupSection')}
                </p>
                {groupConvs.map((conv) => (
                  <ConversationRow
                    key={conv.id}
                    conv={conv}
                    onClick={() => router.push(`/chats/${conv.id}`)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {showModal && (
        <NewConversationModal
          projectId={projectId}
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
