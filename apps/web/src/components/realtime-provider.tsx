'use client';

import { createContext, useContext } from 'react';
import { useSseMultiplexer, type SseMultiplexerHandle } from '@/lib/realtime/sse-multiplexer';

// story #2078(E-ARCH 0단계) — presence · notification · chat이 각자 EventSource를 열어 탭당 연결이 3~4개였다. 이 Provider가 탭당 1개만 열고 세 훅이
// 이름별로 구독만 얹는다.
//
// story #4698 — 롤아웃 플래그(NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED)를 끝냈다: «끔» 길(훅마다 독립 EventSource)은 지웠고 **늘 이 한 줄기**뿐이다.
// 끔 길의 탭당 스트림 3~4개가 크롬의 낮은 우선순위 요청 대기(대화 탭 청크 · 프리패치 15~20초)의 원인이었다(4698 에뮬 실측). 스트림을 여는 자리가 이
// 한 곳을 벗어나지 않게 lib/realtime/sse-single-stream.guard.test.ts가 지킨다.
//
// Provider를 두는 곳은 대시보드 셸과 (v3) 레이아웃뿐이다(둘 다 member_id를 안다 — BE는 JWT 세션이 member_id 없이 /events/stream을 열면 400으로 거절한다).
// /today · /connect-rules 레이아웃과 온보딩 연결 단계는 member_id를 모른 채 훅이 독립 EventSource로 폴백했고 그 스트림은 늘 400이었다 — 폴백을 지운 지금 그 자리는
// 스트림이 없다(실제로 받던 실시간 0). 그 자리에 실시간이 필요하면 member_id를 공급하는 Provider를 따로 둔다(이 스토리 밖).

const SseMultiplexerContext = createContext<SseMultiplexerHandle | null>(null);

/** null은 Provider 밖일 때뿐이다 — 그때 훅은 스트림을 열지 않는다(독립 EventSource 폴백 없음 · story #4698). 실시간이 필요한 화면은 Provider 안에 둔다. */
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
  const multiplexer = useSseMultiplexer(currentTeamMemberId);

  return (
    <SseMultiplexerContext.Provider value={multiplexer}>
      <SseConnectedContext.Provider value={multiplexer.connected}>
        {children}
      </SseConnectedContext.Provider>
    </SseMultiplexerContext.Provider>
  );
}
