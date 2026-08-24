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

// story 6ddaa086(선생님 실사고, critical) — SseMultiplexerHandle은 의도적으로 참조가
// 안정적이다(connected가 토글돼도 핸들 자체는 그대로 — sse-multiplexer.ts 주석 참고,
// 소비처의 재구독 churn 방지). 그런데 그 안정성이 바로 배너 버그의 원인이었다: Context.
// Provider는 value의 "참조"가 안 바뀌면 소비자를 리렌더시키지 않는다 — multiplexer 핸들이
// 안정 참조인 이상 connected가 실제로 토글돼도(getter 뒤 값은 바뀜) chat-view의
// useChatSse가 그 변화를 리렌더로 못 받아, 다음 «무관한» 리렌더(새 메시지 등)가 우연히
// 올 때까지 배너가 옛 값에 고정됐다(readyState=1인데 배너만 남는 그 증상). connected
// 전용의 별도 원시값 컨텍스트를 둬 — 이건 매 토글마다 값(boolean) 자체가 달라지므로
// Provider가 정상적으로 소비자를 리렌더시킨다.
const SseConnectedContext = createContext<boolean>(false);

/** connected 전용 반응형 컨텍스트 — SseMultiplexerHandle과 달리 매 토글마다 실제로
 * 리렌더를 유발한다. 연결 상태에 반응해야 하는 소비처(예: 끊김 배너)는 이걸 쓴다. */
export function useSseConnectedContext(): boolean {
  return useContext(SseConnectedContext);
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
      <SseConnectedContext.Provider value={SSE_MULTIPLEX_ENABLED ? multiplexer.connected : false}>
        {children}
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </SseConnectedContext.Provider>
    </SseMultiplexerContext.Provider>
  );
}
