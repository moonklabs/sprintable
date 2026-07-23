// @vitest-environment jsdom
//
// story #2139 — 폴백 정책 결정(PO): 주기 폴링은 재도입하지 않고(#2074 인스턴스 기아 교훈),
// 재연결 시 1회 강제 refetch만 추가한다. 이 테스트는 독립 EventSource 폴백 경로(mux 없음)에서
// isReconnect() 판정이 정확히 작동하는지 고정한다 — onerror를 안 걸면 hadPriorError가 영원히
// false라 재연결 refetch가 죽은 코드가 되는 함정이 있어(직접 확認), 그 회귀를 막는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTeamPresence } from './use-team-presence';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<() => void>> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string, _opts?: unknown) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() { this.closed = true; }
  emit(type: string) {
    for (const cb of this.listeners[type] ?? []) cb();
  }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness({ active, memberId }: { active: boolean; memberId?: string }) {
  useTeamPresence(active, memberId);
  return null;
}

describe('useTeamPresence — 독립 연결 폴백의 재연결 refetch(#2139)', () => {
  it('최초 open은 refetch를 유발하지 않는다(초기 스냅샷 fetch 1회만)', async () => {
    await act(async () => {
      root.render(<Harness active memberId="m1" />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 초기 스냅샷
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.onopen?.(); // 최초 open — isReconnect()는 아직 false
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 늘지 않음
  });

  it('error 후 재open되면 강제 refetch가 1회 추가된다', async () => {
    await act(async () => {
      root.render(<Harness active memberId="m1" />);
      await Promise.resolve();
    });
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.onopen?.(); // 최초 open
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      es.onerror?.(); // 끊김 — backoff가 hadPriorError=true로 기록
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // error 자체는 fetch 유발 안 함

    await act(async () => {
      es.onopen?.(); // 재연결(native auto-reconnect가 다시 연 것으로 시뮬레이션)
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 재연결 refetch 발화
  });

  it('presence 이벤트 자체도 여전히 refetch를 유발한다(기존 동작 무회귀)', async () => {
    await act(async () => {
      root.render(<Harness active memberId="m1" />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit('presence');
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
