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

/**
 * story #3081(선생님 P0 지시, 2026-08-25) — 「나갔다 들어와야 갱신된다」 재발.
 *
 * 위 hidden/visible 판정(`onHidden`/`onVisible`)은 "탭이 실제로 숨겨졌다가 다시 보이게
 * 됐다"만 잡는다. 그런데 데스크톱 앱(WebView 셸)에서 창이 최소화되거나 다른 탭으로
 * 전환되지 않은 채(=`document.visibilityState`가 계속 `'visible'`) OS 포커스만 잃었다가
 * 되찾는 경우가 있다 — 이 경우 `onHidden()`이 호출된 적이 없어 `hiddenAt`이 계속 `null`이고,
 * `onVisible()`은 hidden 이력 유무를 hidden 자체를 aggregate하는 게 아니라 "hidden 이력이
 * 있어야만" true를 낼 수 있는 구조라 이 케이스에서 **항상 false**를 반환한다(재검증,
 * 페드루 PO+codex exec, 2026-08-25) — `focus` 이벤트를 기존 핸들러에 그냥 이어붙이는
 * 것만으로는 이 케이스가 안 고쳐진다.
 *
 * 그래서 hidden 이력과 완전히 독립된 별도 판정을 둔다 — `window.focus`는 실제 창 전환
 * 시에만 발생하므로(같은 창 안 요소 간 포커스 이동으로는 안 뜸) hidden 지속시간 같은
 * 게이트가 없어도 안전하다. 다만 짧은 시간 내 중복 focus(예: 포커스가 빠르게 왕복하는
 * 경우)로 강제 재연결이 반복되는 것만 throttle로 억제한다.
 */
const FOCUS_RECONNECT_THROTTLE_MS = 3_000;

/**
 * story #4252(민 하네스 실측 · 2026-09-24) — 위 focus 강제 재연결이 **살아 있는** 커넥션까지 끊었다: 웜 기동 뒤 첫 탭의 `focus`에서
 * OPEN(readyState 1) 커넥션을 닫고 4ms 뒤 다시 열어, open 때 재조회 2 · 끼어든 요청 6이 생겼다(onFocusRegained가 첫 focus면 조건 없이 true).
 * 좀비(OPEN을 자칭하지만 소켓은 죽음)를 가르는 신호는 readyState가 아니라 **최근에 받은 것**이다 — BE events 스트림은 쉬는 동안
 * 30초마다 `event: heartbeat`를 보낸다(backend/app/routers/events.py _SSE_HEARTBEAT_TIMEOUT). 그래서 OPEN이면서 마지막 수신(open ·
 * heartbeat · 이벤트)이 heartbeat 주기 + 여유 안이면 «살아 있음»으로 보고 focus 재연결을 건너뛴다. 그보다 오래 조용하면(좀비) · OPEN이
 * 아니면 · 수신 기록이 없으면 예전처럼 강제 재연결한다(#3081 보호 유지).
 */
export const SSE_LIVENESS_WINDOW_MS = 45_000;

export interface SseLivenessTracker {
  /** 커넥션에서 무엇이든 받았을 때(open · heartbeat · 이벤트) 호출. */
  markActivity: () => void;
  /** 새 커넥션을 열 때 호출 — 옛 커넥션의 수신 기록을 버린다. */
  reset: () => void;
  /** readyState가 OPEN이고 마지막 수신이 SSE_LIVENESS_WINDOW_MS 안이면 true. */
  isAlive: (readyState: number | undefined) => boolean;
}

export function createSseLivenessTracker(now: () => number = Date.now): SseLivenessTracker {
  let lastActivityAt: number | null = null;
  return {
    markActivity() { lastActivityAt = now(); },
    reset() { lastActivityAt = null; },
    isAlive(readyState) {
      return readyState === 1 && lastActivityAt !== null && now() - lastActivityAt < SSE_LIVENESS_WINDOW_MS;
    },
  };
}

export interface VisibilityReconnectState {
  /** 페이지가 hidden이 될 때 호출(visibilitychange, document.visibilityState==='hidden'). */
  onHidden: () => void;
  /** 페이지가 다시 visible이 될 때 호출 — true면 강제 재연결해야 한다(숨겨진 시간이 임계값
   * 이상). false면 순간 전환이었으니 기존 커넥션을 그대로 둔다. */
  onVisible: () => boolean;
  /** `window.focus` 이벤트에서 호출 — hidden 이력과 무관하게 판정한다. true면 강제
   * 재연결(짧은 throttle 안에 중복 호출이면 false). story #4252 — `alive`(SseLivenessTracker.isAlive)면 false(살아 있는 커넥션은
   * 두고 throttle 창도 쓰지 않는다). */
  onFocusRegained: (alive?: boolean) => boolean;
}

/** 테스트에서 결정적 값을 주입할 수 있도록 시계 소스를 분리(기본 Date.now). */
export function createVisibilityReconnectState(now: () => number = Date.now): VisibilityReconnectState {
  let hiddenAt: number | null = null;
  let lastFocusReconnectAt: number | null = null;

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
    onFocusRegained(alive = false) {
      if (alive) return false;
      const nowTs = now();
      if (lastFocusReconnectAt !== null && nowTs - lastFocusReconnectAt < FOCUS_RECONNECT_THROTTLE_MS) {
        return false;
      }
      lastFocusReconnectAt = nowTs;
      return true;
    },
  };
}
