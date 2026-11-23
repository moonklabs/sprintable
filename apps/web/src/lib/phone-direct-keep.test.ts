// story 4993 (PO ⓐ, 11-23) — the keeper: a screen of a computer in front makes the same-network road and keeps it alive (lib/phone-direct-keep.ts).
// The shell double is built FROM THE CONTRACT (contracts/direct-bridge.json: `replyOf` refuses a field the call's reply does not list — the lesson of 5898) and answers from a MODEL ROAD: a road made by `direct.ask` stays `ready` until it has gone 60 s without a ping (the shell's idle)
// or lives 10 minutes (the Mac's life), whichever comes first. Everything runs on one fake clock. Each check goes red without the line it names.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIRECT_KEEP_EVERY_MS, DIRECT_KEEP_GRACE_MS, DIRECT_KEEP_OPENS_PER_HOUR, DIRECT_KEEP_OPENS_PER_MINUTE, __resetDirectKeepForTest, holdDirectRoad, type KeepEnv } from './phone-direct-keep';
import { openFired } from './phone-direct';
import type { PhoneAnswer } from './phone-bridge';

const ROOT = path.resolve(__dirname, '../../../..');
const contract = JSON.parse(readFileSync(path.join(ROOT, 'contracts', 'direct-bridge.json'), 'utf8')) as { version: number; calls: Record<string, { reply: Record<string, unknown> }> };
const SETUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const IDLE_MS = 60_000; const LIFE_MS = 600_000;

/** the answer of `call` as the page receives it: `{id, ...values}`, and only fields the contract lists for that call */
function replyOf(call: string, values: Record<string, unknown>): PhoneAnswer {
  const spec = contract.calls[call]; expect(spec, `the contract has the call ${call}`).toBeTruthy();
  for (const k of Object.keys(values)) expect(Object.keys(spec!.reply), `the contract lists «${k}» in the reply of ${call}`).toContain(k);
  return { id: `id-${call}`, ...values } as unknown as PhoneAnswer;
}
function traced(a: PhoneAnswer, reads: Set<string>): PhoneAnswer { return new Proxy(a, { get(t, k, r) { if (typeof k === 'string') reads.add(k); return Reflect.get(t, k, r); }, has(t, k) { if (typeof k === 'string') reads.add(k); return Reflect.has(t, k); } }); }

