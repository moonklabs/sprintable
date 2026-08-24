'use client';

/**
 * story #2987(선생님 실사용 지적, 2026-08-24) — "앱 안에서 채팅방을 나갔다 들어와야 새
 * 내용이 반영된다". 그라운딩(코드 실측): `use-chat-sse.ts`·`sse-multiplexer.ts` 어느
 * 경로에도 `visibilitychange` 리스너가 없다 — RealtimeProvider가 세션 전체에서 SSE
 * 커넥션 하나를 계속 유지하는데(대화방 이동은 REST `fetchMessages()`만 새로 태울 뿐, SSE
 * 재구독이 아니다), 앱이 백그라운드로 갔다 돌아와도 그 커넥션이 살아있는지 아무도 확認
 * 안 한다. standalone PWA(주소창 없음, manifest.ts display:'standalone')는 백그라운드
 * 전환 시 OS가 JS 실행 자체를 정지시키는 경우가 흔해(iOS Safari 홈스크린 앱 등), 복귀
 * 시점엔 이미 "좀비 커넥션"(EventSource.readyState는 OPEN을 self-report하지만 실제
 * 소켓은 죽음)일 수 있다 — `readyState` 체크는 이 케이스를 못 잡는다(브라우저 자신도
 * 아직 모른다). 유일한 안전한 처방은 가시성 복귀 시 **무조건 강제 재연결**(close+reopen)
 * — 기존 backfill(last_event_id)·dedup 인프라가 있어 비용은 가볍고 유실도 없다.
 *
 * 다만 데스크톱에서 짧은 탭 전환(alt-tab)까지 매번 재연결하면 불필요한 처칭이라, "숨겨진
 * 시간이 임계값 이상"일 때만 재연결한다 — 순간 blur/focus는 건너뛴다.
 */
const HIDDEN_RECONNECT_THRESHOLD_MS = 3_000;

export interface VisibilityReconnectState {
  /** 페이지가 hidden이 될 때 호출(visibilitychange, document.visibilityState==='hidden'). */
  onHidden: () => void;
  /** 페이지가 다시 visible이 될 때 호출 — true면 강제 재연결해야 한다(숨겨진 시간이 임계값
   * 이상). false면 순간 전환이었으니 기존 커넥션을 그대로 둔다. */
  onVisible: () => boolean;
}

/** 테스트에서 결정적 값을 주입할 수 있도록 시계 소스를 분리(기본 Date.now). */
export function createVisibilityReconnectState(now: () => number = Date.now): VisibilityReconnectState {
  let hiddenAt: number | null = null;

  return {
    onHidden() {
      hiddenAt = now();
    },
    onVisible() {
      if (hiddenAt === null) return false;
      const hiddenDuration = now() - hiddenAt;
      hiddenAt = null;
      return hiddenDuration >= HIDDEN_RECONNECT_THRESHOLD_MS;
    },
  };
}
