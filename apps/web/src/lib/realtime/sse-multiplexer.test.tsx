// @vitest-environment jsdom
//
// story #2078 — SSE 멀티플렉서 핵심 계약: 탭당 EventSource 1개만 열리고, 여러 훅이 같은
// 커넥션에 이름별 구독만 얹어도(구독 순서 무관) 이벤트가 유실 없이 전부 도착하는 것.
// PO가 명시한 리스크("이벤트 리스너 누락")를 정면으로 겨눈 회귀가드다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSseMultiplexer, type SseMultiplexerHandle } from './sse-multiplexer';
import { fetchWithAuth } from '@/lib/db/client';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SseListener = (e: { data: string; lastEventId?: string }) => void;

interface FakeInstance {
  url: string;
  listeners: Record<string, SseListener[]>;
  onopen: (() => void) | null;
  onmessage: SseListener | null;
  onerror: (() => void) | null;
  closed: boolean;
  readyState: number;
}

let instances: FakeInstance[] = [];

function stubEventSource() {
  class FakeEventSource {
    // story #2160 — 실 EventSource readyState 상수. onerror 발생 시점의 readyState로
    // "fatal(CLOSED, 자동재연결 없음)"과 "transient(그 외)"를 가른다.
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    handle: FakeInstance;
    constructor(url: string) {
      this.handle = { url, listeners: {}, onopen: null, onmessage: null, onerror: null, closed: false, readyState: 0 };
      instances.push(this.handle);
    }
    set onopen(cb: (() => void) | null) { this.handle.onopen = cb; }
    get onopen() { return this.handle.onopen; }
    set onmessage(cb: SseListener | null) { this.handle.onmessage = cb; }
    get onmessage() { return this.handle.onmessage; }
    set onerror(cb: (() => void) | null) { this.handle.onerror = cb; }
    get onerror() { return this.handle.onerror; }
    get readyState() { return this.handle.readyState; }
    set readyState(v: number) { this.handle.readyState = v; }
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
  vi.mocked(fetchWithAuth).mockReset();
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

  describe('org 전환(memberId 변경) 재연결 — story #2940(실사고 재현)', () => {
    it('memberId가 바뀌면 옛 커넥션을 닫고 새 member_id로 재연결한다', async () => {
      await act(async () => {
        root.render(<Harness memberId="member-org-a" enabled />);
      });
      expect(instances).toHaveLength(1);
      expect(instances[0]!.url).toContain('member_id=member-org-a');
      expect(instances[0]!.closed).toBe(false);

      // org 전환 흉내 — 부모가 새 memberId로 리렌더.
      await act(async () => {
        root.render(<Harness memberId="member-org-b" enabled />);
      });

      expect(instances[0]!.closed).toBe(true); // 옛 커넥션은 닫힘.
      expect(instances).toHaveLength(2); // 새 커넥션이 열림.
      expect(instances[1]!.url).toContain('member_id=member-org-b');
      expect(instances[1]!.closed).toBe(false);
    });

    it('재연결 후에도 전환 前 구독이 그대로 살아 새 커넥션의 이벤트를 받는다(구독 복원)', async () => {
      await act(async () => {
        root.render(<Harness memberId="member-org-a" enabled />);
      });
      const handler = vi.fn();
      await act(async () => { handle!.subscribe('notification', handler); });
      act(() => { dispatchNamed(instances[0]!, 'notification', { from: 'org-a' }); });
      expect(handler).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(<Harness memberId="member-org-b" enabled />);
      });

      // ⭐핵심 — 재연결 前에 구독한 handler가, 재연결로 새로 열린 커넥션의 이벤트도 받아야 한다
      // (subscribe를 다시 호출할 필요 없이 namedSubscribersRef가 재연결을 관통해 유지됨).
      act(() => { dispatchNamed(instances[1]!, 'notification', { from: 'org-b' }); });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('memberId 전환 시 옛 org의 last_event_id를 새 커넥션 URL에 안 싣는다 — 카디르 QA(PR#3388) HIGH', async () => {
      // codex+카디르 발견: 재연결 자체는 되지만 lastEventIdRef가 org 전환에도 안 지워지면
      // 새 org 커넥션이 옛 org의 last_event_id를 그대로 보낸다 — BE가 org 스코프 없이 그
      // id의 생성시각만으로 백필기준을 잡아, 새 org의 더 이른 이벤트가 조용히 누락된다.
      await act(async () => {
        root.render(<Harness memberId="member-org-a" enabled />);
      });
      await act(async () => { handle!.subscribe('story.status_changed', vi.fn()); });
      act(() => { dispatchNamed(instances[0]!, 'story.status_changed', {}, 'org-a-last-event-id'); });

      await act(async () => {
        root.render(<Harness memberId="member-org-b" enabled />);
      });

      const reconnectUrl = new URL(instances[instances.length - 1]!.url, 'http://localhost');
      expect(reconnectUrl.searchParams.get('member_id')).toBe('member-org-b');
      // ⭐핵심 — 옛 org(org-a)의 last_event_id가 새 org 커넥션에 새면 안 된다.
      expect(reconnectUrl.searchParams.get('last_event_id')).toBeNull();
    });

    it('memberId가 안 바뀌면(무관한 리렌더) 재연결하지 않는다 — 과잉 재연결 금지', async () => {
      await act(async () => {
        root.render(<Harness memberId="member-org-a" enabled />);
      });
      expect(instances).toHaveLength(1);

      // 같은 memberId로 리렌더(예: 부모가 다른 이유로 리렌더된 경우).
      await act(async () => {
        root.render(<Harness memberId="member-org-a" enabled />);
      });

      expect(instances).toHaveLength(1); // 새 커넥션 없음.
      expect(instances[0]!.closed).toBe(false);
    });
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

  // story #2160 — 세션이 죽었는데 탭이 401을 영원히 재폴링하던 결함의 회귀가드.
  describe('CLOSED(fatal) onerror — 세션 확認 후에만 재연결한다(#2160)', () => {
    it('세션이 죽었으면(fetchWithAuth 401) 재연결하지 않는다', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false } as Response);
      await act(async () => {
        root.render(<Harness memberId="me-1" enabled />);
      });
      expect(instances).toHaveLength(1);
      await act(async () => {
        instances[0]!.readyState = 2; // EventSource.CLOSED
        instances[0]!.onerror?.();
        await Promise.resolve(); // isSessionAlive() 마이크로태스크 해소
      });
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/me');
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(instances).toHaveLength(1); // 새 EventSource 없음 — 재시도 안 함
      vi.useRealTimers();
    });

    it('세션이 살아있으면(fetchWithAuth 200) 재연결한다', async () => {
      vi.useFakeTimers();
      vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true } as Response);
      await act(async () => {
        root.render(<Harness memberId="me-1" enabled />);
      });
      await act(async () => {
        instances[0]!.readyState = 2; // EventSource.CLOSED
        instances[0]!.onerror?.();
        await Promise.resolve();
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(instances.length).toBeGreaterThan(1); // 백오프 지연 후 재연결됨
      vi.useRealTimers();
    });

    it('CONNECTING(transient) onerror는 세션 확認 없이 곧장 백오프 재시도한다', async () => {
      vi.useFakeTimers();
      await act(async () => {
        root.render(<Harness memberId="me-1" enabled />);
      });
      await act(async () => {
        instances[0]!.readyState = 0; // EventSource.CONNECTING — 정상 순단
        instances[0]!.onerror?.();
        await Promise.resolve();
      });
      expect(fetchWithAuth).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(instances.length).toBeGreaterThan(1);
      vi.useRealTimers();
    });
  });

  // story #2162 — 마지막 수신이 B계열(presence·conversation.working, DB Event 행 없는 transient
  // push)이면 재개 커서(last_event_id)로 승격되면 안 된다 — 안 그러면 서버가 그 id를 해소 못 해
  // 시간 기준점을 잃고 재연결마다 최근 50건을 통째로 재전송한다(#2162 근본).
  describe('재개 커서 B계열 오염 방지(#2162)', () => {
    async function triggerTransientReconnect() {
      await act(async () => {
        instances[instances.length - 1]!.readyState = 0; // CONNECTING — 정상 순단(세션 확認 불필요)
        instances[instances.length - 1]!.onerror?.();
        await Promise.resolve();
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    }

    it('B계열(presence) id는 커서로 승격되지 않는다 — 재연결 URL에 안 실린다', async () => {
      vi.useFakeTimers();
      await act(async () => { root.render(<Harness memberId="me-1" enabled />); });
      // attachIfNeeded는 subscribe 시점에만 fake EventSource.addEventListener를 실제로 건다 —
      // subscribe 없이 dispatchNamed(fake)만 부르면 리스너가 없어 아무 일도 안 일어나는(공허한
      // 통과) 자리라, 먼저 구독해서 진짜 훅의 dispatchNamed 경로를 태운다.
      await act(async () => { handle!.subscribe('presence', vi.fn()); });
      act(() => { dispatchNamed(instances[0]!, 'presence', {}, 'transient-uuid-1'); });

      await triggerTransientReconnect();

      const reconnectUrl = new URL(instances[instances.length - 1]!.url, 'http://localhost');
      expect(reconnectUrl.searchParams.get('last_event_id')).toBeNull();
      vi.useRealTimers();
    });

    it('A계열(story.status_changed) id는 커서로 승격된다 — 재연결 URL에 실린다', async () => {
      vi.useFakeTimers();
      await act(async () => { root.render(<Harness memberId="me-1" enabled />); });
      await act(async () => { handle!.subscribe('story.status_changed', vi.fn()); });
      act(() => { dispatchNamed(instances[0]!, 'story.status_changed', {}, 'db-event-id-1'); });

      await triggerTransientReconnect();

      const reconnectUrl = new URL(instances[instances.length - 1]!.url, 'http://localhost');
      expect(reconnectUrl.searchParams.get('last_event_id')).toBe('db-event-id-1');
      vi.useRealTimers();
    });

    it('핵심 시나리오 — A계열 수신 뒤 B계열이 마지막으로 와도 커서는 A계열 id를 유지한다', async () => {
      vi.useFakeTimers();
      await act(async () => { root.render(<Harness memberId="me-1" enabled />); });
      await act(async () => {
        handle!.subscribe('story.status_changed', vi.fn());
        handle!.subscribe('presence', vi.fn());
      });
      act(() => { dispatchNamed(instances[0]!, 'story.status_changed', {}, 'a-series-id'); });
      act(() => { dispatchNamed(instances[0]!, 'presence', {}, 'b-series-id'); }); // 마지막 수신 = B계열

      await triggerTransientReconnect();

      const reconnectUrl = new URL(instances[instances.length - 1]!.url, 'http://localhost');
      expect(reconnectUrl.searchParams.get('last_event_id')).toBe('a-series-id'); // B계열에 안 덮임
      vi.useRealTimers();
    });
  });

  // story #2987(선생님 실사용 지적) — "앱을 나갔다 들어와야 채팅이 갱신된다"의 근본원인
  // 회귀가드. readyState는 좀비 커넥션(브라우저가 아직 못 알아챈 죽은 소켓)을 못 잡으므로,
  // 가시성 복귀 시 그걸 안 보고 무조건 강제 재연결해야 한다.
  describe('가시성 복귀 강제 재연결(#2987)', () => {
    function setVisibility(state: DocumentVisibilityState) {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    afterEach(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });

    it('임계값(3s) 이상 숨겨졌다 돌아오면 기존 커넥션을 닫고 새로 연다', async () => {
      vi.useFakeTimers();
      await act(async () => { root.render(<Harness memberId="me-1" enabled />); });
      act(() => { instances[0]!.onopen?.(); });
      expect(instances).toHaveLength(1);

      act(() => { setVisibility('hidden'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      act(() => { setVisibility('visible'); });

      expect(instances).toHaveLength(2);
      expect(instances[0]!.closed).toBe(true);
      vi.useRealTimers();
    });

    it('임계값(3s) 미만의 짧은 전환은 재연결하지 않는다 — 처칭 방지', async () => {
      vi.useFakeTimers();
      await act(async () => { root.render(<Harness memberId="me-1" enabled />); });
      act(() => { instances[0]!.onopen?.(); });

      act(() => { setVisibility('hidden'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      act(() => { setVisibility('visible'); });

      expect(instances).toHaveLength(1);
      vi.useRealTimers();
    });

    it('강제 재연결이 열리면 backoff 이력과 무관하게 subscribeReconnect 핸들러가 불린다(backfill 트리거)', async () => {
      vi.useFakeTimers();
      await act(async () => { root.render(<Harness memberId="me-1" enabled />); });
      const onReconnect = vi.fn();
      await act(async () => { handle!.subscribeReconnect(onReconnect); });
      act(() => { instances[0]!.onopen?.(); }); // 최초 open(onError 이력 없음)
      expect(onReconnect).not.toHaveBeenCalled();

      act(() => { setVisibility('hidden'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      act(() => { setVisibility('visible'); });
      act(() => { instances[1]!.onopen?.(); }); // 강제 재연결의 새 커넥션이 open

      expect(onReconnect).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });
});
