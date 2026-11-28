// @vitest-environment jsdom
//
// story 5046 (C13) — the room: the choice «지금 끼어들기 / 끝나고 이어서» above the input reaches the SEND BODY, and the server's record of how an «끝나고 이어서» message went in reaches the screen.
// Harness as chat-view.4440.test.tsx (the real SSE hook over a fake EventSource, a stubbed fetch). Red when: the default send carries the word (`delivery_mode` must be absent — «지금» is the server's default) ·
// «끝나고 이어서» is not in the body · the working agent of a 1:1 does not make the choice appear · a message waiting for its record is not read again (and one that has its record keeps being read) ·
// the line under the bubble is drawn for the record.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/chats/thread-1' }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<(e: { data: string }) => void>> = {};
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  readyState = 1;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, cb: (e: { data: string }) => void) { (this.listeners[type] ??= []).push(cb); }
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
  close() { /* noop */ }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const A1 = 'a1111111-1111-4111-8111-111111111111';
const TARGETS = [{ agentId: A1, agentName: '미르코', runtimeType: 'claude-code' }];
const PARTICIPANTS = [{ member_id: 'me-1', name: '안나', type: 'human' }, { member_id: A1, name: '미르코', type: 'agent', runtime_type: 'claude-code' }];

type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[];
let listAnswer: () => Record<string, unknown>[];
let sentAnswer: Record<string, unknown>;

/** `hostRun`: what the server's /working says per working agent — `true`/`false` (a host runs it or not), `'absent'` = an old server that has no `host_run` */
let hostRunNow: boolean | 'absent' = true;
/** a read of GET /working that is held on its way (a late answer) until the gate opens */
let workingGate: Promise<void> | null = null;
/** the next reads of GET /working fail (an error answer) while this is true */
let workingFails = false;
function stubFetch(working = true, hostRun: boolean | 'absent' = true) {
  hostRunNow = hostRun;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'POST' && url.endsWith('/messages')) return { ok: true, status: 201, json: async () => sentAnswer };
    if (url.includes('/messages?')) return { ok: true, json: async () => ({ data: listAnswer(), meta: { next_cursor: null, has_more: false } }) };
    if (url.endsWith('/working')) { if (workingGate) await workingGate; if (workingFails) return { ok: false, status: 500, json: async () => ({}) }; return { ok: true, json: async () => ({ data: working ? [{ member_id: A1, ...(hostRunNow === 'absent' ? {} : { host_run: hostRunNow }) }] : [] }) }; }
    return { ok: true, json: async () => ({ data: [] }) };
  }));
}

beforeEach(() => {
  calls = []; listAnswer = () => []; sentAnswer = { data: {} }; workingGate = null; workingFails = false;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} });
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); vi.useRealTimers(); });

let mountedThread = 'thread-1';
async function mount(threadId = 'thread-1') {
  mountedThread = threadId;
  // the provider comes from the SAME module graph as the view (`vi.resetModules()` after each test gives the view fresh modules; a provider imported once at the top would be a different context — the view would never hear the stream in the second test on)
  const { RealtimeProvider } = await import('@/components/realtime-provider');
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <RealtimeProvider currentTeamMemberId="me-1">
          <ChatRailProvider>
            <ChatView threadId={threadId} currentTeamMemberId="me-1" commandTargets={TARGETS} participants={PARTICIPANTS} />
          </ChatRailProvider>
        </RealtimeProvider>
      </NextIntlClientProvider>,
    );
  });
  await settle();
}
async function settle() { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); }
const textarea = () => container.querySelector('textarea[data-slot="textarea"]') as HTMLTextAreaElement;
const type = async (v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(textarea(), v); textarea().dispatchEvent(new Event('input', { bubbles: true })); });
};
const btn = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;
const send = async () => { await act(async () => { (container.querySelector('[data-testid="chat-send"]') as HTMLButtonElement).click(); }); await settle(); };
const posts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'));
/** the multiplexer listens on whichever stream the provider opened — every open one is told (a listener that is not attached hears nothing) */
const emitWorking = (ids: string[] = [A1]) => { for (const es of FakeEventSource.instances) es.emit('conversation.working', { conversation_id: 'thread-1', working: ids.map((member_id) => ({ member_id, state: 'working' })) }); };
const workingReads = () => calls.filter((c) => c.method === 'GET' && c.url.endsWith('/working')).length;
const listReads = () => calls.filter((c) => c.method === 'GET' && c.url.includes('/messages?')).length;

