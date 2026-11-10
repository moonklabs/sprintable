// @vitest-environment jsdom
//
// story #4885 (4263 AC2 moved) — the phone tab bar used to count approvals itself and followed the gate stream live; its badge is now the home model's number (the same as the web rail's), so the
// LIVE part lives here: an approval event re-reads the home model at once (the badge changes without waiting for the 60-second poll), a burst of events is ONE read, generic notices are throttled,
// and coming back to the tab does not re-read a read younger than the poll interval while the stream is up. Each of these fails when it is undone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { muxState } = vi.hoisted(() => {
  const state = {
    alive: true,
    handlers: {} as Record<string, Array<(data: string) => void>>,
    // one stable handle (the real one is a stable reference too)
    mux: null as unknown,
  };
  state.mux = {
    isAlive: () => state.alive,
    subscribe: (name: string, h: (data: string) => void) => {
      (state.handlers[name] ??= []).push(h);
      return () => { state.handlers[name] = (state.handlers[name] ?? []).filter((x) => x !== h); };
    },
    subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true,
  };
  return { muxState: state };
});
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => muxState.mux,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let todayCalls = 0;
let needs: unknown[] = [];

const need = (id: string) => ({
  kind: 'approval', risk: 'low', source: 'gate', source_id: id,
  work_item: { type: 'story', id: `s-${id}`, title: `결재 ${id}` },
  requested_by: null, reason: null, created_at: '2026-09-13T05:00:00Z', actions: ['approve'],
});
const todayOf = (n: unknown[]) => ({ needs_me: n, needs_me_count: n.length, agent_progress: [], completed_today: [], published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } } });
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });

beforeEach(() => {
  vi.useFakeTimers();
  muxState.alive = true; muxState.handlers = {}; todayCalls = 0; needs = [need('g1'), need('g2')];
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/today') { todayCalls += 1; return ok(todayOf(needs)); }
    if (url.startsWith('/api/notifications')) return ok([]);
    return ok(null);
  }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules();
});

