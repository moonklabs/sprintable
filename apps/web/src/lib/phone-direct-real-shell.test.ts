// story 4993 (found by the PR 6 wheel, 11-23 19:06Z) — the web must read the shell's REAL answers, and the doubles in a test must be BUILT FROM THE CONTRACT, never written by hand.
// Three of the shell's direct answers carry NO `ok` field (contracts/direct-bridge.json: `direct.status` → {state} · `direct.send` → {sent, why?} · `direct.result` → {state, code?, got?, of?}); the page gets them as `{id, ...result}` (mobile lib/phoneBridge.js buildReplyInjection).
// The web asked for `ok === true` on all three, so on the real shell the road was never opened (status idle → no `direct.ask`), no press was ever «sent» over it and a result was never followed — while every hand-written mock carried an `ok:true` the real shell never sends.
// Here: (1) a double that can only say what the contract says (`replyOf` refuses a field the contract does not list for that call), (2) every property the web READS from an answer is traced and must be a contract field (or the bridge's refusal word `ok`/`code`) — a judgment that reads a field the
// contract does not have goes RED, (3) the flows run on those answers. The bridge's own refusals (`ok:false`) stay «no answer». Each check goes red without the line it names.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { followDirectResult, tryDirect } from './phone-direct';
import type { PhoneAnswer } from './phone-bridge';

const ROOT = path.resolve(__dirname, '../../../..');
const contract = JSON.parse(readFileSync(path.join(ROOT, 'contracts', 'direct-bridge.json'), 'utf8')) as { calls: Record<string, { reply: Record<string, unknown> }> };
const SETUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const KEY = 'press-key-0001';
const pending = { verb: 'stop', key: KEY, body: { kind: 'stop_session', session_key: 's-9', signed: 'SIGNED', phone_key_id: 'k-1' } };
// the bridge's own refusal envelope (mobile lib/phoneCalls.js `err(code)` = {ok:false, code} · the page's `page_hidden`): the one thing outside a call's own reply the web may read — to tell «refused» from «answered»
const REFUSAL_KEYS = ['ok', 'code'];

/** the answer of `call` as the page receives it: `{id, ...values}` — and only fields the contract lists for that call */
function replyOf(call: string, values: Record<string, unknown>): PhoneAnswer {
  const spec = contract.calls[call]; expect(spec, `the contract has the call ${call}`).toBeTruthy();
  for (const k of Object.keys(values)) expect(Object.keys(spec!.reply), `the contract lists «${k}» in the reply of ${call}`).toContain(k);
  return { id: `id-${call}`, ...values } as unknown as PhoneAnswer;
}
/** wrap an answer so every property read is noted */
function traced(a: PhoneAnswer, reads: Set<string>): PhoneAnswer { return new Proxy(a, { get(t, k, r) { if (typeof k === 'string') reads.add(k); return Reflect.get(t, k, r); }, has(t, k) { if (typeof k === 'string') reads.add(k); return Reflect.has(t, k); } }); }

const CAPS: PhoneAnswer = { id: 'c', ok: true, caps: { direct: 1 } }; // (shell.caps is not a direct.* call: it does carry ok)
type Over = { status?: PhoneAnswer; send?: PhoneAnswer; results?: PhoneAnswer[] };
function shell(over: Over = {}) {
  const log: string[] = []; const reads: Record<string, Set<string>> = { 'direct.status': new Set(), 'direct.send': new Set(), 'direct.result': new Set() }; const results = [...(over.results ?? [])];
  const phoneCall = vi.fn((type: string): Promise<PhoneAnswer> => {
    log.push(type);
    if (type === 'shell.caps') return Promise.resolve(CAPS);
    if (type === 'direct.status') return Promise.resolve(traced(over.status ?? replyOf('direct.status', { state: 'idle' }), reads['direct.status']!));
    if (type === 'direct.send') return Promise.resolve(traced(over.send ?? replyOf('direct.send', { sent: true }), reads['direct.send']!));
    if (type === 'direct.result') return Promise.resolve(traced(results.shift() ?? replyOf('direct.result', { state: 'unknown' }), reads['direct.result']!));
    if (type === 'direct.ask') return Promise.resolve({ id: 'a', ok: false, code: 'no_road' }); // (the negotiation itself ends here: it is not what is judged)
    return Promise.resolve({ id: 'z', ok: false });
  });
  return { phoneCall, log, reads };
}
const deps = (s: ReturnType<typeof shell>) => ({ phoneCall: s.phoneCall, openFired: new Map<string, number>() });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// (`then`: every promise resolution looks for a thenable — the platform reads it, not the web's judgment)
const allowed = (call: string) => new Set<string>(['id', 'then', ...Object.keys(contract.calls[call]!.reply), ...REFUSAL_KEYS]);

