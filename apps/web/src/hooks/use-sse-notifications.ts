'use client';

import { useEffect, useRef } from 'react';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import { shouldSuppressDuplicateSseEvent } from '@/lib/realtime/sse-event-dedup';
import { createReconnectBackoffState } from '@/lib/realtime/sse-reconnect-backoff';

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

// story #2136 — 이 3개 literal 이름은 BE emit 문자열과 매치가 0이다(grep 확認: `publish_event(...)`도
// `Event(event_type=...)`도 이 문자열들을 쓰는 자리가 저장소 전체 0곳). 즉 지금은 named 이벤트로는
// 절대 안 온다. 그런데도 지운 게 아니라 **남긴 이유**: 유일한 소비처 `notification-bell.tsx`가 이
// 채널을 30s 폴 fallback과 병행 사용 중이라(`useSseNotifications({ onNotification, ... })`), 이
// 배열을 비워도 관측 가능한 동작 변화는 0(bell은 폴링만으로 이미 정확) — "고쳤다"는 착시가 나기
// 쉬운 자리다. 실 알림 전달은 named 이벤트가 아니라 `subscribeMessage`/`onmessage`(기본 unnamed
// SSE 메시지) 경로로 도는 것으로 보이며, 이 3개 이름이 실제로 쓰일 미래 BE 계약을 의도한 자리인지
// 완전한 죽은 코드인지는 FE 혼자 판단할 문제가 아니라 이 스토리 스코프 밖에 둔다.
// ⚠️BE 확認 후 정리 대상 — BE가 이 이름들로 emit할 계획이 없다고 확定되면 그때 지운다.
const NOTIFICATION_EVENT_NAMES = ['event_notification', 'notification', 'new_notification'];

// story #2095 — 재연결 backoff는 sse-reconnect-backoff.ts(공용)로 뽑았다(독립 연결 폴백
// 경로에서만 씀 — story #2078 이후 mux ON이면 이 경로 자체를 안 탄다).

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

  const handleData = (raw: string) => {
    if (!raw || raw.trim() === '') return;
    if (shouldSuppressDuplicateSseEvent(raw)) return;
    try {
      const parsed = JSON.parse(raw) as SseEventNotification;
      callbackRef.current?.(parsed);
    } catch { /* heartbeat or malformed */ }
  };

  const handleExtraEvent = (eventName: string, raw: string) => {
    if (!raw || raw.trim() === '') return;
    if (shouldSuppressDuplicateSseEvent(raw)) return;
    try {
      onExtraEventRef.current?.(eventName, JSON.parse(raw));
    } catch { /* malformed */ }
  };

  // story #2078 — 멀티플렉서(RealtimeProvider, 피처플래그 ON)가 있으면 그 공유 커넥션에
  // 이름별로만 구독한다. extraEventNames는 렌더마다 배열 identity가 달라질 수 있어(콜백
  // 관례상 인라인 배열을 넘기는 호출부가 있다) 이름 목록 자체를 문자열로 join해 의존성을
  // 안정화한다 — 매 렌더 재구독/해제를 반복하지 않기 위함.
  const mux = useSseMultiplexerContext();
  const extraEventNamesKey = (extraEventNames ?? []).join(',');

  useEffect(() => {
    if (!mux || !enabled) return;
    const unsubs = NOTIFICATION_EVENT_NAMES.map((name) => mux.subscribe(name, handleData));
    const unsubMsg = mux.subscribeMessage(handleData);
    const extraUnsubs = (extraEventNamesRef.current ?? []).map((name) =>
      mux.subscribe(name, (raw) => handleExtraEvent(name, raw)),
    );
    return () => {
      for (const u of unsubs) u();
      unsubMsg();
      for (const u of extraUnsubs) u();
    };
  }, [mux, enabled, extraEventNamesKey]);

  // 독립 연결 폴백(플래그 OFF 또는 Provider 밖) — story #2078 이전과 완전히 동일한 코드.
  useEffect(() => {
    if (mux || !enabled || typeof EventSource === 'undefined') return;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let lastEventId: string | null = null;
    const backoff = createReconnectBackoffState();

    const handleDataStandalone = (raw: string, eventId?: string) => {
      if (eventId) lastEventId = eventId;
      handleData(raw);
    };

    const handleExtraEventStandalone = (eventName: string, raw: string, eventId?: string) => {
      if (eventId) lastEventId = eventId;
      handleExtraEvent(eventName, raw);
    };

    const connect = () => {
      if (closed) return;
      es?.close();

      const url = new URL('/api/event-stream', window.location.origin);
      if (memberIdRef.current) url.searchParams.set('member_id', memberIdRef.current);
      if (lastEventId) url.searchParams.set('last_event_id', lastEventId);

      es = new EventSource(url.toString(), { withCredentials: true });

      es.onopen = () => { backoff.onOpen(); };

      es.onmessage = (e: MessageEvent<string>) => handleDataStandalone(e.data, e.lastEventId || undefined);

      for (const eventName of NOTIFICATION_EVENT_NAMES) {
        es.addEventListener(eventName, (e: Event) => {
          const me = e as MessageEvent<string>;
          handleDataStandalone(me.data, me.lastEventId || undefined);
        });
      }

      for (const eventName of extraEventNamesRef.current ?? []) {
        es.addEventListener(eventName, (e: Event) => {
          const me = e as MessageEvent<string>;
          handleExtraEventStandalone(eventName, me.data, me.lastEventId || undefined);
        });
      }

      es.onerror = () => {
        es?.close();
        es = null;
        if (!closed && !retryTimer) {
          const delay = backoff.onError();
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
  }, [mux, enabled]);
}
