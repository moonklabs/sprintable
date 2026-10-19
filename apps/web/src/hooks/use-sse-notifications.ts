'use client';

import { useEffect, useRef } from 'react';
import { useSseMultiplexerContext } from '@/components/realtime-provider';
import { shouldSuppressDuplicateSseEvent, createSeenIdTracker } from '@/lib/realtime/sse-event-dedup';

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

export function useSseNotifications({
  onNotification, enabled = true, extraEventNames, onExtraEvent,
}: UseSseNotificationsOptions) {
  const callbackRef = useRef(onNotification);
  const extraEventNamesRef = useRef(extraEventNames);
  const onExtraEventRef = useRef(onExtraEvent);
  // story #2163 — 이 훅 인스턴스 전용 dedup tracker(모듈 전역 아님, use-chat-sse.ts와 동형).
  const seenIdsRef = useRef(createSeenIdTracker());
  useEffect(() => { callbackRef.current = onNotification; }, [onNotification]);
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

  // story #2078 — 멀티플렉서(RealtimeProvider)의 공유 커넥션에 이름별로만 구독한다. story #4698 — 독립 연결 폴백은 지웠다: Provider 밖(mux 없음)이면
  // 스트림 없이 아무것도 안 한다(이 훅은 스트림을 열지 않는다). extraEventNames는 렌더마다 배열 identity가 달라질 수 있어(콜백
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
}