describe('[4993] the contract: these three answers have no `ok`', () => {
  it('direct.status · direct.send · direct.result replies in contracts/direct-bridge.json carry no `ok` (the premise of this file)', () => {
    for (const k of ['direct.status', 'direct.send', 'direct.result']) expect(Object.keys(contract.calls[k]!.reply), k).not.toContain('ok');
  });
  it('the double cannot say what the contract does not: a field that is not in the reply of the call is refused at once', () => {
    expect(() => replyOf('direct.status', { state: 'idle' })).not.toThrow();
    expect(() => replyOf('direct.status', { ok: true, state: 'idle' })).toThrow();
    expect(() => replyOf('direct.send', { ok: true, sent: true })).toThrow();
  });
});

describe('[4993] tryDirect against the real shell answers', () => {
  it('status {state:"idle"} (no ok) → the road IS opened behind the press (direct.ask is asked), the press goes by the server', async () => {
    const s = shell(); expect(await tryDirect(SETUP, pending, deps(s))).toBe('not_sent'); await wait(20);
    expect(s.log).toEqual(['shell.caps', 'direct.status', 'direct.ask']);
  });

  it('status {state:"ready"} + send {sent:true} (no ok) → the press is SENT over the road', async () => {
    const s = shell({ status: replyOf('direct.status', { state: 'ready' }) }); expect(await tryDirect(SETUP, pending, deps(s))).toBe('sent');
    expect(s.log).toEqual(['shell.caps', 'direct.status', 'direct.send']);
  });

  it('send {sent:false, why:"ack" | "closed" | "protocol"} (no ok) → «missed» (it may have arrived: followed, never posted) · another word → not_sent', async () => {
    for (const why of ['ack', 'closed', 'protocol']) { const s = shell({ status: replyOf('direct.status', { state: 'ready' }), send: replyOf('direct.send', { sent: false, why }) }); expect(await tryDirect(SETUP, pending, deps(s)), why).toBe('missed'); }
    const s = shell({ status: replyOf('direct.status', { state: 'ready' }), send: replyOf('direct.send', { sent: false, why: 'no_road' }) }); expect(await tryDirect(SETUP, pending, deps(s))).toBe('not_sent');
  });

  it('a state that is not «ready» or «idle» (asking · connecting · proving) opens nothing and sends nothing', async () => {
    for (const state of ['asking', 'connecting', 'proving']) { const s = shell({ status: replyOf('direct.status', { state }) }); expect(await tryDirect(SETUP, pending, deps(s)), state).toBe('not_sent'); await wait(10); expect(s.log, state).toEqual(['shell.caps', 'direct.status']); }
  });

  it('the bridge\'s own refusals stay «no answer»: status {ok:false, code} (bad_request · page_hidden · failed) → no road · send {ok:false} → not_sent, even when the refusal carries words of an answer', async () => {
    for (const status of [{ id: 's', ok: false, code: 'bad_request' }, { id: 's', ok: false, code: 'page_hidden' }, { id: 's', ok: false, code: 'failed', state: 'idle' }, { id: 's', ok: false, code: 'failed', state: 'ready' }] as PhoneAnswer[]) { const s = shell({ status }); expect(await tryDirect(SETUP, pending, deps(s))).toBe('not_sent'); await wait(10); expect(s.log, JSON.stringify(status)).toEqual(['shell.caps', 'direct.status']); }
    const s = shell({ status: replyOf('direct.status', { state: 'ready' }), send: { id: 'x', ok: false, code: 'bad_request' } }); expect(await tryDirect(SETUP, pending, deps(s))).toBe('not_sent');
    const s2 = shell({ status: replyOf('direct.status', { state: 'ready' }), send: { id: 'x', ok: false, sent: true, why: 'x' } as unknown as PhoneAnswer }); expect(await tryDirect(SETUP, pending, deps(s2)), 'a refusal that carries a «sent» is not a send').toBe('not_sent');
    const s3 = shell({ status: replyOf('direct.status', { state: 'ready' }), send: { id: 'x', ok: false, sent: false, why: 'ack' } as unknown as PhoneAnswer }); expect(await tryDirect(SETUP, pending, deps(s3)), 'a refusal that carries a «may have arrived» word is not «missed»').toBe('not_sent');
  });

  it('an `ok` that is no boolean ("x" · 1 · null · "false") is not an answer either — no road, no «sent», no «missed»', async () => {
    for (const ok of ['x', 1, null, 'false', 0]) {
      const s1 = shell({ status: { id: 's', ok, state: 'idle' } as unknown as PhoneAnswer }); expect(await tryDirect(SETUP, pending, deps(s1))).toBe('not_sent'); await wait(10); expect(s1.log, `status ok=${String(ok)}`).toEqual(['shell.caps', 'direct.status']);
      const s2 = shell({ status: replyOf('direct.status', { state: 'ready' }), send: { id: 'x', ok, sent: true } as unknown as PhoneAnswer }); expect(await tryDirect(SETUP, pending, deps(s2)), `send ok=${String(ok)}`).toBe('not_sent');
      const s3 = shell({ status: replyOf('direct.status', { state: 'ready' }), send: { id: 'x', ok, sent: false, why: 'ack' } as unknown as PhoneAnswer }); expect(await tryDirect(SETUP, pending, deps(s3)), `missed ok=${String(ok)}`).toBe('not_sent');
      const s4 = shell({ results: [{ id: 'r', ok, state: 'done', code: 'ok' } as unknown as PhoneAnswer, replyOf('direct.result', { state: 'unknown' })] });
      expect(await followDirectResult<string>(SETUP, KEY, { phoneCall: s4.phoneCall, wait: () => Promise.resolve(), pollMs: 1, pollMaxMs: 2_000, decide: (r) => r.state, unknown: () => 'unknown' }), `result ok=${String(ok)}`).toBe('unknown');
    }
  });

  it('a LATE status (after the box) of the real shape opens the road too', async () => {
    const log: string[] = []; const phoneCall = vi.fn((type: string): Promise<PhoneAnswer> => { log.push(type); if (type === 'shell.caps') return Promise.resolve(CAPS); if (type === 'direct.status') return new Promise((r) => setTimeout(() => r(replyOf('direct.status', { state: 'idle' })), 60)); return Promise.resolve({ id: 'a', ok: false, code: 'no_road' }); });
    expect(await tryDirect(SETUP, pending, { phoneCall, budget: { probe: 20 }, openFired: new Map<string, number>() })).toBe('not_sent'); await wait(150);
    expect(log).toEqual(['shell.caps', 'direct.status', 'direct.ask']);
  });
});

