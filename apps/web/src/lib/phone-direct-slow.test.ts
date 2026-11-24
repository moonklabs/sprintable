// story 4993 (found by the PR 6 wheel) — a SLOW shell must not keep the direct road from ever being made.
// `tryDirect` asks the shell two local questions (`shell.caps` · `direct.status`) inside ONE small box (DIRECT_PROBE_BUDGET_MS, 1 s) so a press never waits for a road. When the box was spent, the press went to the server — right — but the road was NOT opened
// behind it either (the open sat after both answers, inside the box): a phone whose shell answers in 1.2 s (just woken · busy · a slow device) would send every press by the server for ever. The box is for SENDING; opening the road is not bound by it.
// Each check goes red without the line it names.
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_LATE_OPEN_MAX_MS, DIRECT_OPEN_AGAIN_MS, tryDirect } from './phone-direct';
import type { PhoneAnswer } from './phone-bridge';

const SETUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const KEY = 'press-key-0001';
const pending = { verb: 'stop', key: KEY, body: { kind: 'stop_session', session_key: 's-9', signed: 'SIGNED', phone_key_id: 'k-1' } };
const BOX = 25; // (a small box so the tests do not wait: the real one is 1 s)
const after = (ms: number, a: PhoneAnswer): Promise<PhoneAnswer> => new Promise((r) => setTimeout(() => r(a), ms));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const CAPS: PhoneAnswer = { id: 'c', ok: true, caps: { direct: 1 } };
const IDLE: PhoneAnswer = { id: 's', ok: true, state: 'idle' };

/** a shell whose two local answers each take `capsMs` / `statusMs`; every call is recorded in order */
function shell(capsMs: number, statusMs: number, over: { caps?: PhoneAnswer; status?: PhoneAnswer } = {}) {
  const log: string[] = [];
  const phoneCall = vi.fn((type: string): Promise<PhoneAnswer> => {
    log.push(type);
    if (type === 'shell.caps') return after(capsMs, over.caps ?? CAPS);
    if (type === 'direct.status') return after(statusMs, over.status ?? IDLE);
    if (type === 'direct.ask') return Promise.resolve({ id: 'a', ok: false, code: 'no_road' }); // (the negotiation itself ends here: it is not what is judged)
    return Promise.resolve({ id: 'x', ok: false });
  });
  return { phoneCall, log };
}
const deps = (s: ReturnType<typeof shell>, over: Record<string, unknown> = {}) => ({ phoneCall: s.phoneCall, budget: { probe: BOX }, openFired: new Map<string, number>(), ...over });

