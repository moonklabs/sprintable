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
  /** 기본 알림 3종(event_notification/notification/new_notification) 전용 콜백 — extraEventNames만
   * 쓰고 싶은 컨슈머(예: story.trust_stage_changed 구독)는 생략 가능(9ef0f914). */
  onNotification?: (notification: SseEventNotification) => void;
  memberId?: string;
  enabled?: boolean;
  /** 기존 3종 외 추가 named SSE 이벤트 구독(예: `story.trust_stage_changed`) — 동일 커넥션/재연결/
   * backoff 재사용, 별도 EventSource 없음. 원시 payload를 그대로 넘긴다(SseEventNotification
   * shape로 가공하지 않음 — 이벤트별 계약이 서로 다르므로). */
  extraEventNames?: string[];
  onExtraEvent?: (eventName: string, data: unknown) => void;
}

// use-realtime-memos.ts와 동일한 backoff 전략
const RECONNECT_DELAYS_MS = [5_000, 30_000, 60_000, 300_000];

export function useSseNotifications({
  onNotification, memberId, enabled = true, extraEventNames, onExtraEvent,
}: UseSseNotificationsOptions) {
  const callbackRef = useRef(onNotification);
  const memberIdRef = useRef(memberId);
  const extraEventNamesRef = useRef(extraEventNames);
  const onExtraEventRef = useRef(onExtraEvent);
  useEffect(() => { callbackRef.current = onNotification; }, [onNotification]);
  useEffect(() => { memberIdRef.current = memberId; }, [memberId]);
  useEffect(() => { extraEventNamesRef.current = extraEventNames; }, [extraEventNames]);
  useEffect(() => { onExtraEventRef.current = onExtraEvent; }, [onExtraEvent]);

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
        callbackRef.current?.(parsed);
      } catch { /* heartbeat or malformed */ }
    };

    const handleExtraEvent = (eventName: string, raw: string, eventId?: string) => {
      if (eventId) lastEventId = eventId;
      if (!raw || raw.trim() === '') return;
      try {
        onExtraEventRef.current?.(eventName, JSON.parse(raw));
      } catch { /* malformed */ }
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

      for (const eventName of extraEventNamesRef.current ?? []) {
        es.addEventListener(eventName, (e: Event) => {
          const me = e as MessageEvent<string>;
          handleExtraEvent(eventName, me.data, me.lastEventId || undefined);
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
