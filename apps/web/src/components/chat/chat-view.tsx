'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, RefreshCw } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { ChatBubble } from './chat-bubble';
import { ChatInput } from './chat-input';
import { ThreadPanel } from './thread-panel';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { normalizeToMessage, useChatSse } from '@/hooks/use-chat-sse';
import { EmptyState } from '@/components/ui/empty-state';

interface ChatViewProps {
  threadId: string;
  currentTeamMemberId: string;
  threadTitle?: string | null;
  projectId?: string;
  apiPrefix?: string;
  backRoute?: string | null;
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

export function ChatView({ threadId, currentTeamMemberId, threadTitle, projectId, apiPrefix = '/api/chats', backRoute = '/memos' }: ChatViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [showNewIndicator, setShowNewIndicator] = useState(false);
  // CB-S9: 스레드 패널 상태
  const [activeThread, setActiveThread] = useState<ChatMessage | null>(null);
  const [threadIncoming, setThreadIncoming] = useState<ChatMessage | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const isFirstLoad = useRef(true);
  // CB-S8: render 후 스크롤 트리거용 ref (setTimeout 패턴 대체)
  const shouldScrollToBottomRef = useRef(false);
  // CB-S8: pull-to-refresh 터치 추적
  const touchStartYRef = useRef<number | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const PULL_THRESHOLD = 64;

  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' });
  }, []);

  // AC2: 하단 50px 이내인지 판별
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 50;
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
  }, [threadId, apiPrefix]);

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
    const nearBottom = isNearBottom();
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    // CB-S8: setTimeout 대신 ref 플래그 → render 완료 후 useEffect에서 스크롤
    if (nearBottom) {
      shouldScrollToBottomRef.current = true;
    } else {
      setShowNewIndicator(true);
    }
  }, [isNearBottom]);

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
    const msg = normalizeToMessage(payload);
    // CB-S9: thread reply → inject into thread panel; top-level → add to main + update reply_count
    if (msg.parent_id) {
      setThreadIncoming(msg);
      // Update reply_count on parent message in the main list
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.parent_id
            ? { ...m, reply_count: (m.reply_count ?? 0) + 1, last_reply_at: msg.created_at }
            : m,
        ),
      );
    } else {
      addMessage(msg);
    }
  }, [threadId, addMessage]);

  // AC4: 재연결 시 누락 메시지 backfill
  const handleReconnect = useCallback(() => {
    fetchMessages();
  }, [fetchMessages]);

  useChatSse({
    currentTeamMemberId,
    onNewMessage: handleNewMessage,
    onReplyCreated: handleReplyCreated,
    onConversationMessage: handleConversationMessage,
    onReconnect: handleReconnect,
  });

  // CB-S8: 모바일 pull-to-refresh — 스크롤 최상단에서 아래로 당기면 새로고침
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const el = scrollRef.current;
    if (!el || el.scrollTop > 0) return;
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartYRef.current === null) return;
    const delta = (e.touches[0]?.clientY ?? 0) - touchStartYRef.current;
    if (delta > 0) {
      setPullDistance(Math.min(delta, PULL_THRESHOLD * 1.5));
    }
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (pullDistance >= PULL_THRESHOLD) {
      setIsRefreshing(true);
      await fetchMessages();
      setIsRefreshing(false);
    }
    setPullDistance(0);
    touchStartYRef.current = null;
  }, [pullDistance, fetchMessages]);

  // CB-S9: 메시지 삭제 (본인 메시지만)
  const handleDeleteMessage = useCallback(async (messageId: string) => {
    const res = await fetch(`${apiPrefix}/${threadId}/messages/${messageId}`, { method: 'DELETE' });
    if (!res.ok) return;
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, [apiPrefix, threadId]);

  const handleSend = useCallback(async (content: string, mentionedIds?: string[]) => {
    const body: Record<string, unknown> = { content };
    if (mentionedIds && mentionedIds.length > 0) body.mentioned_ids = mentionedIds;
    const res = await fetch(`${apiPrefix}/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to send message');
    // Backend: { data: _to_chat_message } or { forked: true, forked_conversation_id, data }
    const raw = await res.json() as Record<string, unknown>;
    // AC3: DM fork 응답 감지 → 새 그룹 conversation으로 자동 네비게이션
    if (raw.forked === true && typeof raw.forked_conversation_id === 'string') {
      const newPath = pathname.replace(threadId, raw.forked_conversation_id);
      router.push(newPath);
      return;
    }
    const payload = (raw.data ?? raw) as Record<string, unknown>;
    addMessage(normalizeToMessage(payload));
  }, [threadId, addMessage, apiPrefix, pathname, router]);

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

  // CB-S8: 매 render 후 플래그 확인 → DOM에 새 메시지 반영된 직후 스크롤
  useEffect(() => {
    if (shouldScrollToBottomRef.current) {
      shouldScrollToBottomRef.current = false;
      scrollToBottom(true);
    }
  });

  // 스크롤을 직접 내리면 인디케이터 자동 해제
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { if (isNearBottom()) setShowNewIndicator(false); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isNearBottom]);

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

  // CB-S9: 모바일에서 스레드 뷰로 전환 중인지 (< lg)
  const isMobileThreadView = activeThread !== null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Mobile back nav — 스레드 뷰 중이면 스레드 뒤로가기 표시 (AC8) */}
      {(backRoute || isMobileThreadView) && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/80 px-3 py-2 lg:hidden">
          <button
            type="button"
            onClick={() => {
              if (isMobileThreadView) { setActiveThread(null); }
              else if (backRoute) { router.push(backRoute); }
            }}
            className="flex min-h-[44px] items-center gap-1 px-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            {isMobileThreadView ? '대화' : '메모'}
          </button>
          <span className="truncate text-sm font-medium text-foreground">
            {isMobileThreadView ? '스레드' : (threadTitle ?? '')}
          </span>
        </div>
      )}

      {/* Desktop thread title (lg+) — 스레드 패널 없을 때만 표시 */}
      {threadTitle && !activeThread && (
        <div className="hidden flex-shrink-0 border-b border-border/80 px-4 py-2.5 lg:flex">
          <h2 className="truncate text-sm font-medium text-foreground">{threadTitle}</h2>
        </div>
      )}

      {/* Body: main chat + optional thread panel (side-by-side on desktop) */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* Main chat — AC8: 모바일에서 스레드 뷰 활성 시 hidden */}
        <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${isMobileThreadView ? 'hidden lg:flex' : 'flex'}`}>
          {/* Messages */}
          <div
            ref={scrollRef}
            className="relative flex-1 overflow-y-auto px-4 py-3"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={() => void handleTouchEnd()}
          >
            {/* CB-S8: pull-to-refresh 인디케이터 */}
            {(pullDistance > 0 || isRefreshing) && (
              <div
                className="pointer-events-none flex justify-center pb-2 transition-all"
                style={{ height: isRefreshing ? 40 : pullDistance * 0.6 }}
              >
                <RefreshCw
                  className={`h-5 w-5 text-muted-foreground transition-transform ${isRefreshing ? 'animate-spin' : ''}`}
                  style={{ transform: `rotate(${(pullDistance / PULL_THRESHOLD) * 180}deg)` }}
                />
              </div>
            )}
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

                    {group.messages.map((msg, idx) => {
                      const prev = group.messages[idx - 1];
                      const isGrouped = Boolean(prev && prev.created_by === msg.created_by);
                      return (
                        <ChatBubble
                          key={msg.id}
                          message={msg}
                          isMine={msg.created_by === currentTeamMemberId}
                          isGrouped={isGrouped}
                          onOpenThread={setActiveThread}
                          onDelete={handleDeleteMessage}
                        />
                      );
                    })}
                  </div>
                ))}

                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* AC2(CB-S8): 새 메시지 인디케이터 */}
          {showNewIndicator && (
            <div className="flex flex-shrink-0 justify-center py-1">
              <button
                type="button"
                onClick={() => { setShowNewIndicator(false); scrollToBottom(true); }}
                className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-primary shadow-sm transition-colors hover:bg-muted/50"
              >
                ↓ 새 메시지
              </button>
            </div>
          )}

          {/* Input */}
          <ChatInput
            onSend={handleSend}
            onUpload={handleUpload}
            projectId={projectId}
            placeholder="메시지를 입력하세요… (Enter 전송 / Shift+Enter 줄바꿈 / @ 멘션 / # 엔티티)"
          />
        </div>

        {/* AC7/AC8: 스레드 패널 — 데스크톱 사이드 패널 / 모바일 전체 뷰 */}
        {activeThread && (
          <div className={`flex flex-col overflow-hidden ${isMobileThreadView ? 'flex-1' : 'hidden w-80 flex-shrink-0 lg:flex'}`}>
            <ThreadPanel
              key={activeThread.id}
              parentMessage={activeThread}
              conversationId={threadId}
              currentTeamMemberId={currentTeamMemberId}
              projectId={projectId}
              onClose={() => setActiveThread(null)}
              incomingMessage={threadIncoming?.parent_id === activeThread.id ? threadIncoming : null}
            />
          </div>
        )}
      </div>
    </div>
  );
}
