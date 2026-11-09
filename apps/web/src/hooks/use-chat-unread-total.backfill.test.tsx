// @vitest-environment jsdom
//
// story 4876 — the «대화» tab badge must equal the server's unread count from the first login on.
// Measured on dev (Android emulator + iOS simulator, and a headless browser): with 2 unread messages waiting, the first fetch said `count:2` and in the same tick the
// server replayed the 2 still-pending events (`is_backfill: true`) — `prev + 1` for each showed 4. A replayed event, an event with no server number yet, and an event
// that lands while a request is out only say «the number changed»: the hook asks the server again (shared · debounced) instead of adding 1. A live event with a server
// number in hand still adds 1 at once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => true, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));
type MessageHandler = (payload: Record<string, unknown>) => void;
const { sse } = vi.hoisted(() => ({ sse: { handlers: [] as MessageHandler[], reads: [] as Array<() => void> } }));
vi.mock('./use-chat-sse', async () => {
  const actual = await vi.importActual<typeof import('./use-chat-sse')>('./use-chat-sse');
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    // like the real hook: one subscription per mounted hook, always calling the LATEST callback it was given
    useChatSse: (opts: { onConversationMessage?: MessageHandler; onConversationRead?: () => void }) => {
      const latest = React.useRef(opts.onConversationMessage);
      latest.current = opts.onConversationMessage;
      const latestRead = React.useRef(opts.onConversationRead);
      latestRead.current = opts.onConversationRead;
      React.useEffect(() => {
        const fn: MessageHandler = (payload) => latest.current?.(payload);
        const read = () => latestRead.current?.();
        sse.handlers.push(fn);
        sse.reads.push(read);
        return () => { sse.handlers = sse.handlers.filter((h) => h !== fn); sse.reads = sse.reads.filter((h) => h !== read); };
      }, []);
      return { connected: true, polling: false };
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** one entry per `/api/conversations/unread-count` request, in order; `answer(n)` resolves it with a count, `fail()` with a server error */
let requests: Array<{ answer: (n: number) => void; fail: () => void }> = [];
const WAIT_MS = 320; // longer than the hook's quiet wait (fake timers: no real waiting, no CI jitter)

const settle = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const waitDebounce = async () => { await advance(WAIT_MS); await settle(); };
const badge = (id = 'n') => container.querySelector(`[data-testid="${id}"]`)!.textContent;
/** every handler the mounted hooks registered — a message event reaches all of them, like the real stream */
const emit = async (payload: Record<string, unknown>) => { await act(async () => { for (const h of sse.handlers) h(payload); }); await settle(); };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.resetModules();
  sse.handlers = [];
  sse.reads = [];
  requests = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (!String(url).includes('/api/conversations/unread-count')) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    return new Promise((resolve) => {
      requests.push({
        answer: (n: number) => resolve({ ok: true, status: 200, json: async () => ({ count: n }) }),
        fail: () => resolve({ ok: false, status: 500, json: async () => ({}) }),
      });
    });
  }));
});

