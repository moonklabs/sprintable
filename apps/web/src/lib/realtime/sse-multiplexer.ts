'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createReconnectBackoffState } from './sse-reconnect-backoff';

/**
 * story #2078(E-ARCH 0단계) — presence·notification·chat이 각자 EventSource를 열어 탭당 장수
 * 연결이 3개였다(codex 지적: MAX_SSE_CONNECTIONS=100·containerConcurrency=80 모순의 실질
 * 원인 중 하나). 셋 다 같은 엔드포인트(`/api/event-stream?member_id=`)에 붙고 서버 이벤트만
 * named event로 갈릴 뿐이라 — 연결 자체를 하나로 묶고 이름별 구독만 여럿 두면 된다.
 *
 * 이 모듈은 "연결 하나 + named-event 구독 여러 개" 멀티플렉서다. 기존 3개 훅(use-sse-
 * notifications·use-chat-sse·use-team-presence)의 backoff·lastEventId 전략을 그대로
 * 재사용한다(발명 0) — 그 훅들이 각자 열던 EventSource 하나를 이 매니저가 대신 열고, 훅들은
 * `subscribe(eventName, handler)`로 같은 커넥션에 리스너만 얹는다.
 *
 * ⚠️ 리스크(PO 지적): 이벤트 리스너 누락 — 예를 들어 A훅이 붙기 전에 B훅이 먼저 커넥션을
 * 열고, A훅이 나중에 subscribe해도 그 이벤트명에 대한 리스너가 실제 EventSource에 안 걸려
 * 있으면 이벤트가 조용히 유실된다. 이 매니저는 subscribe 호출 시점에 그 이벤트명이 처음이면
 * 즉시 `es.addEventListener`를 붙이므로(지연 attach), 구독 순서와 무관하게 항상 커버된다 —
 * dispatch 시점에 `subscribersRef`를 다시 조회하므로 attach 이후 등록된 구독자도 받는다.
 */

// story #2095 — 재연결 backoff는 sse-reconnect-backoff.ts(공용, use-chat-sse.ts·
// use-sse-notifications.ts 폴백 경로와 동일 모듈 재사용)로 뽑았다.

type EventHandler = (data: string, eventId?: string) => void;

export interface SseMultiplexerHandle {
  /** 이름 있는 SSE 이벤트(예: 'chat:message'·'presence'·'notification') 구독. 구독 순서
   * 무관 — 커넥션이 이미 열려있어도 그 순간부터 즉시 받는다. */
  subscribe: (eventName: string, handler: EventHandler) => () => void;
  /** 이름 없는 기본 `message` 이벤트(use-sse-notifications의 es.onmessage에 해당) 구독. */
  subscribeMessage: (handler: EventHandler) => () => void;
  /** 재연결(open이 처음이 아닐 때)마다 호출 — use-chat-sse의 backfill 트리거용. */
  subscribeReconnect: (handler: () => void) => () => void;
  connected: boolean;
}

export function useSseMultiplexer(memberId: string | undefined, enabled: boolean): SseMultiplexerHandle {
  const [connected, setConnected] = useState(false);

  const namedSubscribersRef = useRef(new Map<string, Set<EventHandler>>());
  const messageSubscribersRef = useRef(new Set<EventHandler>());
  const reconnectSubscribersRef = useRef(new Set<() => void>());
  const attachedEventNamesRef = useRef(new Set<string>());

  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const memberIdRef = useRef(memberId);
  useEffect(() => { memberIdRef.current = memberId; }, [memberId]);

  const dispatchNamed = useCallback((eventName: string, data: string, eventId?: string) => {
    if (eventId) lastEventIdRef.current = eventId;
    for (const handler of namedSubscribersRef.current.get(eventName) ?? []) handler(data, eventId);
  }, []);

  const attachIfNeeded = useCallback((eventName: string) => {
    if (attachedEventNamesRef.current.has(eventName)) return;
    const es = esRef.current;
    if (!es) return; // 커넥션 열리면 connect()가 지금까지 구독된 이름 전부를 attach한다.
    attachedEventNamesRef.current.add(eventName);
    es.addEventListener(eventName, (e: Event) => {
      const me = e as MessageEvent<string>;
      dispatchNamed(eventName, me.data, me.lastEventId || undefined);
    });
  }, [dispatchNamed]);

  const subscribe = useCallback((eventName: string, handler: EventHandler) => {
    if (!namedSubscribersRef.current.has(eventName)) namedSubscribersRef.current.set(eventName, new Set());
    namedSubscribersRef.current.get(eventName)!.add(handler);
    attachIfNeeded(eventName);
    return () => { namedSubscribersRef.current.get(eventName)?.delete(handler); };
  }, [attachIfNeeded]);

  const subscribeMessage = useCallback((handler: EventHandler) => {
    messageSubscribersRef.current.add(handler);
    return () => { messageSubscribersRef.current.delete(handler); };
  }, []);

  const subscribeReconnect = useCallback((handler: () => void) => {
    reconnectSubscribersRef.current.add(handler);
    return () => { reconnectSubscribersRef.current.delete(handler); };
  }, []);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;

    let closed = false;
    const backoff = createReconnectBackoffState();

    const connect = () => {
      if (closed) return;
      esRef.current?.close();

      const url = new URL('/api/event-stream', window.location.origin);
      if (memberIdRef.current) url.searchParams.set('member_id', memberIdRef.current);
      if (lastEventIdRef.current) url.searchParams.set('last_event_id', lastEventIdRef.current);

      const es = new EventSource(url.toString(), { withCredentials: true });
      esRef.current = es;
      // 새 커넥션이므로 지금까지 구독된 이름을 전부 다시 attach(지연 attach 캐시 초기화).
      attachedEventNamesRef.current = new Set();
      for (const eventName of namedSubscribersRef.current.keys()) attachIfNeeded(eventName);

      es.onopen = () => {
        const isReconnect = backoff.isReconnect();
        backoff.onOpen();
        setConnected(true);
        if (isReconnect) for (const handler of reconnectSubscribersRef.current) handler();
      };

      es.onmessage = (e: MessageEvent<string>) => {
        if (e.lastEventId) lastEventIdRef.current = e.lastEventId;
        for (const handler of messageSubscribersRef.current) handler(e.data, e.lastEventId || undefined);
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        if (esRef.current === es) esRef.current = null;
        if (!closed && !retryTimerRef.current) {
          const delay = backoff.onError();
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            connect();
          }, delay);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      setConnected(false);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { subscribe, subscribeMessage, subscribeReconnect, connected };
}
