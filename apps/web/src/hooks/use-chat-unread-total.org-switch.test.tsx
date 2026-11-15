// @vitest-environment jsdom
//
// story 4881 — the «대화» tab badge belongs to ONE organization. Measured on dev (web, switcher's project row → switchOrgAndProject → router.refresh()): organization B has 4 unread
// and A has 2 — after switching B → A the badge still said 4; a new message in A made it 5 (server 3); switching back to B showed 5 (server 4). The hook stays mounted across the
// switch and nothing in it noticed: the stream that reconnects for the new organization replays only events the page has not seen (the per-hook dedup drops the ones it already
// saw), so no replay ever asked the server again. These tests drive the hook the way the shell does — `setEffectiveOrgId()` while it renders — and read the badge.
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
/** one entry per `/api/conversations/unread-count` request, in order — `org` is the organization the shell had set when it went out */
let requests: Array<{ org: string; answer: (n: number) => void; fail: () => void }> = [];
let setOrg: (org: string | undefined) => Promise<void>;
const WAIT_MS = 320;

const settle = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const waitDebounce = async () => { await advance(WAIT_MS); await settle(); };
const badge = () => container.querySelector('[data-testid="n"]')!.textContent;
const emit = async (payload: Record<string, unknown>) => { await act(async () => { for (const h of sse.handlers) h(payload); }); await settle(); };
const answer = async (i: number, n: number) => { await act(async () => { requests[i]!.answer(n); }); await settle(); };
const live = (org: string | undefined, extra: Record<string, unknown> = {}) => ({ id: `m${Math.random()}`, conversation_id: 'c1', sender: { id: 'agent' }, is_backfill: false, ...(org ? { stream_org_id: org } : {}), ...extra });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.resetModules();
  sse.handlers = [];
  sse.reads = [];
  requests = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ctx = await import('@/lib/project-context-client'); // loaded up front: the stub must read the organization synchronously when the request goes out
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (!String(url).includes('/api/conversations/unread-count')) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    const org = ctx.getEffectiveOrgId() ?? '';
    return new Promise((resolve) => {
      requests.push({
        org,
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

/** like the shell: the effective organization is set while rendering (before its children render), then the badge hook runs */
async function mount(firstOrg: string | null = 'A') { // null = no organization set at all (a default value would swallow `undefined`)
  const ctx = await import('@/lib/project-context-client');
  const { useChatUnreadTotal } = await import('./use-chat-unread-total');
  function Badge() { return <span data-testid="n">{useChatUnreadTotal('me')}</span>; }
  function Shell({ org, tick }: { org: string | undefined; tick: number }) { ctx.setEffectiveOrgId(org); return <div data-tick={tick}><Badge /></div>; }
  let tick = 0;
  setOrg = async (org) => { tick += 1; await act(async () => { root.render(<Shell org={org} tick={tick} />); }); };
  await act(async () => { root.render(<Shell org={firstOrg ?? undefined} tick={0} />); });
}
const switchTo = async (org: string | undefined) => { await setOrg(org); await settle(); };

describe('useChatUnreadTotal — the badge follows the organization (story 4881)', () => {
  it('⭐the measured sequence: B (4) → switch to A (server 2) → badge 2, not 4 · a new message in A → 3 · back to B (server 4) → 4', async () => {
    await mount('B');
    await answer(0, 4);
    expect(badge()).toBe('4');
    await switchTo('A');
    expect(badge()).toBe('0'); // never B's number under A
    expect(requests).toHaveLength(2);
    expect(requests[1]!.org).toBe('A');
    await answer(1, 2);
    expect(badge()).toBe('2');
    await emit(live('A')); // a live message in A: instant +1 (a server number is in hand)
    expect(badge()).toBe('3');
    await switchTo('B');
    expect(badge()).toBe('0');
    expect(requests[2]!.org).toBe('B');
    await answer(2, 4);
    expect(badge()).toBe('4');
  });

  it('the old organization\'s number is gone the moment the organization changes (0 until the new number arrives), and the server is asked once for the new one', async () => {
    await mount('A');
    await answer(0, 7);
    await switchTo('B');
    expect(badge()).toBe('0');
    expect(requests).toHaveLength(2);
    await answer(1, 1);
    expect(badge()).toBe('1');
  });

  it('⭐an answer to a request the OLD organization sent never shows under the new one (it arrives after the switch)', async () => {
    await mount('A');
    expect(requests).toHaveLength(1);
    await switchTo('B');
    expect(requests).toHaveLength(2);
    await answer(0, 9); // A's number, late
    expect(badge()).toBe('0');
    await answer(1, 3);
    expect(badge()).toBe('3');
  });

  it('⭐a frame from the stream the page just left (stream_org_id = the old organization) is ignored: no +1, no recount', async () => {
    await mount('A');
    await answer(0, 2);
    await switchTo('B');
    await answer(1, 4);
    expect(badge()).toBe('4');
    await emit(live('A')); // the old stream's late frame
    await emit(live('A', { is_backfill: true }));
    await waitDebounce();
    expect(badge()).toBe('4');
    expect(requests).toHaveLength(2); // nothing asked either
  });

  it('a live frame of the CURRENT organization adds 1 at once, and so does a frame with no stream_org_id (an older server — counted as before)', async () => {
    await mount('B');
    await answer(0, 4);
    await emit(live('B'));
    expect(badge()).toBe('5');
    await emit(live(undefined));
    expect(badge()).toBe('6');
  });

  it('the organization compared without regard to letter case (a frame\'s uuid text vs the shell\'s)', async () => {
    await mount('5E860BD6-0000-0000-0000-000000000000');
    await answer(0, 1);
    await emit(live('5e860bd6-0000-0000-0000-000000000000'));
    expect(badge()).toBe('2');
  });

  it('⭐a late answer of the OLD organization does not free the new organization\'s «request out» mark: its live event is still checked against the server (no +1)', async () => {
    await mount('A');
    await switchTo('B'); // A's request (0) is still out; B's request (1) goes out
    await answer(1, 5); // B's number is in hand
    await emit(live('B', { is_backfill: true }));
    await waitDebounce();
    expect(requests).toHaveLength(3); // a recount for B (2) is out now
    await answer(0, 9); // A's late answer — it must not free B's recount's mark
    await emit(live('B')); // may already be in the recount's answer → check again, never +1
    expect(badge()).toBe('5');
    await answer(2, 6);
    expect(badge()).toBe('6');
  });

  it('⭐a request the old organization never answered does not pin «request out» for the new organization: once its own answers are in, a live event adds 1 at once', async () => {
    await mount('A'); // A's request (0) is never answered in time
    await switchTo('B');
    await answer(1, 5);
    await answer(0, 9); // late (or never) — either way it must not hold B's mark
    expect(badge()).toBe('5');
    await emit(live('B'));
    expect(badge()).toBe('6'); // instant: nothing is out for B
    await waitDebounce();
    expect(requests).toHaveLength(2); // and nothing was asked
  });

  it('a request that fails for the new organization leaves no number to add to: the next event asks again instead of adding 1', async () => {
    await mount('A');
    await answer(0, 2);
    await switchTo('B');
    await act(async () => { requests[1]!.fail(); });
    await settle();
    expect(badge()).toBe('0');
    await emit(live('B'));
    expect(badge()).toBe('0'); // not 1
    await waitDebounce();
    expect(requests).toHaveLength(3);
    await answer(2, 6);
    expect(badge()).toBe('6');
  });

  it('a re-render with the SAME organization asks nothing and keeps the number (a project switch, a refresh of the page props)', async () => {
    await mount('A');
    await answer(0, 3);
    await switchTo('A');
    await switchTo('A');
    expect(badge()).toBe('3');
    expect(requests).toHaveLength(1);
  });

  it('A → B → A inside one request: only the last organization\'s answer shows', async () => {
    await mount('A');
    await switchTo('B');
    await switchTo('A');
    expect(requests).toHaveLength(3);
    await answer(1, 8); // B's, late
    expect(badge()).toBe('0');
    await answer(2, 2); // A's own
    expect(badge()).toBe('2');
  });

  it('a person with no organization set (the field is empty) behaves as before: one request, +1 for a live event', async () => {
    await mount(null);
    expect(requests).toHaveLength(1);
    await answer(0, 1);
    await emit(live('X')); // no current organization to compare with → counted
    expect(badge()).toBe('2');
  });
});
