'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import { normalizeToMessage } from '@/hooks/use-chat-sse';
import { ChatBubble } from './chat-bubble';
import { ChatInput } from './chat-input';

interface ThreadPanelProps {
  parentMessage: ChatMessage;
  conversationId: string;
  currentTeamMemberId: string;
  projectId?: string;
  onClose: () => void;
  // Injected by parent SSE to push new thread messages
  incomingMessage?: ChatMessage | null;
}

export function ThreadPanel({
  parentMessage,
  conversationId,
  currentTeamMemberId,
  projectId,
  onClose,
  incomingMessage,
}: ThreadPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchThreadMessages = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/conversations/${conversationId}/messages?thread_id=${parentMessage.id}`,
      );
      if (!res.ok) return;
      const raw = await res.json() as Record<string, unknown>;
      const rawData = (Array.isArray(raw) ? raw : (raw.data ?? [])) as Record<string, unknown>[];
      setMessages(rawData.map(normalizeToMessage));
    } finally {
      setLoading(false);
    }
  }, [conversationId, parentMessage.id]);

  useEffect(() => {
    void fetchThreadMessages();
  }, [fetchThreadMessages]);

  // Scroll to bottom on load
  useEffect(() => {
    if (!loading) bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [loading]);

  // AC10: Inject new messages from parent SSE (parent filters by thread_id)
  useEffect(() => {
    if (!incomingMessage) return;
    setMessages((prev) => {
      if (prev.some((m) => m.id === incomingMessage.id)) return prev;
      return [...prev, incomingMessage];
    });
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }, [incomingMessage]);

  const handleSend = useCallback(async (content: string, mentionedIds?: string[]) => {
    const body: Record<string, unknown> = { content, thread_id: parentMessage.id };
    if (mentionedIds && mentionedIds.length > 0) body.mentioned_ids = mentionedIds;
    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to send thread reply');
    const raw = await res.json() as Record<string, unknown>;
    const payload = (raw.data ?? raw) as Record<string, unknown>;
    const msg = normalizeToMessage(payload);
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }, [conversationId, parentMessage.id]);

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border bg-background">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border/80 px-4 py-2.5">
        <span className="text-sm font-medium text-foreground">스레드</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="스레드 닫기"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* AC9: 원본 메시지 */}
      <div className="flex-shrink-0 border-b border-border/60 bg-muted/30 px-4 py-3">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">원본 메시지</p>
        <ChatBubble
          message={parentMessage}
          isMine={parentMessage.created_by === currentTeamMemberId}
          isGrouped={false}
        />
      </div>

      {/* Thread messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <p className="text-center text-sm text-muted-foreground">불러오는 중…</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">아직 답글이 없는.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((msg, idx) => {
              const prev = messages[idx - 1];
              const isGrouped = Boolean(prev && prev.created_by === msg.created_by);
              return (
                <ChatBubble
                  key={msg.id}
                  message={msg}
                  isMine={msg.created_by === currentTeamMemberId}
                  isGrouped={isGrouped}
                />
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        projectId={projectId}
        placeholder="답글을 입력하세요… (Enter 전송 / Shift+Enter 줄바꿈)"
      />
    </div>
  );
}
