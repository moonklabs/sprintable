// @vitest-environment jsdom
//
// story #2139 — 폴백 정책 결정(PO): 주기 폴링은 재도입하지 않고(#2074 인스턴스 기아 교훈),
// 재연결 시 1회 강제 refetch만 추가한다. 이 테스트는 독립 EventSource 폴백 경로(mux 없음)에서
// isReconnect() 판정이 정확히 작동하는지 고정한다 — onerror를 안 걸면 hadPriorError가 영원히
// false라 재연결 refetch가 죽은 코드가 되는 함정이 있어(직접 확認), 그 회귀를 막는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
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

  it('presence 이벤트 자체도 여전히 refetch를 유발한다(디바운스 창을 넘기면·기존 동작 무회귀)', async () => {
    await act(async () => {
      root.render(<Harness active memberId="m1" />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit('presence');
      await new Promise((r) => setTimeout(r, 320)); // story #2139 — 300ms 디바운스 창을 넘긴다
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// story #2139 — presence 이벤트가 재접속 60초 주기로 몰려 올 때(M명 접속 시 분당 최대 M건)의
// 세 가드: ①디바운스(중복 요청 접기) ②in-flight 가드(진행 중엔 새로 안 쏘되 놓치지 않음)
// ③레이스 가드(늦게 온 stale 응답이 최신 화면을 덮어쓰지 못함 — 셋 중 제일 중요).
describe('useTeamPresence — presence 폭주 가드(#2139)', () => {
  it('①짧은 창에 presence 이벤트가 여러 건 몰려도 refetch는 한 번만 나간다', async () => {
    await act(async () => {
      root.render(<Harness active memberId="m1" />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 초기 스냅샷
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit('presence');
      es.emit('presence');
      es.emit('presence');
      await new Promise((r) => setTimeout(r, 320));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 초기 1 + 디바운스로 접힌 refetch 1
  });

  it('②fetch 진행 중에 새 트리거가 오면 새로 쏘지 않되, 끝난 뒤 1회 더 실행해 놓치지 않는다', async () => {
    let resolveFirst!: (v: { ok: boolean; json: () => Promise<{ data: never[] }> }) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));

    await act(async () => {
      root.render(<Harness active memberId="m1" />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 초기 스냅샷 — 아직 in-flight(응답 대기 중)

    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit('presence'); // in-flight 중 도착 — 디바운스 타이머는 걸리지만
      await new Promise((r) => setTimeout(r, 320)); // 디바운스가 풀려도 in-flight라 pendingRef만 표시
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 새로 쏘지 않음(in-flight 가드)

    await act(async () => {
      resolveFirst({ ok: true, json: async () => ({ data: [] }) }); // 첫 요청 종료
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 종료 직후 "한 번 더" 자동 실행 — 놓치지 않음
  });

  // ⚠️in-flight 가드(②)가 이미 동시요청 자체를 직렬화하므로(요청이 진행 중이면 새로 안 쏘고
  // 끝난 뒤 큐잉된 한 번만 이어 쏨), "두 요청이 동시에 떠 있다가 늦은 응답이 최신을 덮어쓰는"
  // 시나리오는 이 설계에서 실제로 재현되지 않는다 — 레이스 가드(seq 비교)는 그 전제가 깨질
  // 미래 변경에 대비한 방어선이다. 여기서는 그 대신, in-flight 큐잉으로 이어진 "한 번 더"
  // 요청의 결과가 최종 state로 정확히 반영되는 것(오래된 응답이 아니라 실제로 나간 마지막
  // 요청의 값)을 확認해 같은 결론(화면은 항상 가장 최근에 나간 요청의 결과를 보여준다)을 고정한다.
  it('③in-flight 큐잉으로 이어진 두 번째 요청의 응답이 최종 state로 정확히 반영된다', async () => {
    const first = { data: [{ member_id: 'first' }] };
    const second = { data: [{ member_id: 'second' }] };
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));

    const renderedItemsRef: { current: Array<{ member_id: string }> } = { current: [] };
    function Consumer() {
      const items = useTeamPresence(true, 'm1');
      useEffect(() => {
        renderedItemsRef.current = items as unknown as Array<{ member_id: string }>;
      });
      return null;
    }

    await act(async () => {
      root.render(<Consumer />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 초기 요청 — 아직 in-flight

    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.onerror?.();
      es.onopen?.(); // 재연결 refetch — in-flight라 새로 안 쏘고 pendingRef만 표시
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ ok: true, json: async () => first }); // 첫 요청 종료 → 큐잉된 두 번째 즉시 발사
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(renderedItemsRef.current).toEqual(first.data); // 이 시점엔 첫 응답이 아직 최신(두 번째는 진행 중)

    await act(async () => {
      resolveSecond({ ok: true, json: async () => second });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderedItemsRef.current).toEqual(second.data); // 마지막으로 나간 요청의 응답이 최종 반영됨
  });
});

// story #2144 — mux 공유 커넥션 경로(RealtimeProvider 자식)에서 connected 토글이 더 이상
// 구독 재생성(=중복 fetchPresence)을 유발하지 않는 것을 실제 Provider로 고정한다.
// use-chat-unread-total.test.tsx와 동일한 vi.stubEnv+resetModules+동적 import 패턴 재사용.
describe('useTeamPresence — mux 공유 커넥션 경로의 connected 참조 안정성(#2144)', () => {
  afterEach(() => { vi.resetModules(); });

  it('최초 connected flip(false→true)은 추가 fetchPresence를 유발하지 않는다', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED', 'true');
    const { RealtimeProvider } = await import('@/components/realtime-provider');
    const { useTeamPresence: useTeamPresenceFresh } = await import('./use-team-presence');

    function Consumer() {
      useTeamPresenceFresh(true, 'member-1');
      return null;
    }

    await act(async () => {
      root.render(
        <RealtimeProvider currentTeamMemberId="member-1">
          <Consumer />
        </RealtimeProvider>,
      );
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 초기 스냅샷만

    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.onopen?.(); // mux 커넥션의 최초 open — connected: false → true
      await Promise.resolve();
    });
    // #2144 이전엔 mux 참조가 바뀌어 useTeamPresence effect가 재실행 → fetchPresence 2회.
    // 고친 뒤엔 핸들 참조가 안정적이라 재실행 자체가 없다.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('실제 재연결(error→open)에서는 #2139의 subscribeReconnect refetch가 정확히 1회만 더 붙는다', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED', 'true');
    const { RealtimeProvider } = await import('@/components/realtime-provider');
    const { useTeamPresence: useTeamPresenceFresh } = await import('./use-team-presence');

    function Consumer() {
      useTeamPresenceFresh(true, 'member-1');
      return null;
    }

    await act(async () => {
      root.render(
        <RealtimeProvider currentTeamMemberId="member-1">
          <Consumer />
        </RealtimeProvider>,
      );
      await Promise.resolve();
    });
    const es = FakeEventSource.instances[0]!;
    await act(async () => { es.onopen?.(); await Promise.resolve(); }); // 최초 open
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { es.onerror?.(); await Promise.resolve(); }); // 끊김
    expect(fetchMock).toHaveBeenCalledTimes(1); // error 자체는 fetch 유발 안 함

    await act(async () => { es.onopen?.(); await Promise.resolve(); }); // 재연결
    // mux의 subscribeReconnect 경로로 정확히 1회만 늘어난다 — 구독 재생성으로 인한
    // 중복(effect 재실행발 fetchPresence)이 얹혀 2회 이상이 되면 이 테스트가 잡는다.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
