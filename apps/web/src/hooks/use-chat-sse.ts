'use client';

import { useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  thread_id: string;
  content: string;
  sender: {
    id: string;
    name: string;
    type: 'human' | 'agent';
  };
  attachments?: Array<{ url: string; name: string; content_type: string }>;
  created_at: string;
}

interface UseChatSseOptions {
  currentTeamMemberId?: string;
  onNewMessage?: (message: ChatMessage) => void;
}

const RECONNECT_DELAYS_MS = [5_000, 30_000, 60_000, 300_000];

export function useChatSse({ currentTeamMemberId, onNewMessage }: UseChatSseOptions) {
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const onNewMessageRef = useRef(onNewMessage);
  const memberIdRef = useRef(currentTeamMemberId);

  useEffect(() => { onNewMessageRef.current = onNewMessage; }, [onNewMessage]);
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

      source.addEventListener('chat:message', (e: MessageEvent) => {
        try {
          onNewMessageRef.current?.(JSON.parse(e.data) as ChatMessage);
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