interface World { env: KeepEnv; calls: string[]; keepTimes: number[]; reads: Record<string, Set<string>>; asks: () => number; pings: () => number; closes: () => number; roadState: () => string; setVisible: (v: boolean) => void; setCaps: (c: PhoneAnswer | 'never') => void; keepAnswer: (a: PhoneAnswer | null) => void; endRoad: () => void; setAskWorks: (v: boolean) => void; setAskAsking: (ms: number) => void; setCloseDelay: (ms: number) => void; setKeepDelay: (ms: number) => void }
function world(): World {
  type Road = { state: 'idle' | 'ready' | 'asking'; readyAt: number; lastPing: number; askingUntil?: number }; const roads = new Map<string, Road>();
  const roadOf = (args: Record<string, unknown>): Road => { const k = String(args.setup_id ?? ''); let r = roads.get(k); if (!r) { r = { state: 'idle', readyAt: 0, lastPing: 0 }; roads.set(k, r); } return r; };
  const calls: string[] = []; const keepTimes: number[] = []; const reads: Record<string, Set<string>> = { 'direct.keep': new Set(), 'direct.status': new Set() };
  let asks = 0; let pings = 0; let closes = 0; let visible = true; const cbs = new Set<() => void>();
  let caps: PhoneAnswer | 'never' = { id: 'c', ok: true, caps: { direct: 1, direct_keep: 1 } };
  let keepOverride: PhoneAnswer | null = null; let askWorks = true; let keepDelay = 0; let askingMs = 0; let closeDelay = 0;
  const stateOf = (road: Road): 'idle' | 'ready' | 'asking' => { if (road.state === 'asking' && Date.now() >= (road.askingUntil ?? 0)) road.state = 'idle'; if (road.state === 'ready' && (Date.now() - road.lastPing >= IDLE_MS || Date.now() - road.readyAt >= LIFE_MS)) road.state = 'idle'; return road.state; };
  const phoneCall = vi.fn((type: string, args: Record<string, unknown> = {}): Promise<PhoneAnswer> => {
    calls.push(type); const road = roadOf(args); const state = () => stateOf(road);
    switch (type) {
      case 'shell.caps': return caps === 'never' ? new Promise(() => {}) : Promise.resolve(caps);
      case 'direct.keep': { keepTimes.push(Date.now() - 1_000_000); if (keepDelay > 0) { const d = keepDelay; return new Promise((res) => setTimeout(() => { if (state() === 'ready') { road.lastPing = Date.now(); pings += 1; } res(traced(replyOf('direct.keep', { state: state() }), reads['direct.keep']!)); }, d)); } if (keepOverride) return Promise.resolve(traced(keepOverride, reads['direct.keep']!)); if (state() === 'ready') { road.lastPing = Date.now(); pings += 1; } return Promise.resolve(traced(replyOf('direct.keep', { state: state() }), reads['direct.keep']!)); }
      case 'direct.status': return Promise.resolve(traced(replyOf('direct.status', { state: state() }), reads['direct.status']!));
      case 'direct.ask': asks += 1; if (askingMs > 0) { road.state = 'asking'; road.askingUntil = Date.now() + askingMs; } else if (askWorks) { road.state = 'ready'; road.readyAt = Date.now(); road.lastPing = Date.now(); } return Promise.resolve({ id: 'a', ok: false, code: 'no_road' }); // (the Mac made the road; the negotiation's own legs are not what is judged here)
      case 'direct.close': closes += 1; if (closeDelay > 0) return new Promise((res) => setTimeout(() => { road.state = 'idle'; res({ id: 'c', ok: true }); }, closeDelay)); road.state = 'idle'; return Promise.resolve({ id: 'c', ok: true });
      default: return Promise.resolve({ id: 'z', ok: false });
    }
  });
  const env: KeepEnv = { phoneCall, visible: () => visible, onVisibility: (cb) => { cbs.add(cb); return () => cbs.delete(cb); }, timer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }, deps: { openFired: new Map<string, number>() } };
  return { env, calls, keepTimes, reads, asks: () => asks, pings: () => pings, closes: () => closes, roadState: () => stateOf(roadOf({ setup_id: SETUP })), setVisible: (v) => { visible = v; for (const cb of [...cbs]) cb(); }, setCaps: (c) => { caps = c; }, keepAnswer: (a) => { keepOverride = a; }, endRoad: () => { roadOf({ setup_id: SETUP }).state = 'idle'; }, setAskWorks: (v) => { askWorks = v; }, setAskAsking: (ms) => { askingMs = ms; }, setCloseDelay: (ms) => { closeDelay = ms; }, setKeepDelay: (ms) => { keepDelay = ms; } };
}
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { __resetDirectKeepForTest(); vi.useRealTimers(); });

describe('[4993 ⓐ] the contract and the model', () => {
  it('the contract (v4) has `direct.keep` and its reply is {state} — no `ok`, like direct.status', () => {
    expect(contract.version).toBeGreaterThanOrEqual(4); expect(Object.keys(contract.calls['direct.keep']!.reply)).toEqual(['state']);
  });
  it('control: without a keeper the model road dies at its 60 s idle (so the tests below prove something)', async () => {
    const w = world(); await w.env.phoneCall('direct.ask', { setup_id: SETUP }); expect(w.roadState()).toBe('ready'); await run(IDLE_MS - 1); expect(w.roadState()).toBe('ready'); await run(1); expect(w.roadState()).toBe('idle');
  });
});