describe('[4993] followDirectResult against the real shell answers', () => {
  const run = (s: ReturnType<typeof shell>) => followDirectResult<string>(SETUP, KEY, { phoneCall: s.phoneCall, wait: () => Promise.resolve(), pollMs: 1, pollMaxMs: 2_000, decide: (r) => `${r.state}:${r.code}`, unknown: () => 'unknown' });

  it('pending {state:"pending"} then done {state:"done", code:"ok"} (no ok) → the outcome is read', async () => {
    const s = shell({ results: [replyOf('direct.result', { state: 'pending' }), replyOf('direct.result', { state: 'done', code: 'ok' })] }); expect(await run(s)).toBe('done:ok'); expect(s.log.filter((l) => l === 'direct.result')).toHaveLength(2);
  });

  it('failed / rejected words come through with their code', async () => {
    expect(await run(shell({ results: [replyOf('direct.result', { state: 'rejected', code: 'envelope_replay' })] }))).toBe('rejected:envelope_replay');
    expect(await run(shell({ results: [replyOf('direct.result', { state: 'failed', code: 'no_such_file' })] }))).toBe('failed:no_such_file');
  });

  it('pending {state:"pending", got, of} (no ok) → the count reaches onPending (5896) · a pending without the numbers draws nothing', async () => {
    const seen: { got: number; of: number }[] = [];
    const s = shell({ results: [replyOf('direct.result', { state: 'pending' }), replyOf('direct.result', { state: 'pending', got: 2, of: 5 }), replyOf('direct.result', { state: 'done', code: 'ok' })] });
    expect(await followDirectResult<string>(SETUP, KEY, { phoneCall: s.phoneCall, wait: () => Promise.resolve(), pollMs: 1, pollMaxMs: 2_000, decide: (r) => r.state, unknown: () => 'u', onPending: (p) => seen.push(p) })).toBe('done');
    expect(seen).toEqual([{ got: 2, of: 5 }]);
  });

  it('{state:"unknown"} is the shell\'s own «none» → unknown() at once (one ask)', async () => {
    const s = shell({ results: [replyOf('direct.result', { state: 'unknown' })] }); expect(await run(s)).toBe('unknown'); expect(s.log.filter((l) => l === 'direct.result')).toHaveLength(1);
  });

  it('a refused ask ({ok:false}) is not an end: it is asked again (the next real word is read) — even a refusal that carries an end word', async () => {
    const s = shell({ results: [{ id: 'r', ok: false, code: 'page_hidden' } as PhoneAnswer, { id: 'r', ok: false, code: 'bad_request', state: 'done' } as unknown as PhoneAnswer, replyOf('direct.result', { state: 'done', code: 'ok' })] });
    expect(await run(s)).toBe('done:ok'); expect(s.log.filter((l) => l === 'direct.result')).toHaveLength(3);
  });
});

