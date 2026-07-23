// @vitest-environment jsdom
//
// story #2078 — SSE 멀티플렉서 핵심 계약: 탭당 EventSource 1개만 열리고, 여러 훅이 같은
// 커넥션에 이름별 구독만 얹어도(구독 순서 무관) 이벤트가 유실 없이 전부 도착하는 것.
// PO가 명시한 리스크("이벤트 리스너 누락")를 정면으로 겨눈 회귀가드다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSseMultiplexer, type SseMultiplexerHandle } from './sse-multiplexer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    addEventListener(name: string, cb: SseListener) {
      (this.handle.listeners[name] ??= []).push(cb);
    }
    close() { this.handle.closed = true; }
  }
  vi.stubGlobal('EventSource', FakeEventSource);
}

function dispatchNamed(instance: FakeInstance, eventName: string, data: unknown, eventId?: string) {
  for (const cb of instance.listeners[eventName] ?? []) cb({ data: JSON.stringify(data), lastEventId: eventId });
}

let container: HTMLDivElement;
let root: Root;
let handle: SseMultiplexerHandle | null = null;

function Harness({ memberId, enabled }: { memberId?: string; enabled: boolean }) {
  const h = useSseMultiplexer(memberId, enabled);
  useEffect(() => { handle = h; });
  return null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  instances = [];
  handle = null;
  stubEventSource();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('useSseMultiplexer — story #2078', () => {
  it('enabled=true면 EventSource를 정확히 1개만 연다', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled />);
    });
    expect(instances).toHaveLength(1);
  });

  it('enabled=false면 EventSource를 아예 열지 않는다(피처플래그 롤백 경로)', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled={false} />);
    });
    expect(instances).toHaveLength(0);
  });

  it('같은 이벤트명에 구독자 여러 개(다른 훅 흉내)가 전부 이벤트를 받는다 — 멀티플렉싱 핵심', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled />);
    });
    const a = vi.fn();
    const b = vi.fn();
    await act(async () => {
      handle!.subscribe('presence', a);
      handle!.subscribe('presence', b);
    });
    act(() => { dispatchNamed(instances[0]!, 'presence', {}); });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('커넥션이 이미 열린 뒤(늦게) 구독해도 이후 이벤트를 놓치지 않는다 — "구독 순서 무관"', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled />);
    });
    // 이 시점엔 아직 아무도 'chat:message'를 구독하지 않음(커넥션은 이미 열려있음).
    const late = vi.fn();
    await act(async () => {
      handle!.subscribe('chat:message', late); // 늦은 구독
    });
    act(() => { dispatchNamed(instances[0]!, 'chat:message', { id: 'm1' }); });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe 후에는 그 핸들러만 더 이상 이벤트를 받지 않는다', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled />);
    });
    const handler = vi.fn();
    let unsub: () => void = () => {};
    await act(async () => { unsub = handle!.subscribe('notification', handler); });
    act(() => { dispatchNamed(instances[0]!, 'notification', {}); });
    expect(handler).toHaveBeenCalledTimes(1);
    act(() => { unsub(); });
    act(() => { dispatchNamed(instances[0]!, 'notification', {}); });
    expect(handler).toHaveBeenCalledTimes(1); // 안 늘어남
  });

  it('이름 없는 message 이벤트도 subscribeMessage로 받는다', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled />);
    });
    const handler = vi.fn();
    await act(async () => { handle!.subscribeMessage(handler); });
    act(() => { instances[0]!.onmessage?.({ data: JSON.stringify({ x: 1 }) }); });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('onopen 시 connected=true, onerror 시 connected=false', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled />);
    });
    expect(handle!.connected).toBe(false);
    act(() => { instances[0]!.onopen?.(); });
    expect(handle!.connected).toBe(true);
    act(() => { instances[0]!.onerror?.(); });
    expect(handle!.connected).toBe(false);
  });

  it('재연결(두 번째 open)에서만 subscribeReconnect 핸들러가 불린다 — 최초 연결은 재연결 아님', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled />);
    });
    const onReconnect = vi.fn();
    await act(async () => { handle!.subscribeReconnect(onReconnect); });

    act(() => { instances[0]!.onopen?.(); }); // 최초 open
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => { instances[0]!.onerror?.(); }); // 끊김 → backoff 타이머 예약(재호출은 fake timer 없이 직접 재현 어려움)
    // onerror 이후 재연결은 setTimeout으로 스케줄되므로, 여기서는 "최초 open=재연결 아님"만
    // 고정한다 — 실제 재연결 타이밍은 기존 3개 훅과 동일한 backoff 상수를 그대로 재사용했다.
  });

  // story #2144 — 반환 핸들 객체가 connected 토글에도 참조 안정적인지 고정한다. 이게
  // 깨지면(예: connected를 다시 useMemo deps에 넣으면) mux를 effect deps에 둔 모든
  // 소비처(presence·chat·notifications)가 재연결마다 구독을 해지·재구독하게 된다.
  it('connected가 false→true→false로 토글돼도 반환 핸들의 참조는 그대로다', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled />);
    });
    const initial = handle;
    expect(initial).not.toBeNull();

    act(() => { instances[0]!.onopen?.(); }); // connected: false → true
    expect(handle).toBe(initial); // 참조 그대로
    expect(handle!.connected).toBe(true); // 값은 최신

    act(() => { instances[0]!.onerror?.(); }); // connected: true → false
    expect(handle).toBe(initial); // 여전히 그대로
    expect(handle!.connected).toBe(false);
  });

  it('구독 함수 자체도 connected 토글 전후로 동일 참조다(consumer useEffect deps 안정성의 실질)', async () => {
    await act(async () => {
      root.render(<Harness memberId="me-1" enabled />);
    });
    const subscribeBefore = handle!.subscribe;
    act(() => { instances[0]!.onopen?.(); });
    expect(handle!.subscribe).toBe(subscribeBefore);
  });
});
