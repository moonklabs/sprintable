'use client';

import { useEffect, useRef, useState } from 'react';

// Mirrors backend ReplyResponse schema
export interface ChatMessage {
  id: string;
  memo_id: string;       // thread ID (MemoReply.memo_id)
  created_by: string;    // sender team_member_id
  content: string;
  review_type?: string;
  attachments: Array<{ url?: string; name?: string; content_type?: string; filename?: string }>;
  created_at: string;
}

interface SseChatPayload {
  thread_id: string;
  reply_id: string;
  content: string;
  created_by: string;
  attachments: unknown[];
  created_at: string;
}

interface UseChatSseOptions {
  currentTeamMemberId?: string;
  onNewMessage?: (message: ChatMessage) => void;
  onReplyCreated?: (memoId: string) => void;
}

const RECONNECT_DELAYS_MS = [5_000, 30_000, 60_000, 300_000];

export function useChatSse({ currentTeamMemberId, onNewMessage, onReplyCreated }: UseChatSseOptions) {
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const onNewMessageRef = useRef(onNewMessage);
  const onReplyCreatedRef = useRef(onReplyCreated);
  const memberIdRef = useRef(currentTeamMemberId);

  useEffect(() => { onNewMessageRef.current = onNewMessage; }, [onNewMessage]);
  useEffect(() => { onReplyCreatedRef.current = onReplyCreated; }, [onReplyCreated]);
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

      // chat:message — from agent-push events (when backend publishes via _push_to_agent)
      source.addEventListener('chat:message', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data as string) as SseChatPayload;
          const msg: ChatMessage = {
            id: payload.reply_id,
            memo_id: payload.thread_id,
            created_by: payload.created_by,
            content: payload.content,
            attachments: (payload.attachments ?? []) as ChatMessage['attachments'],
            created_at: payload.created_at,
          };
          onNewMessageRef.current?.(msg);
        } catch { /* ignore parse errors */ }
      });

      // reply_created — from memos.py publish_event; use as refetch trigger
      source.addEventListener('reply_created', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data as string) as { id?: string; memo_id?: string };
          if (payload.memo_id) onReplyCreatedRef.current?.(payload.memo_id);
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