describe('[4993 ⓐ] a screen in front makes the road and keeps it', () => {
  it('the screen comes to the front: the road is made at once (not at the first press), and pinged every 30 s', async () => {
    const w = world(); holdDirectRoad(SETUP, w.env); await run(1);
    expect(w.calls.slice(0, 3)).toEqual(['shell.caps', 'direct.keep', 'direct.ask']); expect(w.roadState()).toBe('ready');
    await run(DIRECT_KEEP_EVERY_MS); expect(w.pings()).toBe(1); expect(w.calls.filter((c) => c === 'direct.keep')).toHaveLength(2);
    await run(DIRECT_KEEP_EVERY_MS * 3); expect(w.pings()).toBe(4); expect(w.asks()).toBe(1); expect(w.roadState()).toBe('ready');
  });

  it('LIMIT ARITHMETIC: an hour in front (3 590 s) on the model road (idle 60 s · life 10 min) → the road is ready every moment, made 6 times: at 0 · 10 · 20 · 30 · 40 · 50 minutes (the Mac allows 30 an hour), never a renegotiation per idle end', async () => {
    const w = world(); holdDirectRoad(SETUP, w.env); await run(1);
    let notReady = 0;
    for (let t = 0; t < 3_590_000; t += 10_000) { await run(10_000); if (w.roadState() !== 'ready') notReady += 1; }
    expect(w.asks()).toBe(6); expect(w.asks()).toBeLessThanOrEqual(30); expect(notReady, 'ready at every 10 s sample').toBe(0); expect(w.closes()).toBe(0);
  });

  it('one keeper per computer: a second computer\'s screen makes ITS road (the «started lately» note is per computer), and the first computer\'s road is not asked for again', async () => {
    const w = world(); holdDirectRoad(SETUP, w.env); await run(1); expect(w.asks()).toBe(1);
    holdDirectRoad('11111111-2222-4333-8444-555555555555', w.env); await run(1); expect(w.asks()).toBe(2); expect(w.calls.filter((c) => c === 'shell.caps')).toHaveLength(2);
  });
});

