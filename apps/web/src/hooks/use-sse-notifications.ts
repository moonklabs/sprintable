'use client';

import { useEffect, useRef } from 'react';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import { shouldSuppressDuplicateSseEvent, createSeenIdTracker } from '@/lib/realtime/sse-event-dedup';
import { createReconnectBackoffState } from '@/lib/realtime/sse-reconnect-backoff';
import { isSessionAlive } from '@/lib/realtime/sse-session-guard';
import { isCursorEligibleEventName } from '@/lib/realtime/sse-cursor-eligibility';
import { createVisibilityReconnectState } from '@/lib/realtime/sse-visibility-reconnect';

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
  // story #2163 — 이 훅 인스턴스 전용 dedup tracker(모듈 전역 아님, use-chat-sse.ts와 동형).
  const seenIdsRef = useRef(createSeenIdTracker());
  useEffect(() => { callbackRef.current = onNotification; }, [onNotification]);
  useEffect(() => { memberIdRef.current = memberId; }, [memberId]);
  useEffect(() => { extraEventNamesRef.current = extraEventNames; }, [extraEventNames]);
  useEffect(() => { onExtraEventRef.current = onExtraEvent; }, [onExtraEvent]);

  const handleData = (raw: string) => {
    if (!raw || raw.trim() === '') return;
    if (shouldSuppressDuplicateSseEvent(raw, seenIdsRef.current)) return;
    try {
      const parsed = JSON.parse(raw) as SseEventNotification;
      callbackRef.current?.(parsed);
    } catch { /* heartbeat or malformed */ }
  };

  const handleExtraEvent = (eventName: string, raw: string) => {
    if (!raw || raw.trim() === '') return;
    if (shouldSuppressDuplicateSseEvent(raw, seenIdsRef.current)) return;
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
      // story #2162 — B계열(presence·conversation.working)만 커서 승격 금지.
      if (eventId && isCursorEligibleEventName(eventName)) lastEventId = eventId;
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
        // story #2160 — CLOSED는 브라우저가 이미 "복구 불가"로 판정한 것(자동재연결 없음).
        const wasFatal = es?.readyState === EventSource.CLOSED;
        es?.close();
        es = null;
        const scheduleRetry = () => {
          if (closed || retryTimer) return;
          const delay = backoff.onError();
          retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
          }, delay);
        };
        if (wasFatal) {
          void isSessionAlive().then((alive) => { if (alive) scheduleRetry(); });
          return;
        }
        scheduleRetry();
      };
    };

    connect();

    // story #2987(PO 지적, chat과 동일 좀비 커넥션 클래스 — sse-multiplexer.ts·use-chat-sse.ts
    // 주석 참고) — 이 fallback은 mux ON(dev/prod 라이브)이면 애초에 안 탄다(위 106행 가드).
    // mux가 이미 그 경로를 고쳤으니 이건 mux OFF/Provider 밖 경로 전용 동형 처방(방어 계층).
    // last_event_id는 이 effect 본문의 지역 변수라 강제 재연결에도 자동 보존된다.
    const visibilityState = createVisibilityReconnectState();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        visibilityState.onHidden();
        return;
      }
      if (visibilityState.onVisible()) connect();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  // story #2964(sse-multiplexer.ts #2940과 동일 클래스) — org 전환으로 memberId가 바뀌어도
  // 이 effect가 재실행되지 않으면(구 deps=[mux, enabled]) 커넥션이 옛 member_id로 남는다.
  // memberIdRef 쓰기는 effect를 재트리거하지 못한다 — memberId를 deps에 편입해 값이 실제로
  // 바뀔 때만(문자열 값 비교) 재구독을 강제한다. `lastEventId`가 이 effect 본문의 지역
  // 변수(ref 아님)라 재실행마다 자동으로 새로 초기화되므로 — memberId가 실제로 바뀐 재실행에서
  // 옛 org의 커서가 자동으로 버려진다(#3388 카디르 QA와 동일 목표를 use-chat-sse.ts의
  // prevMemberIdForResetRef 같은 별도 판별 없이 이 파일의 기존 설계가 이미 충족).
  }, [mux, enabled, memberId]);
}
