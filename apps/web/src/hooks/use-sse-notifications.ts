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
  enabled?: boolean;
}

export function useSseNotifications({ onNotification, enabled = true }: UseSseNotificationsOptions) {
  // ref로 callback 최신화 — EventSource Effect 재실행 방지
  const callbackRef = useRef(onNotification);
  useEffect(() => { callbackRef.current = onNotification; }, [onNotification]);

  useEffect(() => {
    if (!enabled) return;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/event-stream', { withCredentials: true });

      const handleData = (raw: string) => {
        if (!raw || raw.trim() === '') return;
        try {
          const parsed = JSON.parse(raw) as SseEventNotification;
          callbackRef.current(parsed);
        } catch { /* noop — heartbeat or malformed */ }
      };

      es.onmessage = (e: MessageEvent<string>) => handleData(e.data);

      // named event 타입도 처리
      for (const eventName of ['event_notification', 'notification', 'new_notification']) {
        es.addEventListener(eventName, (e: Event) => {
          handleData((e as MessageEvent<string>).data);
        });
      }

      es.onerror = () => {
        es?.close();
        es = null;
        if (!closed) {
          // 3초 후 재연결
          retryTimer = setTimeout(connect, 3000);
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
