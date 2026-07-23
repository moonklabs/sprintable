'use client';

import { createContext, useContext } from 'react';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { useSseMultiplexer, type SseMultiplexerHandle } from '@/lib/realtime/sse-multiplexer';

// story #2078(E-ARCH 0단계) — 피처플래그: OFF(기본)면 presence·notification·chat 훅이 각자
// 기존 방식대로 독립 EventSource를 연다(회귀 0, 이 스토리 이전 동작 그대로). ON이면 이
// Provider가 탭당 1개만 열고 세 훅이 이름별로 구독만 얹는다. 문제가 생기면 이 값만
// 되돌리면 즉시 롤백된다(코드 되돌림·재배포 불요 — env만 바꾸면 다음 배포에 반영).
export const SSE_MULTIPLEX_ENABLED = process.env['NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED'] === 'true';

const SseMultiplexerContext = createContext<SseMultiplexerHandle | null>(null);

/** null이면(플래그 OFF 또는 Provider 밖) 호출부가 기존 독립 EventSource 경로로 폴백한다. */
export function useSseMultiplexerContext(): SseMultiplexerHandle | null {
  return useContext(SseMultiplexerContext);
}

interface RealtimeProviderProps {
  currentTeamMemberId?: string;
  children: React.ReactNode;
}

export function RealtimeProvider({ currentTeamMemberId, children }: RealtimeProviderProps) {
  const { toasts, dismissToast } = useToast();
  // 플래그 OFF면 enabled=false를 넘겨 훅 내부에서 EventSource를 아예 안 열게 한다(이중 연결 방지).
  const multiplexer = useSseMultiplexer(currentTeamMemberId, SSE_MULTIPLEX_ENABLED);

  return (
    <SseMultiplexerContext.Provider value={SSE_MULTIPLEX_ENABLED ? multiplexer : null}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </SseMultiplexerContext.Provider>
  );
}
