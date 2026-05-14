'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ChatBubble } from './chat-bubble';
import { ChatInput } from './chat-input';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { normalizeToMessage, useChatSse } from '@/hooks/use-chat-sse';
import { EmptyState } from '@/components/ui/empty-state';

interface ChatViewProps {
  threadId: string;
  currentTeamMemberId: string;
  threadTitle?: string | null;
  projectId?: string;
  apiPrefix?: string;
}

interface MessageGroup {
  date: string;
  messages: ChatMessage[];
}

function groupByDate(messages: ChatMessage[]): MessageGroup[] {
  const groups: Record<string, ChatMessage[]> = {};
  for (const msg of messages) {
    const date = new Date(msg.created_at).toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    (groups[date] ??= []).push(msg);
  }
  return Object.entries(groups).map(([date, msgs]) => ({ date, messages: msgs }));
}

export function ChatView({ threadId, currentTeamMemberId, threadTitle, projectId, apiPrefix = '/api/chats' }: ChatViewProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const isFirstLoad = useRef(true);

  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' });
  }, []);

  const fetchMessages = useCallback(async (before?: string) => {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (before) params.set('before', before);
      const res = await fetch(`${apiPrefix}/${threadId}/messages?${params.toString()}`);
      if (!res.ok) return;
      // Backend: { data: _to_chat_message[], meta: { next_cursor, has_more } }
      const raw = await res.json() as Record<string, unknown>;
      const rawData = (Array.isArray(raw) ? raw : (raw.data ?? [])) as Record<string, unknown>[];
      const meta = Array.isArray(raw) ? null : raw.meta as { next_cursor?: string; has_more?: boolean } | undefined;
      const data = rawData.map(normalizeToMessage);
      if (before) {
        setMessages((prev) => [...data, ...prev]);
      } else {
        setMessages(data);
      }
      setCursor(meta?.next_cursor ?? null);
      setHasMore(meta?.has_more ?? false);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [threadId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    if (!loading && isFirstLoad.current) {
      scrollToBottom();
      isFirstLoad.current = false;
    }
  }, [loading, scrollToBottom]);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    setTimeout(() => scrollToBottom(true), 50);
  }, [scrollToBottom]);

  const handleNewMessage = useCallback((msg: ChatMessage) => {
    if (msg.memo_id !== threadId) return;
    addMessage(msg);
  }, [threadId, addMessage]);

  const handleReplyCreated = useCallback((memoId: string) => {
    if (memoId !== threadId) return;
    // reply_created SSE: refetch to pick up messages not delivered via chat:message
    fetchMessages();
  }, [threadId, fetchMessages]);

  // HIGH-2: conversation:message SSE — payload uses conversation_id (normalizeToMessage maps it to memo_id)
  const handleConversationMessage = useCallback((payload: Record<string, unknown>) => {
    const conversationId = (payload.conversation_id ?? payload.id) as string | undefined;
    if (conversationId !== threadId) return;
    addMessage(normalizeToMessage(payload));
  }, [threadId, addMessage]);

  useChatSse({
    currentTeamMemberId,
    onNewMessage: handleNewMessage,
    onReplyCreated: handleReplyCreated,
    onConversationMessage: handleConversationMessage,
  });

  const handleSend = useCallback(async (content: string, mentionedIds?: string[]) => {
    const body: Record<string, unknown> = { content };
    if (mentionedIds && mentionedIds.length > 0) body.mentioned_ids = mentionedIds;
    const res = await fetch(`${apiPrefix}/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to send message');
    // Backend: { data: _to_chat_message }
    const raw = await res.json() as Record<string, unknown>;
    const payload = (raw.data ?? raw) as Record<string, unknown>;
    addMessage(normalizeToMessage(payload));
  }, [threadId, addMessage]);

  const handleUpload = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`/api/chats/${threadId}/messages/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error('Failed to upload file');
    const raw = await res.json() as Record<string, unknown>;
    const payload = (raw.data ?? raw) as Record<string, unknown>;
    addMessage(normalizeToMessage(payload));
  }, [threadId, addMessage]);

  const handleLoadMore = useCallback(async () => {
    if (!hasMore || !cursor || loadingMore) return;
    const scrollEl = scrollRef.current;
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0;
    setLoadingMore(true);
    await fetchMessages(cursor);
    if (scrollEl) {
      scrollEl.scrollTop += scrollEl.scrollHeight - prevScrollHeight;
    }
  }, [hasMore, cursor, loadingMore, fetchMessages]);

  // Auto-load when scrolled to top (IntersectionObserver watches topSentinelRef inside scrollRef)
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = scrollRef.current;
    if (!sentinel || !container || loading) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && hasMore && !loadingMore) {
          void handleLoadMore();
        }
      },
      { root: container, threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, loadingMore, handleLoadMore]);

  const groups = groupByDate(messages);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Mobile back nav (< lg) */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/80 px-3 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => router.push('/memos')}
          className="flex min-h-[44px] items-center gap-1 px-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          메모
        </button>
        {threadTitle && (
          <span className="truncate text-sm font-medium text-foreground">{threadTitle}</span>
        )}
      </div>

      {/* Desktop thread title (lg+) */}
      {threadTitle && (
        <div className="hidden flex-shrink-0 border-b border-border/80 px-4 py-2.5 lg:flex">
          <h2 className="truncate text-sm font-medium text-foreground">{threadTitle}</h2>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">불러오는 중…</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              title="대화를 시작하세요"
              description="첫 메시지를 보내면 대화가 시작됩니다."
              className="w-full max-w-xs"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* sentinel: IntersectionObserver triggers auto-load when scrolled to top */}
            <div ref={topSentinelRef} className="h-px w-full" />
            {hasMore && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void handleLoadMore()}
                  disabled={loadingMore}
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {loadingMore ? '불러오는 중…' : '이전 메시지 보기'}
                </button>
              </div>
            )}

            {groups.map((group) => (
              <div key={group.date} className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-border/60" />
                  <span className="text-[11px] text-muted-foreground">{group.date}</span>
                  <div className="h-px flex-1 bg-border/60" />
                </div>

                {group.messages.map((msg) => (
                  <ChatBubble
                    key={msg.id}
                    message={msg}
                    isMine={msg.created_by === currentTeamMemberId}
                  />
                ))}
              </div>
            ))}

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        onUpload={handleUpload}
        projectId={projectId}
        placeholder="메시지를 입력하세요… (Enter 전송 / Shift+Enter 줄바꿈 / @ 멘션 / # 엔티티)"
      />
    </div>
  );
}
