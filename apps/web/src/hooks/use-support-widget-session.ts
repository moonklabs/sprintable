// story #3260(지원v1 v1·2위젯) — Support Gateway(story #f2a27d2a, 디디) 세션/메시지 계약이
// 아직 없다(2026-08-31 착수 시점 grep 확認 — backend/infra 어디에도 support_gateway 자체가
// 없음). 그 계약이 실 API로 착지하기 전까지 이 훅은 «연결을 흉내내지 않는다» — 페드루
// 발주(디디와 API 셰이프 선합의 후 코딩)에 따라 정직한 'unavailable' 상태만 반환한다.
// AC5(§5-3 착지 전 병합 시 서버 정직 응답 — 에코/대기 응답 스텁 무신호 금지)의 정신을
// 그대로 셸 단계에도 적용: 가짜로 열려있는 척하지 않는다.
'use client';

import { useCallback, useMemo, useState } from 'react';

export type SupportWidgetStatus = 'unavailable' | 'connecting' | 'ready' | 'error';

export interface SupportWidgetMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  createdAt: string;
}

export interface SupportWidgetSession {
  status: SupportWidgetStatus;
  messages: SupportWidgetMessage[];
  /** 위젯이 열릴 때만 호출(lazy — 모든 인증 화면에 상주하는 런처가 매 페이지 진입마다
   * 네트워크를 태우지 않도록). Gateway 계약 착지 전까지는 no-op(status가 이미
   * 'unavailable'로 고정돼 있어 실질적 의미는 없음 — 인터페이스만 안정화). */
  connect: () => void;
  sendMessage: (content: string) => Promise<void>;
}

/**
 * story #3260 — Support Gateway(§5-1) 세션/스트림 계약이 착지하면 이 훅 내부만 교체된다
 * (실 fetch+독립 SSE 연결 — 본체 realtime-provider.tsx의 useSseMultiplexerContext()는
 * 절대 재사용하지 않는다, story #2102급 이중소비/고아 슬롯 결함 클래스 재발 방지 원칙).
 * 호출부(support-widget-panel.tsx)는 이 인터페이스만 알면 되므로 그 교체가 호출부
 * 무변경으로 끝난다.
 */
export function useSupportWidgetSession(): SupportWidgetSession {
  const [status] = useState<SupportWidgetStatus>('unavailable');
  const messages = useMemo<SupportWidgetMessage[]>(() => [], []);

  const connect = useCallback(() => {
    // Gateway 계약 착지 전 — 의도적 no-op.
  }, []);

  const sendMessage = useCallback(async (_content: string) => {
    // Gateway 계약 착지 전 — 의도적 no-op(성공한 척 큐잉하지 않음, panel이 status로 막는다).
  }, []);

  // 반환 객체 자체를 안정화 — 호출부(support-widget-launcher.tsx)가 이 객체를 effect
  // deps에 그대로 넣는다. 매 렌더 새 객체 리터럴이면 status/messages가 안 바뀌어도 매번
  // effect가 재발화한다(불필요한 connect() 재호출 — 실 연결이 붙으면 낭비가 아니라 버그가 된다).
  return useMemo(() => ({ status, messages, connect, sendMessage }), [status, messages, connect, sendMessage]);
}