describe('[4993] the web reads only what the contract says (a field the contract does not have, read by a judgment, is RED)', () => {
  it('every property read from a direct.status · direct.send · direct.result answer in the flows above is a field of that call\'s contract reply (or the refusal words ok · code)', async () => {
    const flows: [string, () => Promise<unknown>, ReturnType<typeof shell>][] = [];
    const a = shell(); flows.push(['direct.status', () => tryDirect(SETUP, pending, deps(a)), a]);
    const b = shell({ status: replyOf('direct.status', { state: 'ready' }), send: replyOf('direct.send', { sent: false, why: 'ack' }) }); flows.push(['direct.send', () => tryDirect(SETUP, pending, deps(b)), b]);
    const c = shell({ results: [replyOf('direct.result', { state: 'pending', got: 1, of: 3 }), replyOf('direct.result', { state: 'done', code: 'ok' })] }); flows.push(['direct.result', () => followDirectResult<string>(SETUP, KEY, { phoneCall: c.phoneCall, wait: () => Promise.resolve(), pollMs: 1, pollMaxMs: 2_000, decide: (r) => r.state, unknown: () => 'u', onPending: () => undefined }), c]);
    for (const [call, go, s] of flows) { await go(); await wait(20); const ok = allowed(call); const got = s.reads[call]!; for (const k of got) expect(ok.has(k), `${call}: the web read «${k}», which the contract does not list`).toBe(true); expect(got.size, `${call}: something was read`).toBeGreaterThan(0); }
  });
});