describe('[4993] a slow shell does not keep the road from being made', () => {
  it('a fast shell (both answers inside the box): idle → the road is opened behind the press, the press goes by the server (as before)', async () => {
    const s = shell(1, 1); const out = await tryDirect(SETUP, pending, deps(s));
    expect(out).toBe('not_sent'); await wait(30); expect(s.log).toEqual(['shell.caps', 'direct.status', 'direct.ask']);
  });

  it('`shell.caps` answers AFTER the box: the press still goes by the server at once (not_sent, never waited for) — and the road is opened as soon as the late answer says direct:1 and the road is idle', async () => {
    const s = shell(BOX * 3, 1); const t0 = Date.now(); const out = await tryDirect(SETUP, pending, deps(s));
    expect(out).toBe('not_sent'); expect(Date.now() - t0).toBeLessThan(BOX * 3 - 5); // (the press did not wait for the slow answer)
    await wait(BOX * 5); expect(s.log).toEqual(['shell.caps', 'direct.status', 'direct.ask']);
  });

  it('`shell.caps` in time but the box is spent before `direct.status` is asked: the road is still opened (status asked late, idle → open)', async () => {
    const s = shell(BOX + 10, 1); const out = await tryDirect(SETUP, pending, deps(s, { budget: { probe: BOX + 5 } }));
    expect(out).toBe('not_sent'); await wait(BOX * 4); expect(s.log).toContain('direct.ask');
  });

  it('`direct.status` answers AFTER the box: not_sent at once, and the road is opened when the late answer says idle', async () => {
    const s = shell(1, BOX * 3); const out = await tryDirect(SETUP, pending, deps(s));
    expect(out).toBe('not_sent'); await wait(BOX * 5); expect(s.log).toEqual(['shell.caps', 'direct.status', 'direct.ask']);
  });

  it('a late answer is judged as the fast one is: direct:0 · a road that is ready or being made · a refused call → no road is opened', async () => {
    for (const over of [{ caps: { id: 'c', ok: true, caps: { direct: 0 } } as PhoneAnswer }, { caps: { id: 'c', ok: false, code: 'bad_request' } as PhoneAnswer }, { status: { id: 's', ok: true, state: 'ready' } as PhoneAnswer }, { status: { id: 's', ok: true, state: 'connecting' } as PhoneAnswer }, { status: { id: 's', ok: false } as PhoneAnswer }, { status: { id: 's', ok: false, state: 'idle' } as PhoneAnswer }]) { // (a refused call that still carries the word «idle» is not an idle road)
      const s = shell(BOX * 2, 1, over); await tryDirect(SETUP, pending, deps(s)); await wait(BOX * 5);
      expect(s.log, JSON.stringify(over)).not.toContain('direct.ask');
    }
  });

  it('a caps answer that came IN time and said direct:0 (or refused) is the end: the spent box afterwards asks nothing and opens nothing (the late path starts only from a caps that said direct:1)', async () => {
    for (const caps of [{ id: 'c', ok: true, caps: { direct: 0 } } as PhoneAnswer, { id: 'c', ok: false, code: 'bad_request' } as PhoneAnswer]) {
      const s = shell(BOX - 8, 1, { caps }); await tryDirect(SETUP, pending, deps(s)); await wait(BOX * 4);
      expect(s.log, JSON.stringify(caps)).toEqual(['shell.caps']);
    }
  });

  it('a shell that never answers opens nothing (the late wait has its own end) and the press is not held', async () => {
    const never = vi.fn((): Promise<PhoneAnswer> => new Promise(() => {})); const t0 = Date.now();
    expect(await tryDirect(SETUP, pending, { phoneCall: never, budget: { probe: BOX }, openFired: new Map<string, number>() })).toBe('not_sent');
    expect(Date.now() - t0).toBeLessThan(BOX * 4); expect(never).toHaveBeenCalledTimes(1);
  });

  it('after its own end (10 s) a late open leaves NOTHING behind: no timer, no road, whether the shell never answered caps · never answered status — and a shell that answers after the end opens nothing', async () => {
    vi.useFakeTimers(); try {
      const never = vi.fn((): Promise<PhoneAnswer> => new Promise(() => {}));
      const p1 = tryDirect(SETUP, pending, { phoneCall: never, budget: { probe: BOX }, openFired: new Map<string, number>() }); await vi.advanceTimersByTimeAsync(BOX + 5); await p1; await vi.advanceTimersByTimeAsync(DIRECT_LATE_OPEN_MAX_MS + 100);
      expect(vi.getTimerCount(), 'no caps answer').toBe(0); expect(never).toHaveBeenCalledTimes(1);
      const log: string[] = []; const noStatus = vi.fn((type: string): Promise<PhoneAnswer> => { log.push(type); return type === 'shell.caps' ? Promise.resolve(CAPS) : new Promise(() => {}); });
      const p2 = tryDirect(SETUP, pending, { phoneCall: noStatus, budget: { probe: BOX }, openFired: new Map<string, number>() }); await vi.advanceTimersByTimeAsync(BOX + 5); await p2; await vi.advanceTimersByTimeAsync(DIRECT_LATE_OPEN_MAX_MS + 100);
      expect(vi.getTimerCount(), 'no status answer').toBe(0); expect(log).toEqual(['shell.caps', 'direct.status']);
      const lateAfterEnd: string[] = []; const slow = vi.fn((type: string): Promise<PhoneAnswer> => { lateAfterEnd.push(type); return type === 'shell.caps' ? new Promise((r) => setTimeout(() => r(CAPS), DIRECT_LATE_OPEN_MAX_MS + 500)) : Promise.resolve(IDLE); });
      const p3 = tryDirect(SETUP, pending, { phoneCall: slow, budget: { probe: BOX }, openFired: new Map<string, number>() }); await vi.advanceTimersByTimeAsync(BOX + 5); await p3; await vi.advanceTimersByTimeAsync(DIRECT_LATE_OPEN_MAX_MS + 1_000);
      expect(lateAfterEnd, 'an answer after the end opens nothing').toEqual(['shell.caps']); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('two presses together open ONE road (the same «opened lately» note as the fast path), late or not', async () => {
    const s = shell(BOX * 2, 1); const d = deps(s);
    await Promise.all([tryDirect(SETUP, pending, d), tryDirect(SETUP, { ...pending, key: 'press-key-0002' }, d)]);
    await wait(BOX * 6); expect(s.log.filter((l) => l === 'direct.ask')).toHaveLength(1); expect(d.openFired.get(SETUP)).toBeTypeOf('number'); expect(DIRECT_OPEN_AGAIN_MS).toBeGreaterThan(0);
  });
});
