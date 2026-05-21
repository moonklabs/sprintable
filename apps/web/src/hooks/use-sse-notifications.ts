'use client';

import { useEffect, useRef } from 'react';

export interface SseEventNotification {
  id?: string;
  event_type: string;
  source_entity_type: string | null;
  source_entity_id: string | null;
  payload: {
    summary?: string;
    sender_name?: string;
    slug?: string;
    [key: string]: unknown;
  } | null;
  read_at: string | null;
  created_at: string;
}

interface UseSseNotificationsOptions {
  onNotification: (notification: SseEventNotification) => void;
  memberId?: string;
  enabled?: boolean;
}

// use-realtime-memos.ts와 동일한 backoff 전략
const RECONNECT_DELAYS_MS = [5_000, 30_000, 60_000, 300_000];

export function useSseNotifications({ onNotification, memberId, enabled = true }: UseSseNotificationsOptions) {
  const callbackRef = useRef(onNotification);
  const memberIdRef = useRef(memberId);
  useEffect(() => { callbackRef.current = onNotification; }, [onNotification]);
  useEffect(() => { memberIdRef.current = memberId; }, [memberId]);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let reconnectAttempts = 0;
    let lastEventId: string | null = null;

    const handleData = (raw: string, eventId?: string) => {
      if (eventId) lastEventId = eventId;
      if (!raw || raw.trim() === '') return;
      try {
        const parsed = JSON.parse(raw) as SseEventNotification;
        callbackRef.current(parsed);
      } catch { /* heartbeat or malformed */ }
    };

    const connect = () => {
      if (closed) return;
      es?.close();

      const url = new URL('/api/event-stream', window.location.origin);
      if (memberIdRef.current) url.searchParams.set('member_id', memberIdRef.current);
      if (lastEventId) url.searchParams.set('last_event_id', lastEventId);

      es = new EventSource(url.toString(), { withCredentials: true });

      es.onopen = () => { reconnectAttempts = 0; };

      es.onmessage = (e: MessageEvent<string>) => handleData(e.data, e.lastEventId || undefined);

      for (const eventName of ['event_notification', 'notification', 'new_notification']) {
        es.addEventListener(eventName, (e: Event) => {
          const me = e as MessageEvent<string>;
          handleData(me.data, me.lastEventId || undefined);
        });
      }

      es.onerror = () => {
        es?.close();
        es = null;
        if (!closed && !retryTimer) {
          const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
          reconnectAttempts += 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
          }, delay);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [enabled]);
}
