'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Mirrors backend _to_chat_message: { id, thread_id, sender: { id, name, type }, ... }
export interface ChatMessage {
  id: string;
  memo_id: string;        // backend: thread_id (conversation_id for group chats)
  created_by: string;     // backend: sender.id
  sender_name: string;    // backend: sender.name
  sender_type: string;    // backend: sender.type ('human' | 'agent')
  content: string;
  review_type?: string;
  attachments: Array<{ url?: string; name?: string; content_type?: string; filename?: string }>;
  created_at: string;
  // CB-S9: thread fields
  parent_id?: string | null;    // null = top-level message; set = this is a thread reply
  reply_count?: number;
  last_reply_at?: string | null;
}

// Normalize backend _to_chat_message format → ChatMessage
export function normalizeToMessage(raw: Record<string, unknown>): ChatMessage {
  const sender = raw.sender as { id?: string; name?: string; type?: string } | undefined;
  return {
    id: (raw.id ?? '') as string,
    // conversation:message uses conversation_id; chat:message uses thread_id or memo_id
    memo_id: (raw.thread_id ?? raw.memo_id ?? raw.conversation_id ?? '') as string,
    created_by: (raw.created_by ?? sender?.id ?? '') as string,
    sender_name: (sender?.name ?? '') as string,
    sender_type: (sender?.type ?? 'human') as string,
    content: (raw.content ?? '') as string,
    attachments: (raw.attachments ?? []) as ChatMessage['attachments'],
    created_at: (raw.created_at ?? '') as string,
    // P1 RC: backend sends thread_id as parent pointer; raw.parent_id may be absent
    parent_id: (raw.parent_id ?? raw.thread_id ?? null) as string | null,
    reply_count: (raw.reply_count ?? 0) as number,
    last_reply_at: (raw.last_reply_at ?? null) as string | null,
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
  onReconnect?: () => void;
}

const RECONNECT_DELAYS_MS = [5_000, 30_000, 60_000, 300_000];

export function useChatSse({ currentTeamMemberId, onNewMessage, onReplyCreated, onConversationMessage, onReconnect }: UseChatSseOptions) {
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const lastEventIdRef = useRef<string | null>(null);
  const onNewMessageRef = useRef(onNewMessage);
  const onReplyCreatedRef = useRef(onReplyCreated);
  const onConversationMessageRef = useRef(onConversationMessage);
  const onReconnectRef = useRef(onReconnect);
  const memberIdRef = useRef(currentTeamMemberId);

  // useLayoutEffect: DOM commit 후 동기 실행 — useEffect(비동기)보다 먼저 실행되어
  // SSE 이벤트 도달 전에 ref가 항상 최신 콜백을 가리킴 (stale closure 방지)
  useLayoutEffect(() => { onNewMessageRef.current = onNewMessage; }, [onNewMessage]);
  useLayoutEffect(() => { onReplyCreatedRef.current = onReplyCreated; }, [onReplyCreated]);
  useLayoutEffect(() => { onConversationMessageRef.current = onConversationMessage; }, [onConversationMessage]);
  useLayoutEffect(() => { onReconnectRef.current = onReconnect; }, [onReconnect]);
  useLayoutEffect(() => { memberIdRef.current = currentTeamMemberId; }, [currentTeamMemberId]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    function connect() {
      sourceRef.current?.close();
      sourceRef.current = null;

      const url = new URL('/api/v2/events/memos', window.location.origin);
      if (memberIdRef.current) url.searchParams.set('member_id', memberIdRef.current);
      if (lastEventIdRef.current) url.searchParams.set('last_event_id', lastEventIdRef.current);

      const source = new EventSource(url.toString());
      sourceRef.current = source;

      source.onopen = () => {
        const isReconnect = reconnectAttemptsRef.current > 0;
        setConnected(true);
        reconnectAttemptsRef.current = 0;
        // AC4: 재연결 시 backfill 트리거
        if (isReconnect) onReconnectRef.current?.();
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
        if (e.lastEventId) lastEventIdRef.current = e.lastEventId;
        try {
          const payload = JSON.parse(e.data as string) as SseChatPayload;
          onNewMessageRef.current?.(normalizeToMessage(payload as unknown as Record<string, unknown>));
        } catch { /* ignore parse errors */ }
      });

      // reply_created — from memos.py publish_event; use as refetch trigger
      source.addEventListener('reply_created', (e: MessageEvent) => {
        if (e.lastEventId) lastEventIdRef.current = e.lastEventId;
        try {
          const payload = JSON.parse(e.data as string) as { id?: string; memo_id?: string };
          if (payload.memo_id) onReplyCreatedRef.current?.(payload.memo_id);
        } catch { /* ignore parse errors */ }
      });

      // conversation:message — realtime update for conversation list
      source.addEventListener('conversation:message', (e: MessageEvent) => {
        if (e.lastEventId) lastEventIdRef.current = e.lastEventId;
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