async function flush() { await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }); }
async function mount() {
  const { HomeModelProvider, useHomeModel } = await import('./home-model-provider');
  function Probe() { const { model } = useHomeModel(); return <span data-testid="badge">{model ? String(model.badge) : 'none'}</span>; }
  await act(async () => { root.render(<HomeModelProvider viewerMemberId={null} projectId={undefined}><Probe /></HomeModelProvider>); });
  await flush();
}
const badge = () => container.querySelector('[data-testid="badge"]')?.textContent;
const emit = async (name: string, data = '{}') => { await act(async () => { for (const h of muxState.handlers[name] ?? []) h(data); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await flush(); };

describe('홈 모델 — 결재 SSE 라이브(story #4885 · 4263 AC2 이사)', () => {
  it('⭐게이트 · 권한 요청 이벤트를 구독한다(이름은 서버가 실제로 쓰는 것)', async () => {
    await mount();
    expect(Object.keys(muxState.handlers).filter((k) => (muxState.handlers[k] ?? []).length > 0).sort())
      .toEqual(['agent.permission_request.changed', 'conversation.gate_created', 'conversation.gate_delegated', 'conversation.gate_resolved', 'conversation.gate_tossed', 'dispatched']);
  });

  it('⭐결재가 풀리는 이벤트가 오면 60초 폴을 기다리지 않고 다시 읽어 배지가 바뀐다', async () => {
    const { HOME_EVENT_COALESCE_MS } = await import('./home-model-provider');
    await mount();
    expect(badge()).toBe('2');
    needs = [need('g1')];
    await emit('conversation.gate_resolved', JSON.stringify({ gate_id: 'g2' }));
    await advance(HOME_EVENT_COALESCE_MS);
    expect(badge()).toBe('1'); // reverted (no subscription) → stays '2' until the 60-second poll
  });

  // story #4885 — dev 실측(11-10): 결재가 «새로 생길 때» 폰 탭 배지 37.9초 · 웹 막대 42.2초 뒤에야 올랐다(60초 폴). 서버는 결재자에게 conversation.gate_created를 보내는데 듣는 목록에 없었다.
  it('⭐결재가 새로 생기는 이벤트(conversation.gate_created)가 오면 60초 폴을 기다리지 않고 다시 읽어 배지가 오른다', async () => {
    const { HOME_EVENT_COALESCE_MS } = await import('./home-model-provider');
    await mount();
    expect(badge()).toBe('2');
    needs = [need('g1'), need('g2'), need('g3')];
    await emit('conversation.gate_created', JSON.stringify({ gate_id: 'g3' }));
    await advance(HOME_EVENT_COALESCE_MS);
    expect(badge()).toBe('3'); // reverted (not in the list) → stays '2' until the 60-second poll
  });

  it('이벤트가 한꺼번에 와도 읽기는 한 번이다(재연결 백필 · 결재 + 알림 한 쌍)', async () => {
    const { HOME_EVENT_COALESCE_MS } = await import('./home-model-provider');
    await mount();
    todayCalls = 0;
    await emit('conversation.gate_resolved'); await emit('conversation.gate_tossed'); await emit('conversation.gate_resolved');
    await advance(HOME_EVENT_COALESCE_MS);
    expect(todayCalls).toBe(1);
  });

  it('⭐권한 요청 알림(dispatched · agent.permission_request)과 그 뒤 변화는 결재 이벤트다 — 바로 다시 읽는다', async () => {
    const { HOME_EVENT_COALESCE_MS } = await import('./home-model-provider');
    await mount();
    todayCalls = 0;
    await emit('dispatched', JSON.stringify({ event_type: 'dispatched', payload: { event_type: 'agent.permission_request' } }));
    await advance(HOME_EVENT_COALESCE_MS);
    expect(todayCalls).toBe(1);
    await emit('agent.permission_request.changed', JSON.stringify({ event_type: 'agent.permission_request.changed', request_id: 'q1', state: 'answered' }));
    await advance(HOME_EVENT_COALESCE_MS);
    expect(todayCalls).toBe(2);
  });

  it('그 밖의 알림(채팅 메시지 등)은 읽기를 서두르지 않는다 — 마지막 읽기에서 최소 간격 뒤에 읽는다', async () => {
    const { HOME_EVENT_COALESCE_MS, HOME_NOTICE_MIN_INTERVAL_MS } = await import('./home-model-provider');
    await mount();
    todayCalls = 0;
    await emit('dispatched', JSON.stringify({ event_type: 'dispatched', payload: { event_type: 'conversation.message' } }));
    await advance(HOME_EVENT_COALESCE_MS);
    expect(todayCalls).toBe(0); // throttled: the last read was just now
    await advance(HOME_NOTICE_MIN_INTERVAL_MS);
    expect(todayCalls).toBe(1);
  });

  it('결재 이벤트는 알림의 긴 기다림을 앞지른다(결재를 기다리는 사람이 알림 간격을 기다리지 않는다)', async () => {
    const { HOME_EVENT_COALESCE_MS } = await import('./home-model-provider');
    await mount();
    todayCalls = 0;
    await emit('dispatched', JSON.stringify({ event_type: 'dispatched', payload: { event_type: 'conversation.message' } }));
    await emit('conversation.gate_resolved');
    await advance(HOME_EVENT_COALESCE_MS);
    expect(todayCalls).toBe(1);
  });

  it('⭐스트림이 살아 있으면 탭 복귀 때 폴 간격보다 어린 읽기를 다시 읽지 않는다 · 죽었으면 다시 읽는다', async () => {
    const { HOME_BACK_DEDUPE_MS } = await import('./home-model-provider');
    await mount();
    await advance(HOME_BACK_DEDUPE_MS + 1);
    todayCalls = 0; muxState.alive = true;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(todayCalls).toBe(0);
    muxState.alive = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(todayCalls).toBe(1);
  });

  // codex round 3 — the throttle counts from when a read STARTED: a slow (never-answering) read must not let continuous notices start a new read every few hundred ms.
  it('⭐읽기가 느려 끝나지 않아도 알림이 계속 와도 10초에 읽기 하나보다 많이 시작하지 않는다', async () => {
    await mount();
    todayCalls = 0;
    // from now on the home snapshot never answers (a slow read)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') { todayCalls += 1; return new Promise(() => {}); }
      if (url.startsWith('/api/notifications')) return ok([]);
      return ok(null);
    }));
    // 60 notices over 18 s while no read ever finishes: reads may START at most once per 10 s (counted from the previous start) — the first is already due ~10 s after the mount's read started
    for (let i = 0; i < 60; i += 1) {
      await emit('dispatched', JSON.stringify({ event_type: 'dispatched', payload: { event_type: 'conversation.message' } }));
      await advance(300);
    }
    expect(todayCalls).toBeLessThanOrEqual(2); // counted from the committed read (which never comes) it would be ~25
  });

  it('⭐창 포커스만 돌아와도(visibilitychange 없이) 스트림이 죽었으면 다시 읽고, 살아 있고 읽기가 어리면 건너뛴다', async () => {
    const { HOME_BACK_DEDUPE_MS } = await import('./home-model-provider');
    await mount();
    await advance(HOME_BACK_DEDUPE_MS + 1);
    todayCalls = 0; muxState.alive = true;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(todayCalls).toBe(0);
    muxState.alive = false;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(todayCalls).toBe(1);
  });

  it('돌아올 때 visibilitychange와 focus가 같이 와도 읽기는 한 번이다', async () => {
    const { HOME_BACK_DEDUPE_MS } = await import('./home-model-provider');
    await mount();
    await advance(HOME_BACK_DEDUPE_MS + 1);
    todayCalls = 0; muxState.alive = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(todayCalls).toBe(1);
  });

  it('언마운트하면 구독이 풀린다', async () => {
    await mount();
    await act(async () => { root.unmount(); });
    expect(Object.values(muxState.handlers).every((l) => l.length === 0)).toBe(true);
    root = createRoot(container);
  });
});
