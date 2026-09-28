// @vitest-environment jsdom
//
// story #4263 — 대화 안 읽음 수(`/api/conversations/unread-count`):
// AC1 같은 순간 2번의 원인 = 이 훅이 한 화면에 여럿 마운트(dashboard-shell.tsx:191 · today-v3-screen.tsx:81 …)되어 각자 창 포커스마다 따로 물었다
//     → 공용 요청(fetchChatUnreadTotal · 진행 중이면 합류)으로 1번.
// AC2 SSE가 살아 있으면(mux.isAlive · 4252와 같은 판정) 포커스 재조회 생략 · 죽었으면 재조회 유지.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { muxState } = vi.hoisted(() => ({ muxState: { alive: false } }));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => muxState.alive, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));
const { sseOpts } = vi.hoisted(() => ({ sseOpts: { last: null as null | { onConversationRead?: () => void; onReconnect?: () => void } } }));
vi.mock('./use-chat-sse', () => ({ useChatSse: (opts: { onConversationRead?: () => void }) => { sseOpts.last = opts; return { connected: true, polling: false }; } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let unreadCalls = 0;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  unreadCalls = 0;
  muxState.alive = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/conversations/unread-count')) unreadCalls += 1;
    return { ok: true, status: 200, json: async () => ({ count: 3 }) };
  }));
  const { resetChatUnreadTotalStateForTest } = await import('@/lib/chat-unread-total-client');
  resetChatUnreadTotalStateForTest();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mountTwo() {
  const { useChatUnreadTotal } = await import('./use-chat-unread-total');
  function Badge({ id }: { id: string }) {
    const n = useChatUnreadTotal('m-1');
    return <span data-testid={id}>{n}</span>;
  }
  await act(async () => { root.render(<><Badge id="shell" /><Badge id="today" /></>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function focusWindow() {
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('useChatUnreadTotal — 여러 마운트 · SSE 생존 시 포커스 재조회(#4263)', () => {
  it('⭐AC1 — 훅 두 마운트여도 첫 조회는 1번 · 둘 다 같은 값', async () => {
    await mountTwo();
    expect(unreadCalls).toBe(1);
    expect(container.querySelector('[data-testid="shell"]')!.textContent).toBe('3');
    expect(container.querySelector('[data-testid="today"]')!.textContent).toBe('3');
  });

  it('⭐AC1 — SSE가 죽은 채 창 포커스: 두 마운트의 재조회가 같은 순간 1번으로 합류', async () => {
    await mountTwo();
    unreadCalls = 0;
    await focusWindow();
    expect(unreadCalls).toBe(1);
  });

  it('⭐AC2 — SSE가 살아 있으면 창 포커스 재조회 0', async () => {
    await mountTwo();
    unreadCalls = 0;
    muxState.alive = true;
    await focusWindow();
    expect(unreadCalls).toBe(0);
  });

  it('AC2 — 탭이 다시 보일 때(visibilitychange)도 같은 판정: 살아 있으면 0 · 죽었으면 1', async () => {
    await mountTwo();
    unreadCalls = 0;
    muxState.alive = true;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(unreadCalls).toBe(0);
    muxState.alive = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(unreadCalls).toBe(1);
  });
});

describe('useChatUnreadTotal — conversation.read 이벤트 재조회는 진행 중 요청에 합류하지 않는다(#4263 ①)', () => {
  it('⭐기동 요청이 떠 있는 동안 conversation.read → 새 요청 · 최종 값은 이벤트 뒤 값', async () => {
    const resolvers: Array<(n: number) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      resolvers.push((n: number) => resolve({ ok: true, status: 200, json: async () => ({ count: n }) }));
    })));
    const { useChatUnreadTotal } = await import('./use-chat-unread-total');
    function Badge() { return <span data-testid="n">{useChatUnreadTotal('m-1')}</span>; }
    await act(async () => { root.render(<Badge />); });
    expect(resolvers).toHaveLength(1);
    await act(async () => { sseOpts.last!.onConversationRead!(); });
    expect(resolvers).toHaveLength(2);
    await act(async () => { resolvers[1]!(0); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { resolvers[0]!(4); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="n"]')!.textContent).toBe('0');
  });
});
