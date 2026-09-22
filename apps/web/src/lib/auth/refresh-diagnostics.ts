'use client';

/**
 * story #2449 AC1(계측 전환, 페드루 PO 지시 2026-09-16) — AC0 실측(prod 7일)이 N=1이라
 * 처방 A(탭 락, 동시요청 경합 전제)를 그 표본이 지지하지 못했다(유일 사건은 같은
 * 브라우저가 40분 전 회전된 RT를 그대로 들고 있던 것 — 동시경합이 아니라 다른 클래스).
 * 다음 사건이 어느 클래스인지 자동으로 가르도록, refresh 시도 시 클라이언트 신호 3종을
 * BFF(`/api/auth/refresh` route.ts)에 실어 보낸다 — visibility_state·idle_ms(마지막
 * 활동 후 경과)·tab_count(BroadcastChannel ping/pong). PII 0(개인식별 정보 없음 —
 * 활동 여부·탭 개수·가시성 상태뿐).
 *
 * ⛔설계 제약(자체발견, 1차 구현 회귀 — storage-capacity-banner.test.tsx 401→refresh
 * 재시도 타이밍 테스트가 잡음) — 이 계측이 refresh 호출 자체를 **느리게 만들면 안
 * 된다**(진단하려는 대상이 바로 그 refresh 지연/타이밍이라, 계측이 지연을 보태면
 * 측정 대상을 오염시킨다). 1차 구현은 tab_count 판정에 `await new Promise(setTimeout
 * 150ms)`를 넣어 매 refresh 호출에 실 150ms 지연을 보탰다(회귀). 지금은
 * `collectRefreshDiagnostics()`가 완전 동기 함수다 — BroadcastChannel ping을 쏘긴
 * 하지만 pong을 기다리지 않는다(이전 호출들이 비동기로 쌓아둔 tab_count 스냅샷을
 * 즉시 반환). 세션 첫 refresh는 실제 탭 수를 과소평가할 수 있다(응답이 아직 안
 * 쌓였으므로) — tab_count는 판정에 결정력이 없는 보조 신호이므로 무방하다.
 */

let lastActivityAt = Date.now();

function markActivity(): void {
  lastActivityAt = Date.now();
}

if (typeof window !== 'undefined') {
  for (const evt of ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'] as const) {
    window.addEventListener(evt, markActivity, { passive: true });
  }
}

const selfTabId = typeof window !== 'undefined' ? Math.random().toString(36).slice(2) : '';
const knownPeerTabIds = new Set<string>();
let tabChannel: BroadcastChannel | null = null;

if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  tabChannel = new BroadcastChannel('sp-refresh-diag-tab-count');
  tabChannel.onmessage = (event: MessageEvent<{ type: string; id: string }>) => {
    const msg = event.data;
    if (!msg || msg.id === selfTabId) return;
    knownPeerTabIds.add(msg.id);
    if (msg.type === 'ping') tabChannel?.postMessage({ type: 'pong', id: selfTabId });
  };
}

export interface RefreshDiagnostics {
  visibility_state: string;
  idle_ms: number;
  tab_count: number;
}

export function collectRefreshDiagnostics(): RefreshDiagnostics {
  // 존재를 알린다 — 응답(pong)은 비동기로 knownPeerTabIds에 쌓여 다음 호출부터
  // 반영된다(이번 호출은 기다리지 않는다, 위 설계 제약 참고).
  tabChannel?.postMessage({ type: 'ping', id: selfTabId });
  return {
    visibility_state: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    idle_ms: Date.now() - lastActivityAt,
    tab_count: knownPeerTabIds.size + 1,
  };
}

// 테스트 전용 — vi.resetModules()로 매 테스트마다 새 모듈 인스턴스를 만들면 이전 인스턴스의
// BroadcastChannel이 안 닫힌 채(onmessage 리스너 계속 살아있음) 다음 테스트의 ping에도
// pong으로 응답해 tab_count가 테스트 간 누적된다(실 실측). 프로덕션에서는 페이지당 모듈이
// 한 번만 로드돼 이 문제가 없다 — 테스트 격리만을 위한 좁은 출구.
export function __closeTabChannelForTest(): void {
  tabChannel?.close();
  tabChannel = null;
}