const mine = (extra: Record<string, unknown> = {}) => ({
  id: 'm-mine', conversation_id: 'thread-1', created_by: 'me-1', sender: { id: 'me-1', name: '안나', type: 'human' }, content: '이어서 해 줘',
  attachments: [], created_at: new Date().toISOString(), reply_count: 0, ...extra,
});

describe('the choice reaches the send body', () => {
  it('a working agent in a 1:1 → the choice is drawn; the DEFAULT send has no `delivery_mode`', async () => {
    stubFetch(true);
    await mount();
    await type('지금 이것도 봐 줘');
    expect(container.querySelector('[data-testid="delivery-choice"]')).not.toBeNull();
    await send();
    expect(posts()).toHaveLength(1);
    expect('delivery_mode' in posts()[0]!.body!).toBe(false);
  });
  it('«끝나고 이어서» puts `delivery_mode: "after_turn"` in the body', async () => {
    stubFetch(true);
    await mount();
    await type('끝나면 해 줘');
    await act(async () => { btn('끝나고 이어서').click(); });
    await send();
    expect(posts()[0]!.body!.delivery_mode).toBe('after_turn');
  });
  it('an idle agent: no choice at all, and no word in the body', async () => {
    stubFetch(false);
    await mount();
    await type('hi');
    expect(container.querySelector('[data-testid="delivery-choice"]')).toBeNull();
    await send();
    expect('delivery_mode' in posts()[0]!.body!).toBe(false);
  });
});

