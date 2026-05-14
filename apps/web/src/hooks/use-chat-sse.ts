'use client';

import { useEffect, useRef, useState } from 'react';

// Mirrors backend _to_chat_message: { id, thread_id, sender: { id, name, type }, ... }
export interface ChatMessage {
  id: string;
  memo_id: string;        // backend: thread_id
  created_by: string;     // backend: sender.id
  sender_name: string;    // backend: sender.name
  sender_type: string;    // backend: sender.type ('human' | 'agent')
  content: string;
  review_type?: string;
  attachments: Array<{ url?: string; name?: string; content_type?: string; filename?: string }>;
  created_at: string;
}

// Normalize backend _to_chat_message format → ChatMessage
export function normalizeToMessage(raw: Record<string, unknown>): ChatMessage {
  const sender = raw.sender as { id?: string; name?: string; type?: string } | undefined;
  return {
    id: (raw.id ?? '') as string,
    memo_id: (raw.thread_id ?? raw.memo_id ?? '') as string,
    created_by: (raw.created_by ?? sender?.id ?? '') as string,
    sender_name: (sender?.name ?? '') as string,
    sender_type: (sender?.type ?? 'human') as string,
    content: (raw.content ?? '') as string,
    attachments: (raw.attachments ?? []) as ChatMessage['attachments'],
    created_at: (raw.created_at ?? '') as string,
  };
}

// Backend SSE chat:message payload format (_to_chat_message)
interface SseChatPayload {
  id: string;
  thread_id: string;
  content: string;
  sender: { id: string; name?: string; type?: string };
  attachments: unknown[];
  created_at: string;
}

interface UseChatSseOptions {
  currentTeamMemberId?: string;
  onNewMessage?: (message: ChatMessage) => void;
  onReplyCreated?: (memoId: string) => void;
  onConversationMessage?: (payload: Record<string, unknown>) => void;
}

const RECONNECT_DELAYS_MS = [5_000, 30_000, 60_000, 300_000];

export function useChatSse({ currentTeamMemberId, onNewMessage, onReplyCreated, onConversationMessage }: UseChatSseOptions) {
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const onNewMessageRef = useRef(onNewMessage);
  const onReplyCreatedRef = useRef(onReplyCreated);
  const onConversationMessageRef = useRef(onConversationMessage);
  const memberIdRef = useRef(currentTeamMemberId);

  useEffect(() => { onNewMessageRef.current = onNewMessage; }, [onNewMessage]);
  useEffect(() => { onReplyCreatedRef.current = onReplyCreated; }, [onReplyCreated]);
  useEffect(() => { onConversationMessageRef.current = onConversationMessage; }, [onConversationMessage]);
  useEffect(() => { memberIdRef.current = currentTeamMemberId; }, [currentTeamMemberId]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    function connect() {
      sourceRef.current?.close();
      sourceRef.current = null;

      const url = new URL('/api/v2/events/memos', window.location.origin);
      if (memberIdRef.current) url.searchParams.set('member_id', memberIdRef.current);

      const source = new EventSource(url.toString());
      sourceRef.current = source;

      source.onopen = () => {
        setConnected(true);
        reconnectAttemptsRef.current = 0;
      };

      source.onerror = () => {
        setConnected(false);
        source.close();
        sourceRef.current = null;
        if (!reconnectTimerRef.current) {
          const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttemptsRef.current, RECONNECT_DELAYS_MS.length - 1)];
          reconnectAttemptsRef.current += 1;
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, delay);
        }
      };

      // chat:message — backend _to_chat_message format: { id, thread_id, sender: { id }, ... }
      source.addEventListener('chat:message', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data as string) as SseChatPayload;
          onNewMessageRef.current?.(normalizeToMessage(payload as unknown as Record<string, unknown>));
        } catch { /* ignore parse errors */ }
      });

      // reply_created — from memos.py publish_event; use as refetch trigger
      source.addEventListener('reply_created', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data as string) as { id?: string; memo_id?: string };
          if (payload.memo_id) onReplyCreatedRef.current?.(payload.memo_id);
        } catch { /* ignore parse errors */ }
      });

      // conversation:message — realtime update for conversation list
      source.addEventListener('conversation:message', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data as string) as Record<string, unknown>;
          onConversationMessageRef.current?.(payload);
        } catch { /* ignore parse errors */ }
      });
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  return { connected };
}