afterEach(async () => {
  vi.clearAllTimers();
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(count = 1) {
  const { useChatUnreadTotal } = await import('./use-chat-unread-total');
  function Badge({ id }: { id: string }) { return <span data-testid={id}>{useChatUnreadTotal('me')}</span>; }
  await act(async () => { root.render(<>{Array.from({ length: count }, (_, i) => <Badge key={i} id={i === 0 ? 'n' : `n${i}`} />)}</>); });
}

describe('useChatUnreadTotal — the badge equals the server count (story 4876)', () => {
  it('⭐replayed events (is_backfill) after the first fetch add nothing: server 2 → badge 2, not 4', async () => {
    await mount();
    expect(requests).toHaveLength(1);
    await act(async () => { requests[0]!.answer(2); });
    await settle();
    expect(badge()).toBe('2');
    await emit({ id: 'm1', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: true });
    await emit({ id: 'm2', conversation_id: 'c2', sender: { id: 'agent' }, is_backfill: true });
    expect(badge()).toBe('2'); // no +1 for either
    await waitDebounce();
    expect(requests).toHaveLength(2); // two events · ONE recount
    await act(async () => { requests[1]!.answer(2); });
    await settle();
    expect(badge()).toBe('2');
  });

  it('a replayed event for a message created AFTER the fetch snapshot is picked up by the recount (never under-counted)', async () => {
    await mount();
    await act(async () => { requests[0]!.answer(4); });
    await settle();
    await emit({ id: 'late', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: true });
    expect(badge()).toBe('4');
    await waitDebounce();
    await act(async () => { requests[1]!.answer(5); });
    await settle();
    expect(badge()).toBe('5');
  });

  it('⭐a live event while the FIRST fetch is out does not count twice: its answer (5) already holds it → 5, not 6', async () => {
    await mount();
    expect(requests).toHaveLength(1);
    await emit({ id: 'm1', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: false });
    await act(async () => { requests[0]!.answer(5); });
    await settle();
    expect(badge()).toBe('5');
    await waitDebounce();
    expect(requests).toHaveLength(2); // the event is checked against the server
    await act(async () => { requests[1]!.answer(5); });
    await settle();
    expect(badge()).toBe('5');
  });

  it('⭐a live event while a LATER request is out (a number is held; the answer may predate the message) is checked again: the final number is the server\'s', async () => {
    await mount();
    await act(async () => { requests[0]!.answer(4); });
    await settle();
    await emit({ id: 'old', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: true });
    await waitDebounce();
    expect(requests).toHaveLength(2); // the recount is out now
    await emit({ id: 'new', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: false });
    expect(badge()).toBe('4'); // no +1 while a request that may not hold it is out
    await act(async () => { requests[1]!.answer(4); }); // this answer was taken before the new message
    await settle();
    expect(badge()).toBe('4');
    await waitDebounce();
    expect(requests).toHaveLength(3); // the new message is asked about again
    await act(async () => { requests[2]!.answer(5); });
    await settle();
    expect(badge()).toBe('5');
  });

  it('a live event with a server number in hand still adds 1 at once (no extra request)', async () => {
    await mount();
    await act(async () => { requests[0]!.answer(4); });
    await settle();
    await emit({ id: 'm1', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: false });
    expect(badge()).toBe('5');
    await emit({ id: 'm2', conversation_id: 'c1', sender: { id: 'agent' } }); // a payload without the flag is live
    expect(badge()).toBe('6');
    await waitDebounce();
    expect(requests).toHaveLength(1);
  });

  it('the first fetch failed (no server number yet): an event does not count from 0 — the recount gives the server number', async () => {
    await mount();
    await act(async () => { requests[0]!.fail(); });
    await settle();
    await emit({ id: 'm1', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: false });
    expect(badge()).toBe('0'); // not 1
    await waitDebounce();
    await act(async () => { requests[1]!.answer(3); });
    await settle();
    expect(badge()).toBe('3');
  });

  it('my own message never counts (replayed or live) and asks nothing', async () => {
    await mount();
    await act(async () => { requests[0]!.answer(2); });
    await settle();
    await emit({ id: 'mine', conversation_id: 'c1', sender: { id: 'me' }, is_backfill: true });
    await emit({ id: 'mine2', conversation_id: 'c1', sender: { id: 'me' }, is_backfill: false });
    expect(badge()).toBe('2');
    await waitDebounce();
    expect(requests).toHaveLength(1);
  });

  it('several badges on one screen: two replayed events → ONE shared recount request, every badge shows the server number', async () => {
    await mount(2);
    expect(requests).toHaveLength(1); // the first fetch is shared
    await act(async () => { requests[0]!.answer(2); });
    await settle();
    await emit({ id: 'm1', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: true });
    await emit({ id: 'm2', conversation_id: 'c2', sender: { id: 'agent' }, is_backfill: true });
    await waitDebounce();
    expect(requests).toHaveLength(2);
    await act(async () => { requests[1]!.answer(2); });
    await settle();
    expect(badge('n')).toBe('2');
    expect(badge('n1')).toBe('2');
  });
  it('⭐the recount goes out once the events go quiet (trailing), not 250 ms after the first of a burst', async () => {
    await mount();
    await act(async () => { requests[0]!.answer(2); });
    await settle();
    await emit({ id: 'b1', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: true });
    await advance(150);
    await emit({ id: 'b2', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: true });
    await advance(150); // 300 ms after the first event, 150 after the last
    expect(requests).toHaveLength(1); // not yet
    await advance(150);
    await settle();
    expect(requests).toHaveLength(2); // one recount for the burst
  });

  it('⭐a steady stream of events still gets a recount within 1.5 s of the burst\'s first event (a hard ceiling, not 1.5 s + one quiet wait)', async () => {
    await mount();
    await act(async () => { requests[0]!.answer(2); });
    await settle();
    for (let i = 0; i < 7; i += 1) { // an event every 200 ms (t = 0 … 1200): never quiet for 250 ms
      await emit({ id: `s${i}`, conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: true });
      await advance(200);
    }
    await emit({ id: 's7', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: true }); // t = 1400: restarts the quiet wait…
    expect(requests).toHaveLength(1);
    await advance(100); // …which must not run past t = 1500
    expect(requests).toHaveLength(2);
  });

  it('⭐a refresh that fails leaves no number to trust: the next live event recounts instead of adding 1 to a stale number', async () => {
    await mount();
    await act(async () => { requests[0]!.answer(4); });
    await settle();
    await act(async () => { for (const r of sse.reads) r(); }); // «read elsewhere» → a refresh
    await settle();
    expect(requests).toHaveLength(2);
    await act(async () => { requests[1]!.fail(); });
    await settle();
    expect(badge()).toBe('4'); // still what we had
    await emit({ id: 'l1', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: false });
    expect(badge()).toBe('4'); // not 5
    await waitDebounce();
    expect(requests).toHaveLength(3);
    await act(async () => { requests[2]!.answer(1); });
    await settle();
    expect(badge()).toBe('1');
  });

  it('⭐the pending recount dies with the last badge: a screen mounted right after (an org switch, a route change) is not asked by the old timer', async () => {
    await mount();
    await act(async () => { requests[0]!.answer(2); });
    await settle();
    await emit({ id: 'b1', conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: true });
    await act(async () => { root.render(null); }); // the last badge goes away with a recount pending
    await mount(); // …and a new screen mounts inside the quiet wait: its own first request only
    expect(requests).toHaveLength(2);
    await waitDebounce();
    expect(requests).toHaveLength(2); // the old timer must not add a third
  });
});
