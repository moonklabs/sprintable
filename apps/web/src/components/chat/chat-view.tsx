'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatBubble } from './chat-bubble';
import { ChatInput } from './chat-input';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { useChatSse } from '@/hooks/use-chat-sse';
import { EmptyState } from '@/components/ui/empty-state';

interface ChatViewProps {
  threadId: string;
  currentTeamMemberId: string;
  threadTitle?: string | null;
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

export function ChatView({ threadId, currentTeamMemberId, threadTitle }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFirstLoad = useRef(true);

  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' });
  }, []);

  const fetchMessages = useCallback(async (before?: string) => {
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (before) params.set('before', before);
      const res = await fetch(`/api/chats/${threadId}/messages?${params.toString()}`);
      if (!res.ok) return;
      const { data, meta } = await res.json() as {
        data: ChatMessage[];
        meta: { next_cursor?: string; has_more?: boolean };
      };
      if (before) {
        setMessages((prev) => [...(data ?? []), ...prev]);
      } else {
        setMessages(data ?? []);
      }
      setCursor(meta?.next_cursor ?? null);
      setHasMore(meta?.has_more ?? false);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [threadId]);

  useEffect(() => {
    setLoading(true);
    isFirstLoad.current = true;
    setMessages([]);
    setCursor(null);
    setHasMore(false);
    void fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    if (!loading && isFirstLoad.current) {
      scrollToBottom();
      isFirstLoad.current = false;
    }
  }, [loading, scrollToBottom]);

  const handleNewMessage = useCallback((msg: ChatMessage) => {
    if (msg.thread_id !== threadId) return;
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    setTimeout(() => scrollToBottom(true), 50);
  }, [threadId, scrollToBottom]);

  useChatSse({ currentTeamMemberId, onNewMessage: handleNewMessage });

  const handleSend = useCallback(async (content: string) => {
    const res = await fetch(`/api/chats/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error('Failed to send message');
    const { data } = await res.json() as { data: ChatMessage };
    setMessages((prev) => {
      if (prev.some((m) => m.id === data.id)) return prev;
      return [...prev, data];
    });
    setTimeout(() => scrollToBottom(true), 50);
  }, [threadId, scrollToBottom]);

  const handleUpload = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`/api/chats/${threadId}/messages/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error('Failed to upload file');
    const { data } = await res.json() as { data: ChatMessage };
    setMessages((prev) => {
      if (prev.some((m) => m.id === data.id)) return prev;
      return [...prev, data];
    });
    setTimeout(() => scrollToBottom(true), 50);
  }, [threadId, scrollToBottom]);

  const handleLoadMore = useCallback(async () => {
    if (!hasMore || !cursor || loadingMore) return;
    const scrollEl = scrollRef.current;
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0;
    setLoadingMore(true);
    await fetchMessages(cursor);
    if (scrollEl) {
      const delta = scrollEl.scrollHeight - prevScrollHeight;
      scrollEl.scrollTop += delta;
    }
  }, [hasMore, cursor, loadingMore, fetchMessages]);

  const groups = groupByDate(messages);

  return (
    <div className="flex h-full flex-col">
      {/* Thread title */}
      {threadTitle && (
        <div className="flex-shrink-0 border-b border-border/80 px-4 py-2.5">
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
            {/* Load more */}
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
                {/* Date separator */}
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-border/60" />
                  <span className="text-[11px] text-muted-foreground">{group.date}</span>
                  <div className="h-px flex-1 bg-border/60" />
                </div>

                {group.messages.map((msg) => (
                  <ChatBubble
                    key={msg.id}
                    message={msg}
                    isMine={msg.sender.id === currentTeamMemberId}
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
        placeholder="메시지를 입력하세요… (Enter 전송 / Shift+Enter 줄바꿈)"
      />
    </div>
  );
}
