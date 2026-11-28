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
    if (url.endsWith('/working')) { const asOf = hostRunNow; if (workingGate) await workingGate; if (workingFails) return { ok: false, status: 500, json: async () => ({}) }; return { ok: true, json: async () => ({ data: working ? [{ member_id: A1, ...(asOf === 'absent' ? {} : { host_run: asOf }) }] : [] }) }; }
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
            <ChatView threadId={threadId} currentTeamMemberId="me-1" commandTargets={[...TARGETS]} participants={PARTICIPANTS} />
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
/** an SSE `conversation.working` event as the server sends it: the rows of who works, each with its `host_run` (omitted = an old server that does not say) */
const emitRows = (rows: Array<{ member_id: string; host_run?: boolean }>) => { for (const es of FakeEventSource.instances) es.emit('conversation.working', { conversation_id: 'thread-1', working: rows.map((r) => ({ state: 'working', ...r })) }); };
const host = (id = A1) => ({ member_id: id, host_run: true });
const plugin = (id = A1) => ({ member_id: id, host_run: false });
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

describe('story 5046 (C13): the choice is only for agents a HOST runs — the server says it on every row (GET /working and the SSE event alike)', () => {
  const chip = () => container.querySelector('[data-testid="delivery-choice"]');
  it('⭐a working agent the server says is NOT run by a host (a webhook · the channel plugin) → no choice, and the send has no word', async () => {
    stubFetch(true, false);
    await mount();
    await type('hi');
    expect(chip()).toBeNull();
    await send();
    expect('delivery_mode' in posts()[0]!.body!).toBe(false);
  });
  it('⭐an old server (no `host_run` on the row) → no choice: the old behaviour, nothing promised', async () => {
    stubFetch(true, 'absent');
    await mount();
    await type('hi');
    expect(chip()).toBeNull();
  });
  it('⭐an agent that starts working after the view opened: the EVENT carries host_run — the choice is drawn from it, with NO second read', async () => {
    stubFetch(false, true);
    await mount();
    const before = workingReads();
    await act(async () => { emitRows([host()]); });
    await settle();
    await type('hi');
    expect(chip()).not.toBeNull();
    expect(workingReads(), 'the event is the value — nothing is read to complete it').toBe(before);
  });
  it('an event row WITHOUT host_run (an old server) never draws the choice', async () => {
    stubFetch(false, true);
    await mount();
    await act(async () => { emitRows([{ member_id: A1 }]); });
    await settle();
    await type('hi');
    expect(chip()).toBeNull();
  });
  it('⭐a host agent stops and comes back run by the channel plugin: the newest event is the list — nothing stale is kept', async () => {
    stubFetch(false, true);
    await mount();
    await act(async () => { emitRows([host()]); });
    await settle();
    await type('hi');
    expect(chip()).not.toBeNull();
    await act(async () => { emitRows([]); });
    await settle();
    expect(chip()).toBeNull();
    await act(async () => { emitRows([plugin()]); });
    await settle();
    expect(chip()).toBeNull();
  });
  it('⭐the stream drops and comes back after an event was MISSED (the agent became a plugin meanwhile): the list is read again whole — it is not left as it was (codex, 8th pass)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch(true, true);
    await mount();
    await type('hi');
    expect(chip()).not.toBeNull();                      // a host runs the working agent
    const first = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    await act(async () => { first.onopen?.(); });       // the stream is up
    const before = workingReads();
    stubFetch(true, false);                              // …while the stream is down the agent comes back run by the plugin; its event is missed
    await act(async () => { first.onerror?.(); });      // the stream drops
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });   // …the multiplexer retries
    const second = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    expect(second).not.toBe(first);
    await act(async () => { second.onopen?.(); });      // …and the stream is back: a RECONNECT
    await settle();
    expect(workingReads(), 'a reconnect reads the list again').toBe(before + 1);
    expect(chip(), 'the choice of the old list must be gone').toBeNull();
  });
  it('⭐the first read is still on its way when a NEWER event arrives: the event\'s list stays — the older read cannot bring an agent back when it lands', async () => {
    stubFetch(true, true);
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    await mount();                                       // the first read is asked and held at the gate (the server says: A1 works, run by a host)
    await act(async () => { emitRows([]); });            // a NEWER event: nobody works
    await settle();
    await type('hi');
    expect(chip()).toBeNull();
    workingGate = null;
    await act(async () => { release(); });               // the older read lands now
    await settle();
    expect(chip(), 'the held read was asked before the event: its answer (A1 works) is older and is not shown').toBeNull();
  });
  it('⭐an agent replies while a reconnect read is on its way: the server\'s event that follows the reply is the newer list — the older read does not bring the agent back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch(true, true);
    await mount();
    await type('hi');
    expect(chip()).not.toBeNull();                       // the first read: A1 works, run by a host
    const first = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    await act(async () => { first.onopen?.(); });
    await act(async () => { first.onerror?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const second = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    await act(async () => { second.onopen?.(); });       // the reconnect asks for the list — held at the gate
    await settle();
    await act(async () => { for (const e of FakeEventSource.instances) e.emit('conversation.message_created', { id: 'm-reply', conversation_id: 'thread-1', created_by: A1, sender: { id: A1, name: '미르코', type: 'agent' }, content: '끝났어요', attachments: [], created_at: new Date().toISOString(), reply_count: 0 }); });
    await act(async () => { emitRows([]); });            // …and the event the server sends after it: nobody works
    await settle();
    expect(chip()).toBeNull();
    workingGate = null;
    await act(async () => { release(); });               // the held read lands (it still says: A1 works)
    await settle();
    expect(chip(), 'a read asked for before the event is older than it — it must not bring the agent back').toBeNull();
  });
  it('⭐two reads at once (the first read is slow, a reconnect reads again and is answered first): the OLDER one landing last does not overwrite the newer answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch(true, true);
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    await mount();                                       // read 1 held (it will say: A1 is run by a host)
    const first = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    await act(async () => { first.onopen?.(); });
    await act(async () => { first.onerror?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const second = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    const held = workingGate;
    workingGate = null;
    stubFetch(true, false);                              // now the agent is run by the plugin
    await act(async () => { second.onopen?.(); });       // read 2: answered at once — host_run false
    await settle();
    await type('hi');
    expect(chip()).toBeNull();
    await act(async () => { release(); });               // read 1 lands LAST with the old answer (host true)
    await settle();
    expect(held).not.toBeNull();
    expect(chip(), 'the older read must not overwrite the newer answer').toBeNull();
  });
  it('⭐another room (the view is reused for the next thread): the old room\'s rows are not this room\'s — no choice from them while the new room\'s read is on its way', async () => {
    stubFetch(true, true);
    await mount('thread-1');
    await type('hi');
    expect(chip()).not.toBeNull();
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    stubFetch(true, false);
    await mount('thread-2');
    await settle();
    await type('hi again');
    expect(chip(), 'room 1\'s «host» must not decide for room 2').toBeNull();
    workingGate = null;
    await act(async () => { release(); });
    await settle();
    expect(chip()).toBeNull();
  });
  it('⭐a newer read (a reconnect) FAILS while an older read that succeeded was set aside for it: the failed one is asked again by itself — nothing is left waiting (codex, 2nd pass)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch(true, true);
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    await mount();                                       // read 1 held (it will answer: A1 host)
    const first = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    await act(async () => { first.onopen?.(); });
    await act(async () => { first.onerror?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const second = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    workingGate = null;
    workingFails = true;
    await act(async () => { second.onopen?.(); });       // read 2 (the reconnect's) fails at once
    await settle();
    await act(async () => { release(); });               // read 1 lands: it is the OLDER read — set aside
    await settle();
    await type('hi');
    expect(chip()).toBeNull();                           // nothing is shown yet
    workingFails = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });   // the retry of the reconnect's read
    await settle();
    expect(chip(), 'the failed read is asked again by itself').not.toBeNull();
  });
  it('⭐reconnect after reconnect while reads keep failing: each new read REPLACES the earlier chain of retries — no second chain, no stray timer (codex, 5th pass)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch(true, true);
    await mount();
    const first = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    await act(async () => { first.onopen?.(); });
    await act(async () => { first.onerror?.(); });                                 // (from now on every open of a stream counts as a RECONNECT — the back-off remembers the error)
    for (let i = 0; i < 40 && FakeEventSource.instances[FakeEventSource.instances.length - 1] === first; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const next = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    expect(next).not.toBe(first);
    workingFails = true;
    const base = workingReads();
    await act(async () => { next.onopen?.(); });                                   // reconnect 1: its read fails → a retry chain waits (2 s)
    await settle();
    expect(workingReads() - base).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await act(async () => { next.onopen?.(); });                                   // reconnect 2 comes while that chain still waits: it must REPLACE it
    await settle();
    expect(workingReads() - base, 'premise: the second reconnect came before the first chain\'s retry fired').toBe(2);
    const before = workingReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await settle();
    expect(workingReads() - before, 'one retry (the newest chain\'s), not one per reconnect').toBe(1);
  });
  it('⭐an earlier chain\'s read is still IN FLIGHT when a newer reconnect starts its own chain, and it fails later: it must not start a second chain of retries (codex, 5th pass)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubFetch(true, true);
    await mount();
    const first = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    await act(async () => { first.onopen?.(); });
    await act(async () => { first.onerror?.(); });
    for (let i = 0; i < 40 && FakeEventSource.instances[FakeEventSource.instances.length - 1] === first; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const next = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    workingFails = true;
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    await act(async () => { next.onopen?.(); });         // reconnect 1: its read is asked and HELD (it will fail when it lands)
    await settle();
    workingGate = null;
    await act(async () => { next.onopen?.(); });         // reconnect 2: its own chain; its read fails at once → its retry waits (2 s)
    await settle();
    await act(async () => { release(); });               // the held read of the OLD chain fails now: it must end there
    await settle();
    const before = workingReads();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await settle();
    expect(workingReads() - before, 'one retry (the newest chain\'s) — the old chain must not add its own').toBe(1);
  });
  it('⭐a read of the room before lands late (the view moved to the next room meanwhile): it does not wipe the new room\'s list (codex)', async () => {
    stubFetch(true, false);                              // room 1: the agent is run by the plugin
    let release!: () => void;
    workingGate = new Promise<void>((r) => { release = r; });
    await mount('thread-1');                             // room 1's read is held
    workingGate = null;
    stubFetch(true, true);                               // room 2: run by a host
    await mount('thread-2');                             // room 2's read is answered at once
    await settle();
    await type('hi');
    expect(chip()).not.toBeNull();
    await act(async () => { release(); });               // room 1's late answer lands
    await settle();
    expect(chip(), 'the late answer of the room before must not take the new room\'s list away').not.toBeNull();
  });
  it('⭐the parent builds a NEW target list on every render (it does): a re-render with a fresh list does not hide the working list and asks for no new read', async () => {
    stubFetch(true, true);
    await mount();
    await type('hi');
    expect(chip()).not.toBeNull();
    const before = workingReads();
    await mount();
    await mount();
    await settle();
    expect(chip(), 'a fresh target list must not hide the choice').not.toBeNull();
    expect(workingReads(), 'and must not start another read').toBe(before);
  });
  it('⭐a first read that fails is tried again by itself (a room already working when the view opens is not left waiting for an event)', async () => {
    stubFetch(true, true);
    workingFails = true;
    await mount();
    await type('hi');
    expect(chip()).toBeNull();                           // nothing answered yet → no choice (the safe side)
    workingFails = false;
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });   // the retry (after 2 s) is answered
    await settle();
    expect(chip()).not.toBeNull();
  }, 10_000);
  it('the pins stand in the view: a read is shown only if no event came meanwhile · a reconnect reads the list · the event is the list', () => {
    const view = fs.readFileSync(path.join(__dirname, 'chat-view.tsx'), 'utf8');
    expect(view).toContain('if (seq === workingSeqRef.current && ticket === workingReadRef.current) setWorkingRows({ thread: threadId, rows: json.data ?? [] });');
    expect(view).toContain('startWorkingRead(); // story 5046: an event missed while the stream was down');
    expect(view).toContain('setWorkingRows({ thread: threadId, rows: payload.working ?? [] });');
    expect(view).not.toContain('hostRunRef');
    expect(view).not.toContain('WorkingReader');
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
