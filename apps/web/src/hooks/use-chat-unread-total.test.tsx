// @vitest-environment jsdom
//
// story #2078(E-ARCH 0단계) 결함수정 회귀가드 — 민군 실측: 탭당 EventSource가 1개가 아니라
// 2개 열렸다(mux 1 + 독립 폴백 1). 근본은 useChatUnreadTotal이 예전엔 dashboard-shell.tsx의
// <RealtimeProvider> JSX 인스턴스화 *이전*(함수 바디 최상단)에서 호출됐다는 것 — React
// Context는 Provider의 자식에게만 전파되므로, 그 위치의 호출은 useSseMultiplexerContext()가
// 항상 null을 받아 플래그 값과 무관하게 영구히 독립 EventSource 폴백을 탔다.
//
// 이 테스트는 정확히 그 계약을 고정한다: useChatUnreadTotal이 <RealtimeProvider> 자식으로
// 렌더되면(수정 후 dashboard-shell.tsx의 ShellBody와 동일 조건) mux 공유 커넥션 하나만 열리고,
// 독립 EventSource는 생기지 않는다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type SseListener = (e: { data: string; lastEventId?: string }) => void;

interface FakeInstance {
  url: string;
  listeners: Record<string, SseListener[]>;
  onopen: (() => void) | null;
  onmessage: SseListener | null;
  onerror: (() => void) | null;
  closed: boolean;
}

let instances: FakeInstance[] = [];

function stubEventSource() {
  class FakeEventSource {
    handle: FakeInstance;
    constructor(url: string) {
      this.handle = { url, listeners: {}, onopen: null, onmessage: null, onerror: null, closed: false };
      instances.push(this.handle);
    }
    set onopen(cb: (() => void) | null) { this.handle.onopen = cb; }
    get onopen() { return this.handle.onopen; }
    set onmessage(cb: SseListener | null) { this.handle.onmessage = cb; }
    get onmessage() { return this.handle.onmessage; }
    set onerror(cb: (() => void) | null) { this.handle.onerror = cb; }
    get onerror() { return this.handle.onerror; }
    addEventListener(_name: string, _cb: SseListener) { /* not needed for this test */ }
    close() { this.handle.closed = true; }
  }
  vi.stubGlobal('EventSource', FakeEventSource);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  instances = [];
  stubEventSource();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ count: 0 }) })) as unknown as typeof fetch);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('useChatUnreadTotal — story #2078 결함수정(Provider 자식 위치 고정)', () => {
  it('<RealtimeProvider>(mux ON) 자식으로 렌더되면 독립 EventSource를 열지 않고 mux 커넥션 1개만 공유한다', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED', 'true');
    const { RealtimeProvider } = await import('@/components/realtime-provider');
    const { useChatUnreadTotal } = await import('./use-chat-unread-total');

    function Consumer() {
      useChatUnreadTotal('member-1');
      return null;
    }

    await act(async () => {
      root.render(
        <RealtimeProvider currentTeamMemberId="member-1">
          <Consumer />
        </RealtimeProvider>,
      );
    });

    // RealtimeProvider 자신의 mux 커넥션 1개만 존재해야 한다 — Consumer(=useChatUnreadTotal)가
    // 별도로 독립 EventSource를 열면 이 회귀가 재현된 것(수정 전 상태).
    expect(instances).toHaveLength(1);
  });

  it('Provider 밖(컨텍스트 기본값 null)에서 렌더되면 독립 EventSource로 폴백한다 — 폴백 경로 자체는 유효', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED', 'true');
    const { useChatUnreadTotal } = await import('./use-chat-unread-total');

    function StandaloneConsumer() {
      useChatUnreadTotal('member-1');
      return null;
    }

    await act(async () => {
      root.render(<StandaloneConsumer />);
    });

    // Provider 밖이므로 mux 컨텍스트가 없다 — 이 경우엔 독립 연결이 "의도된" 폴백이다
    // (플래그 OFF와 동일하게 취급). 즉 결함은 "폴백이 존재한다"가 아니라 "정상 위치에서도
    // 폴백을 탄다"였다 — 위 첫 테스트가 그 축을 고정한다.
    expect(instances).toHaveLength(1);
  });
});
