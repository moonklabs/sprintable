// @vitest-environment jsdom
//
// story #2449 AC1(계측, 페드루 PO 지시 2026-09-16) — collectRefreshDiagnostics의 3필드가
// 실제로 브라우저 신호를 반영하는지 직접 고정. 이 함수는 완전 동기(refresh 호출에 지연을
// 보태지 않는 설계 제약, 파일 상단 참고) — pong을 기다리지 않으므로 tab_count 테스트는
// "먼저 한 번 불러 ping을 쏘고(peer가 비동기로 pong) → 짧게 대기 → 다시 불러 반영 확認"
// 형태다.
//
// 각 테스트가 vi.resetModules()로 모듈을 새로 불러오므로, 이전 테스트의 BroadcastChannel이
// 안 닫히면(onmessage 리스너 생존) 다음 테스트의 ping에도 응답해 tab_count가 테스트 간
// 누적된다(실측) — afterEach에서 __closeTabChannelForTest()로 매번 닫는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('collectRefreshDiagnostics (story #2449 AC1)', () => {
  let closeChannel: (() => void) | null = null;

  beforeEach(() => {
    vi.resetModules();
    closeChannel = null;
  });

  afterEach(() => {
    closeChannel?.();
    vi.unstubAllGlobals();
  });

  it('⭐document.visibilityState를 그대로 싣는다', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const mod = await import('./refresh-diagnostics');
    closeChannel = mod.__closeTabChannelForTest;
    const diag = mod.collectRefreshDiagnostics();
    expect(diag.visibility_state).toBe('hidden');
  });

  it('⭐마지막 활동(mousemove) 이후 경과 ms를 idle_ms로 싣는다', async () => {
    const mod = await import('./refresh-diagnostics');
    closeChannel = mod.__closeTabChannelForTest;
    window.dispatchEvent(new Event('mousemove'));
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow + 5000);
    try {
      const diag = mod.collectRefreshDiagnostics();
      expect(diag.idle_ms).toBeGreaterThanOrEqual(5000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('⭐탭이 자신뿐이면 tab_count=1(BroadcastChannel peer 없음)', async () => {
    const mod = await import('./refresh-diagnostics');
    closeChannel = mod.__closeTabChannelForTest;
    const diag = mod.collectRefreshDiagnostics();
    expect(diag.tab_count).toBe(1);
  });

  it('⭐다른 탭(BroadcastChannel peer)이 이전에 응답했으면 이후 호출에 반영된다(지연 0 — 첫 호출 자체엔 반영 안 됨)', async () => {
    const mod = await import('./refresh-diagnostics');
    closeChannel = mod.__closeTabChannelForTest;
    const peer = new BroadcastChannel('sp-refresh-diag-tab-count');
    peer.onmessage = (event: MessageEvent<{ type: string; id: string }>) => {
      if (event.data?.type === 'ping') peer.postMessage({ type: 'pong', id: 'peer-1' });
    };
    try {
      const first = mod.collectRefreshDiagnostics(); // ping을 쏜다 — pong은 아직 안 옴(동기 반환)
      expect(first.tab_count).toBe(1);

      await new Promise((r) => setTimeout(r, 20)); // peer의 비동기 pong이 도착할 시간
      const second = mod.collectRefreshDiagnostics();
      expect(second.tab_count).toBe(2);
    } finally {
      peer.close();
    }
  });

  it('BroadcastChannel 미지원 환경은 tab_count=1로 안전 폴백(크래시 0)', async () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error 테스트 전용 — 미지원 환경 시뮬레이션
    delete globalThis.BroadcastChannel;
    try {
      const mod = await import('./refresh-diagnostics');
      closeChannel = mod.__closeTabChannelForTest;
      const diag = mod.collectRefreshDiagnostics();
      expect(diag.tab_count).toBe(1);
    } finally {
      globalThis.BroadcastChannel = original;
    }
  });

  it('음성대조 — collectRefreshDiagnostics는 Promise를 반환하지 않는다(동기 계약 고정, refresh 지연 회귀 방지)', async () => {
    const mod = await import('./refresh-diagnostics');
    closeChannel = mod.__closeTabChannelForTest;
    const result = mod.collectRefreshDiagnostics();
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.tab_count).toBe('number');
  });
});