describe('[4993 ⓐ] the Mac\'s limits are kept even when roads cannot be made (codex round 1 of the web PR)', () => {
  it('a road that is never there (the Mac refuses · the network cannot): the wait between two makings doubles from a minute to ten — an hour in front makes a handful, never one every 30 s', async () => {
    const w = world(); w.setAskWorks(false); holdDirectRoad(SETUP, w.env); await run(1); const times: number[] = []; let seen = 0;
    for (let t = 0; t < 3_590_000; t += 10_000) { await run(10_000); if (w.asks() > seen) { seen = w.asks(); times.push(t + 10_000); } }
    expect(w.asks()).toBeLessThanOrEqual(10); expect(w.asks()).toBeGreaterThanOrEqual(6); const gaps = times.slice(1).map((x, i) => x - times[i]!); for (let i = 1; i < gaps.length; i++) expect(gaps[i]!, `gap ${i} does not shrink`).toBeGreaterThanOrEqual(gaps[i - 1]! - 10_000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(660_000); // (never longer than a road's own life + a look)
  });

  it('a road that comes back to being resets the wait: one failed making, then it works — the next end of life is made again at once', async () => {
    const w = world(); w.setAskWorks(false); holdDirectRoad(SETUP, w.env); await run(1); expect(w.asks()).toBe(1); await run(DIRECT_KEEP_EVERY_MS); // (the failure is seen at 30 s: a wait of a minute from the making)
    w.setAskWorks(true); await run(DIRECT_KEEP_EVERY_MS); expect(w.asks()).toBe(2); expect(w.roadState()).toBe('ready'); await run(DIRECT_KEEP_EVERY_MS * 2); // (made at 60 s; seen at 90 s: the wait is reset)
    await run(11 * 60_000); expect(w.asks()).toBe(3); expect(w.roadState()).toBe('ready'); // (the life ended at ten minutes: made again WITHOUT the old wait)
  });

  it('a road that is there resets the wait: two failed makings (wait 2 min), then one that works — when the Mac ends that road a minute later the keeper makes it again at the next look, not after the old wait', async () => {
    const w = world(); w.setAskWorks(false); holdDirectRoad(SETUP, w.env); await run(1); await run(90_000 + 1_000); // (makings at 0 and 60 s fail; the wait is now 2 min from the one at 60 s)
    expect(w.asks()).toBe(2); w.setAskWorks(true); await run(120_000); expect(w.asks()).toBe(3); expect(w.roadState()).toBe('ready'); // (the third making, at 180 s, works)
    await run(DIRECT_KEEP_EVERY_MS + 1_000); // (seen there at the next look: the wait is reset)
    w.endRoad(); const n = w.asks(); await run(DIRECT_KEEP_EVERY_MS); expect(w.asks(), 'made again at the next look').toBe(n + 1);
  });

  it('the page as a whole makes at most DIRECT_KEEP_OPENS_PER_HOUR roads from its keepers, however many computers have a screen and however they fail', async () => {
    const w = world(); w.setAskWorks(false); for (let i = 0; i < 6; i++) holdDirectRoad(`aaaaaaaa-bbbb-4ccc-8ddd-0000000000${String(i).padStart(2, '0')}`, w.env);
    for (let t = 0; t < 3_570_000; t += 30_000) await run(30_000); // (inside one hour: the window slides, so the first making's hour ends at 3 600 s)
    expect(w.asks()).toBeLessThanOrEqual(DIRECT_KEEP_OPENS_PER_HOUR); expect(w.asks()).toBe(DIRECT_KEEP_OPENS_PER_HOUR);
  });
});

describe('[4993 ⓐ] codex round 2 of the web PR: a late close · a road still being made · the minute', () => {
  it('a close that is still on its way when the screen comes back ends BEFORE the next look: the road that look makes is the one that stays (a late close never shuts it)', async () => {
    const w = world(); w.setCloseDelay(3_000); holdDirectRoad(SETUP, w.env); await run(1); expect(w.roadState()).toBe('ready');
    w.setVisible(false); await run(DIRECT_KEEP_GRACE_MS); expect(w.closes()).toBe(1); // (the close is on its way: 3 s)
    const n = w.calls.length; w.setVisible(true); await run(1_000); expect(w.calls.slice(n), 'no look while the close is on its way').toEqual([]);
    await run(2_100); expect(w.calls.slice(n).filter((c) => c === 'direct.keep' || c === 'direct.ask'), 'then the look: idle → the road is made').toEqual(['direct.keep', 'direct.ask']); expect(w.roadState()).toBe('ready'); expect(w.closes()).toBe(1);
    await run(DIRECT_KEEP_EVERY_MS * 3); expect(w.roadState(), 'and it stays').toBe('ready');
  });

  it('a road that is still being made at the next look (asking · connecting · proving) is not yet a road that came: its failure still doubles the wait (not retried every minute)', async () => {
    const w = world(); w.setAskAsking(40_000); holdDirectRoad(SETUP, w.env); await run(1); expect(w.asks()).toBe(1); // (made at 0; «asking» for 40 s, then nothing)
    await run(125_000); expect(w.asks(), 'a second making at 60 s, and the third only after the doubled wait (not at 120 s)').toBe(2);
  });

  it('computers coming to the front together do not spend the Mac\'s minute: at most DIRECT_KEEP_OPENS_PER_MINUTE makings in any minute, the rest follow', async () => {
    const w = world(); w.setAskWorks(false); for (let i = 0; i < 6; i++) holdDirectRoad(`bbbbbbbb-cccc-4ddd-8eee-0000000000${String(i).padStart(2, '0')}`, w.env);
    await run(59_000); expect(w.asks()).toBe(DIRECT_KEEP_OPENS_PER_MINUTE); await run(2_000); expect(w.asks()).toBeLessThanOrEqual(DIRECT_KEEP_OPENS_PER_MINUTE * 2); expect(w.asks()).toBeGreaterThan(DIRECT_KEEP_OPENS_PER_MINUTE);
  });
});

describe('[4993 ⓐ] codex round 3 of the web PR: a close that outlives its keeper · a screen straight back · the reset', () => {
  it('the LAST screen leaves, the close is on its way (3 s), the keeper is gone — a screen of the same computer that mounts meanwhile waits for that close: the road it makes is the one that stays', async () => {
    const w = world(); w.setCloseDelay(3_000); const release = holdDirectRoad(SETUP, w.env); await run(1); release(); await run(DIRECT_KEEP_GRACE_MS); expect(w.closes()).toBe(1);
    const n = w.calls.length; holdDirectRoad(SETUP, w.env); await run(1_000); expect(w.calls.slice(n), 'nothing asked while the old close is on its way').toEqual([]);
    await run(2_100); expect(w.calls.slice(n).filter((c) => c === 'direct.keep' || c === 'direct.ask')).toEqual(['direct.keep', 'direct.ask']); expect(w.roadState()).toBe('ready'); expect(w.closes()).toBe(1);
    await run(DIRECT_KEEP_EVERY_MS * 3); expect(w.roadState()).toBe('ready');
  });

  it('a screen that comes straight back inside the grace looks AT ONCE (the loop was stopped when the last one left); a second screen while the loop runs adds no look', async () => {
    const w = world(); const r1 = holdDirectRoad(SETUP, w.env); await run(1); r1(); await run(DIRECT_KEEP_GRACE_MS / 2); const n = w.keepTimes.length;
    holdDirectRoad(SETUP, w.env); await run(1); expect(w.keepTimes.length, 'a look at once').toBe(n + 1); const m = w.keepTimes.length;
    holdDirectRoad(SETUP, w.env); await run(1); expect(w.keepTimes.length, 'a second screen while the loop runs: no extra look').toBe(m);
  });

  it('the reset forgets the page\'s note of the last road start too (a test\'s screen must not leave its 5 s suppression for the next)', () => {
    openFired.set(SETUP, Date.now()); expect(openFired.size).toBe(1); __resetDirectKeepForTest(); expect(openFired.size).toBe(0);
  });
});

describe('[4993 ⓐ] a screen that comes back while a look is running · no close without a road · a reset that leaves nothing', () => {
  it('a screen that comes back while a look is on its way: the look that follows is made as soon as the first ends (not 30 s later)', async () => {
    const w = world(); holdDirectRoad(SETUP, w.env); await run(1); w.setKeepDelay(3_000); // (the look at 30 s will take 3 s to be answered)
    await run(DIRECT_KEEP_EVERY_MS); expect(w.keepTimes).toEqual([0, 30_000]); w.setVisible(false); w.setVisible(true); // (hidden and back while it runs)
    await run(3_000); expect(w.keepTimes, 'the second look came right after the first ended (33 s), not at 60 s').toEqual([0, 30_000, 33_000]);
  });

  it('`direct.close` is sent only for a computer whose shell said `direct: 1` — not for `direct: 0`, an answer that was not ok, or no answer at all', async () => {
    for (const caps of [{ id: 'c', ok: true, caps: { direct: 0 } }, { id: 'c', ok: false, code: 'bad_request' }, 'never'] as (PhoneAnswer | 'never')[]) {
      const w = world(); w.setCaps(caps); const release = holdDirectRoad(SETUP, w.env); await run(DIRECT_KEEP_EVERY_MS); release(); await run(DIRECT_KEEP_GRACE_MS * 2); expect(w.calls, JSON.stringify(caps)).not.toContain('direct.close'); __resetDirectKeepForTest();
    }
  });

  it('after a reset nothing is left on a timer: no look · no close fires', async () => {
    const w = world(); const release = holdDirectRoad(SETUP, w.env); await run(1); release(); __resetDirectKeepForTest(); const n = w.calls.length; await run(DIRECT_KEEP_GRACE_MS * 3 + DIRECT_KEEP_EVERY_MS * 3); expect(w.calls.length).toBe(n);
  });
});

describe('[4993 ⓐ] hidden · leaving · coming back', () => {
  it('the screen goes hidden: no more asks; after the grace the road is closed once; coming back asks at once and makes the road again', async () => {
    const w = world(); holdDirectRoad(SETUP, w.env); await run(1);
    w.setVisible(false); const n = w.calls.length; await run(DIRECT_KEEP_GRACE_MS - 1); expect(w.closes()).toBe(0); await run(1); expect(w.closes()).toBe(1); expect(w.roadState()).toBe('idle');
    await run(5 * 60_000); expect(w.calls.slice(n).filter((c) => c === 'direct.keep' || c === 'direct.status' || c === 'direct.ask'), 'nothing asked while hidden').toEqual([]); expect(w.closes()).toBe(1);
    w.setVisible(true); await run(1); expect(w.asks()).toBe(2); expect(w.roadState()).toBe('ready');
  });

  it('hidden for less than the grace: nothing is closed (leaving and coming straight back is free)', async () => {
    const w = world(); holdDirectRoad(SETUP, w.env); await run(1); w.setVisible(false); await run(DIRECT_KEEP_GRACE_MS - 1_000); w.setVisible(true); await run(DIRECT_KEEP_EVERY_MS * 2);
    expect(w.closes()).toBe(0); expect(w.asks()).toBe(1); expect(w.roadState()).toBe('ready');
  });

  it('a page that is hidden from the start asks nothing at all, and asks as it comes to the front', async () => {
    const w = world(); w.setVisible(false); holdDirectRoad(SETUP, w.env); await run(DIRECT_KEEP_EVERY_MS * 3); expect(w.calls.filter((c) => c !== 'direct.close')).toEqual([]);
    w.setVisible(true); await run(1); expect(w.asks()).toBe(1);
  });

  it('two screens of the same computer share ONE keeper; one leaving keeps the road, the last leaving closes it after the grace; coming back inside the grace closes nothing', async () => {
    const w = world(); const a = holdDirectRoad(SETUP, w.env); const b = holdDirectRoad(SETUP, w.env); await run(1);
    expect(w.calls.filter((c) => c === 'shell.caps')).toHaveLength(1); expect(w.asks()).toBe(1);
    await run(DIRECT_KEEP_EVERY_MS); expect(w.calls.filter((c) => c === 'direct.keep')).toHaveLength(2); // (one ask per tick, not two)
    a(); a(); await run(DIRECT_KEEP_GRACE_MS * 3); expect(w.closes()).toBe(0); expect(w.roadState()).toBe('ready');
    b(); await run(DIRECT_KEEP_GRACE_MS - 1); const c = holdDirectRoad(SETUP, w.env); await run(DIRECT_KEEP_GRACE_MS * 2); expect(w.closes()).toBe(0); expect(w.roadState()).toBe('ready');
    c(); await run(DIRECT_KEEP_GRACE_MS); expect(w.closes()).toBe(1); expect(w.roadState()).toBe('idle');
  });
});

describe('[4993 ⓐ] shells that cannot, and answers that are not answers', () => {
  it('a shell without `direct_keep` (but with `direct`) is asked `direct.status`, never `direct.keep`; the road is made ONCE per coming to the front (it ends at its idle — never one road a minute)', async () => {
    const w = world(); w.setCaps({ id: 'c', ok: true, caps: { direct: 1 } }); holdDirectRoad(SETUP, w.env); await run(10 * 60_000);
    expect(w.calls).not.toContain('direct.keep'); expect(w.calls).toContain('direct.status'); expect(w.asks()).toBe(1);
    w.setVisible(false); await run(DIRECT_KEEP_GRACE_MS); w.setVisible(true); await run(1); expect(w.asks()).toBe(2);
  });

  it('a TRANSIENT refusal of `shell.caps` (page_hidden as the screen goes · a bridge that failed) is not an answer about the shell: it is asked again at the next look and the keeper works as soon as the shell answers', async () => {
    for (const code of ['page_hidden', 'failed', 'bridge_gone']) {
      const w = world(); w.setCaps({ id: 'c', ok: false, code }); holdDirectRoad(SETUP, w.env); await run(DIRECT_KEEP_EVERY_MS * 3); expect(new Set(w.calls), code).toEqual(new Set(['shell.caps'])); expect(w.calls.filter((c) => c === 'shell.caps').length, `${code}: asked again`).toBeGreaterThanOrEqual(3);
      w.setCaps({ id: 'c', ok: true, caps: { direct: 1, direct_keep: 1 } }); await run(DIRECT_KEEP_EVERY_MS * 2); expect(w.asks(), `${code}: works once the shell answers`).toBe(1); __resetDirectKeepForTest();
    }
  });

  it('a shell that does not say `direct: 1` (0 · absent · not ok), and a page with no answer from `shell.caps`: nothing but `shell.caps`; a late answer is picked up at the next look', async () => {
    for (const caps of [{ id: 'c', ok: true, caps: { direct: 0 } }, { id: 'c', ok: true, caps: {} }, { id: 'c', ok: false, code: 'bad_request' }] as PhoneAnswer[]) {
      const w = world(); w.setCaps(caps); holdDirectRoad(SETUP, w.env); await run(DIRECT_KEEP_EVERY_MS * 3); expect(new Set(w.calls), JSON.stringify(caps)).toEqual(new Set(['shell.caps'])); __resetDirectKeepForTest();
    }
    const w = world(); w.setCaps('never'); holdDirectRoad(SETUP, w.env); await run(DIRECT_KEEP_EVERY_MS + 6_000); expect(w.calls.filter((c) => c === 'shell.caps').length).toBeGreaterThanOrEqual(2); expect(w.asks()).toBe(0);
    w.setCaps({ id: 'c', ok: true, caps: { direct: 1, direct_keep: 1 } }); await run(DIRECT_KEEP_EVERY_MS * 2); expect(w.asks()).toBe(1);
  });

  it('the bridge\'s refusals and a state that is not «idle» open nothing: {ok:false} · page_hidden · asking · connecting · proving', async () => {
    for (const a of [{ id: 'k', ok: false, code: 'bad_request' }, { id: 'k', ok: false, code: 'page_hidden' }, { id: 'k', ok: false, code: 'failed', state: 'idle' }, { id: 'k', ok: 'x', state: 'idle' }, replyOf('direct.keep', { state: 'asking' }), replyOf('direct.keep', { state: 'connecting' }), replyOf('direct.keep', { state: 'proving' }), replyOf('direct.keep', { state: 'ready' })] as PhoneAnswer[]) {
      const w = world(); w.keepAnswer(a); holdDirectRoad(SETUP, w.env); await run(DIRECT_KEEP_EVERY_MS * 2); expect(w.asks(), JSON.stringify(a)).toBe(0); __resetDirectKeepForTest();
    }
  });

  it('the keeper reads only what the contract says: from a `direct.keep` · `direct.status` answer, properties of the contract reply (or the refusal words ok · code)', async () => {
    for (const caps of [{ id: 'c', ok: true, caps: { direct: 1, direct_keep: 1 } }, { id: 'c', ok: true, caps: { direct: 1 } }] as PhoneAnswer[]) {
      const w = world(); w.setCaps(caps); holdDirectRoad(SETUP, w.env); await run(DIRECT_KEEP_EVERY_MS * 2);
      for (const call of ['direct.keep', 'direct.status']) { const allowed = new Set(['id', 'then', ...Object.keys(contract.calls[call]!.reply), 'ok', 'code']); for (const k of w.reads[call]!) expect(allowed.has(k), `${call}: the keeper read «${k}»`).toBe(true); }
      expect(w.reads['direct.keep']!.size + w.reads['direct.status']!.size).toBeGreaterThan(0); __resetDirectKeepForTest();
    }
  });

  it('a look that THROWS (a bridge that fails) is not the end: the next look asks again', async () => {
    const w = world(); const real = w.env.phoneCall; let first = true;
    w.env.phoneCall = vi.fn((type: string, args: Record<string, unknown>) => { if (type === 'direct.keep' && first) { first = false; throw new Error('bridge gone'); } return real(type, args); });
    holdDirectRoad(SETUP, w.env); await run(1); expect(w.asks()).toBe(0); await run(DIRECT_KEEP_EVERY_MS); expect(w.asks()).toBe(1);
  });
});