describe('story 5046 (C13): the choice is only for agents a HOST runs (the server\'s `host_run` of GET /working)', () => {
  const chip = () => container.querySelector('[data-testid="delivery-choice"]');
  it('⭐a working agent the server says is NOT run by a host (a webhook · the channel plugin) → no choice, and the send has no word', async () => {
    stubFetch(true, false);
    await mount();
    await type('hi');
    expect(chip()).toBeNull();
    await send();
    expect('delivery_mode' in posts()[0]!.body!).toBe(false);
  });
  it('⭐an old server (no `host_run` in the answer) → no choice: the old behaviour, nothing promised', async () => {
    stubFetch(true, 'absent');
    await mount();
    await type('hi');
    expect(chip()).toBeNull();
  });
  it('⭐an agent that starts working AFTER the room opened (the SSE event lists who works, not who runs them) → the list is read again, and the choice is drawn once the server says a host runs it', async () => {
    stubFetch(false, true);
    await mount();
    const before = workingReads();
    stubFetch(true, true);
    await act(async () => { emitWorking(); });
    await settle();
    expect(workingReads()).toBe(before + 1);
    await type('hi');
    expect(chip()).not.toBeNull();
  });
  it('⭐an agent that stops and comes back run by something else (a host, then the channel plugin) is judged by the newest answer: nothing stale is kept (codex)', async () => {
    stubFetch(true, true);
    await mount();
    await type('hi');
    expect(chip()).not.toBeNull();
    await act(async () => { emitWorking([]); });
    await settle();
    stubFetch(true, false);
    await act(async () => { emitWorking(); });
    await settle();
    expect(chip()).toBeNull();
  });
  it('⭐while an event is shown the choice is not drawn until the answer says a host runs them (the names come at once, the choice only with the answer)', async () => {
    stubFetch(true, true);
    await mount();
    await type('hi');
    expect(chip()).not.toBeNull();
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    await act(async () => { emitWorking(); });   // the event: names now, the answer is held
    await settle();
    expect(chip()).toBeNull();
    workingGate = null;
    await act(async () => { release(); });
    await settle();
    expect(chip()).not.toBeNull();
  });
  it('⭐a read still on its way when SSE says «stopped» does not bring the agent back when it lands — its answer is old and nothing of it is shown, not even for a moment (codex)', async () => {
    stubFetch(true, true);
    await mount();
    await type('hi');
    expect(chip()).not.toBeNull();
    let release1!: () => void;
    let release2!: () => void;
    workingGate = new Promise<void>((r) => { release1 = r; });
    await act(async () => { emitWorking(); });        // a read (the first) is asked, and held at the gate — the server still says «A1 works» to it
    await settle();
    stubFetch(false, true);                           // …then the agent stops: the server now says nobody works
    await act(async () => { emitWorking([]); });      // the SSE event: nobody works any more
    await settle();
    expect(chip()).toBeNull();
    const gate2 = new Promise<void>((r) => { release2 = r; });
    workingGate = gate2;                              // the reader's SECOND read is held too, so the moment between the two can be seen
    await act(async () => { release1(); });           // the old read lands: its answer is old, nothing of it is shown
    await settle();
    expect(chip(), 'the old answer must not show the choice while the newer read is still on its way').toBeNull();
    workingGate = null;
    await act(async () => { release2(); });
    await settle();
    expect(chip()).toBeNull();
  });
  it('⭐events that arrive while a read is on its way are ONE more read, not one each (no request flood), and the answer shown is the newest', async () => {
    stubFetch(false, true);
    await mount();
    const before = workingReads();
    stubFetch(true, true);
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    await act(async () => { emitWorking(); });
    await settle();
    await act(async () => { emitWorking(); });
    await act(async () => { emitWorking(); });
    await act(async () => { emitWorking(); });
    await settle();
    workingGate = null;
    await act(async () => { release(); });
    await settle();
    expect(workingReads()).toBe(before + 2);   // the held read + ONE more for the three events behind it
    await type('hi');
    expect(chip()).not.toBeNull();
  });
  it('⭐a read that fails is tried again by itself (codex: no waiting for ever for the next event), and no choice is drawn until an answer is shown', async () => {
    stubFetch(false, true);
    await mount();
    stubFetch(true, true);
    workingFails = true;
    await act(async () => { emitWorking(); });        // the read fails
    await settle();
    await type('hi');
    expect(chip()).toBeNull();
    workingFails = false;
    await act(async () => { await new Promise((r) => setTimeout(r, 2200)); });   // the retry (after 2 s) is answered
    await settle();
    expect(chip()).not.toBeNull();
  }, 10_000);
  it('⭐another room (the view is reused for the next thread): the old room\'s list and its host_run are not this room\'s — no choice is drawn from them while the new room\'s read is on its way (codex)', async () => {
    stubFetch(true, true);
    await mount('thread-1');
    await type('hi');
    expect(chip()).not.toBeNull();                       // room 1: a host runs the working agent
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    stubFetch(true, false);                              // room 2: the same agent id, run by the plugin there
    await mount('thread-2');                             // the view is given another thread; the read for it is held
    await settle();
    await type('hi again');
    expect(chip(), 'room 1\'s «host» must not decide for room 2').toBeNull();
    workingGate = null;
    await act(async () => { release(); });
    await settle();
    expect(chip()).toBeNull();
  });
  it('⭐the view goes while a read is on its way: its answer is never shown and a failure leaves no retry timer behind (codex)', async () => {
    stubFetch(false, true);
    await mount();
    const before = workingReads();
    stubFetch(true, true);
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    workingFails = true;
    await act(async () => { emitWorking(); });           // a read is asked, held at the gate, and it will FAIL
    await settle();
    await act(async () => { root.unmount(); });          // the view goes
    root = createRoot(container);                        // (a fresh root so the shared teardown has something to unmount)
    workingGate = null;
    await act(async () => { release(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });   // longer than the first retry (2 s)
    expect(workingReads(), 'no read after the view went (no retry timer left)').toBe(before + 1);
  }, 10_000);
  it('a room starts with a full retry budget (the budget of the room before is not carried over)', () => {
    const view = fs.readFileSync(path.join(__dirname, 'chat-view.tsx'), 'utf8');
    expect(view).toContain('const reader = useMemo<WorkingReader>(() => ({ thread: threadId, running: false, again: false, fails: 0, timer: null, dead: false }), [threadId, commandTargets]);');
    expect(view).toContain("return () => { reader.dead = true; if (reader.timer) { clearTimeout(reader.timer); reader.timer = null; } };");
  });
  it('⭐back to a room (A → B → A): the list read the first time A was open is not shown while A\'s new read is on its way — a stale «host» cannot draw the choice (codex)', async () => {
    stubFetch(true, true);
    await mount('thread-1');
    await type('hi');
    expect(chip()).not.toBeNull();
    await mount('thread-2');
    await settle();
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    stubFetch(true, false);                  // …and room 1's agent is run by the plugin now
    await mount('thread-1');                 // back to room 1: the read for it is held
    await settle();
    await type('hi again');
    expect(chip(), 'the first visit\'s host_run must not decide now').toBeNull();
    workingGate = null;
    await act(async () => { release(); });
    await settle();
    expect(chip()).toBeNull();
  });
  it('⭐a reply that arrives while a read is on its way: the old answer does not bring the agent back (codex)', async () => {
    stubFetch(true, true);
    await mount();
    await type('hi');
    expect(chip()).not.toBeNull();
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    await act(async () => { emitWorking(); });               // a read is asked and held (the server still says «A1 works»)
    await settle();
    stubFetch(false, true);                                  // the agent answers: the server now says nobody works
    const es = FakeEventSource.instances;
    await act(async () => { for (const e of es) e.emit('conversation.message_created', { id: 'm-reply', conversation_id: 'thread-1', created_by: A1, sender: { id: A1, name: '미르코', type: 'agent' }, content: '끝났어요', attachments: [], created_at: new Date().toISOString(), reply_count: 0 }); });
    await settle();
    expect(chip()).toBeNull();                               // the reply took the agent off the list
    workingGate = null;
    await act(async () => { release(); });                   // the old read lands: its answer says A1 works — it is old
    await settle();
    expect(chip(), 'an answer asked for before the reply must not bring the agent back').toBeNull();
  });
  it('the reader is one place: an event outdates a read on its way (nothing of the old answer is shown) — the pins stand in the view', () => {
    const view = fs.readFileSync(path.join(__dirname, 'chat-view.tsx'), 'utf8');
    expect(view).toContain('if (st.running) { st.again = true; return; }');
    expect(view).toContain('if (st.again) continue;');
    expect(view).toContain('setTypingState({ reader, list: namedWorking(payload.working ?? [], false) });');
    expect(view).toContain('if (st.dead) return;');
    expect(view).not.toContain('hostRunRef');
  });
});

describe('the record of how it went in reaches the screen', () => {
  it('a message of mine sent «끝나고 이어서» says it is waiting, and the list is read again until the record arrives — then the line names how it went in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch(true);
    listAnswer = () => [mine({ delivery_mode: 'after_turn' })];
    await mount();
    expect(container.querySelector('[data-testid="delivery-timing-line"]')!.textContent).toContain('끝나고 이어서 보내요');
    const before = listReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    await settle();
    expect(listReads()).toBeGreaterThan(before); // read again while waiting
    // the host reports: the next read carries the record
    listAnswer = () => [mine({ delivery_mode: 'after_turn', delivery_log: { [A1]: { via: 'next_turn', at: '2026-11-26T12:00:00+00:00' } } })];
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    await settle();
    expect(container.querySelector('[data-testid="delivery-timing-line"]')!.textContent).toBe('미르코 · 턴이 끝난 뒤 들어갔어요');
    // …and once it has its record the 5 s poll is gone (only the stream's own, slower fallback may still read)
    const after = listReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    await settle();
    expect(listReads()).toBe(after);
  });
  it('a message that has waited longer than 15 minutes is no longer waited for (the poll stops — it does not run for ever)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch(true);
    listAnswer = () => [mine({ delivery_mode: 'after_turn', created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString() })];
    const setSpy = vi.spyOn(window, 'setInterval');
    const clearSpy = vi.spyOn(window, 'clearInterval');
    await mount();
    const before = listReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    await settle();
    expect(listReads()).toBe(before);
    // the 5 s loop was started for the waiting message … and cleared by itself once it found nothing it still waits for
    const started = setSpy.mock.calls.map((c, i) => ({ delay: c[1], id: setSpy.mock.results[i]!.value })).filter((c) => c.delay === 5000);
    expect(started.length).toBeGreaterThan(0);
    for (const { id } of started) expect(clearSpy, 'the 5 s loop ended itself — it does not tick on for ever').toHaveBeenCalledWith(id);
  });
  it('a message sent «지금» (no mode) is never polled for a record', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch(true);
    listAnswer = () => [mine()];
    await mount();
    const before = listReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); }); // (the stream's own 10 s fallback poll is not in this window — a read here would be the record poll)
    await settle();
    expect(listReads()).toBe(before);
    expect(container.querySelector('[data-testid="delivery-timing-line"]')).toBeNull();
  });
});
