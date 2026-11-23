// story 4993 (5b-2) — an ANSWER to an agent's permission request goes over the same-network direct road FIRST and to the server when it does not; the computer's word reads as the card's line the server's answer gives (the same screen);
// a press never waits for a road to be made; a second answer is the computer's own «already answered».
import { describe, expect, it, vi } from 'vitest';
import { answerOnPhone, type DirectAnswer } from './phone-answer';
import type { PhoneAnswer } from './phone-bridge';

let serverCalls: Array<{ url: string; init?: RequestInit }> = [];
let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => { serverCalls.push({ url, init }); return currentFetch(url, init); } }));
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const reset = () => { serverCalls = []; currentFetch = async () => { throw new Error('the server must not be called'); }; };
const posts = () => serverCalls.filter((c) => c.init?.method === 'POST');

let n = 0; const freshSetup = () => `0f0e0d0c-0b0a-4908-8706-${String(++n).padStart(12, '0')}`;
type Handler = PhoneAnswer | ((args: Record<string, unknown>) => PhoneAnswer | Promise<PhoneAnswer>);
function shell(map: Record<string, Handler>) {
  const log: Array<{ type: string; args: Record<string, unknown> }> = [];
  const phoneCall = vi.fn(async (type: string, args: Record<string, unknown>) => { log.push({ type, args }); const h = map[type]; if (h === undefined) throw new Error(`no handler: ${type}`); return typeof h === 'function' ? h(args) : h; });
  return { phoneCall, log, count: (t: string) => log.filter((l) => l.type === t).length };
}
const CAPS: PhoneAnswer = { id: 'c', ok: true, caps: { direct: 1 } };
const SIGNED: PhoneAnswer = { id: 'w', ok: true, signed: 'SIGNED-A', phone_key_id: 'k-1' };
const READY: PhoneAnswer = { id: 's', ok: true, state: 'ready' };
const direct = (result: Handler, extra: Record<string, Handler> = {}) => ({ 'approval.sign': SIGNED, 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': { id: 'x', ok: true, sent: true }, 'direct.result': result, ...extra });
const where = (setupId: string, over: Partial<DirectAnswer> = {}): DirectAnswer => ({ setupId, sessionKey: 's-9', requestId: '99999999-aaaa-4bbb-8ccc-dddddddddddd', ...over });
const deps = (phoneCall: Parameters<typeof answerOnPhone>[2]['phoneCall']) => ({ phoneCall, newKey: () => 'answer-key-0001', wait: async () => {}, pollMs: 1 });

describe('[4993 5b-2] an answer over the direct road', () => {
  it('signed on the shell, sent over the road as a row the contract says, its word read from the shell — the server is never called', async () => {
    reset(); const setup = freshSetup(); const s = shell(direct({ id: 'r', ok: true, state: 'done' }));
    await expect(answerOnPhone('r-1', 'allow', deps(s.phoneCall), { direct: where(setup) })).resolves.toEqual({ kind: 'answered', decision: 'allow' });
    expect(serverCalls).toEqual([]);
    expect(s.log.filter((l) => l.type === 'direct.status' || l.type === 'direct.send').map((l) => l.args.setup_id)).toEqual([setup, setup]); // (the road of THIS computer)
    const row = s.log.find((l) => l.type === 'direct.send')!.args.row as Record<string, unknown>;
    expect(row).toMatchObject({ command_id: 'answer-key-0001', kind: 'answer_approval', session_key: 's-9', payload: { session_key: 's-9', request_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd', decision: 'allow', signed: 'SIGNED-A' } });
    expect(Object.keys(row.payload as object)).toEqual(['session_key', 'request_id', 'decision', 'signed']);
  });
  it('the second answer of the network question carries its stage and the host the person saw', async () => {
    reset(); const s = shell(direct({ id: 'r', ok: true, state: 'done' }));
    await answerOnPhone('r-1', 'allow', deps(s.phoneCall), { direct: where(freshSetup(), { stage: 'confirm', host: 'gitlab.com' }) });
    expect((s.log.find((l) => l.type === 'direct.send')!.args.row as { payload: unknown }).payload).toEqual({ session_key: 's-9', request_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd', decision: 'allow', signed: 'SIGNED-A', stage: 'confirm', host: 'gitlab.com' });
    reset(); const t = shell(direct({ id: 'r', ok: true, state: 'done' }));
    await answerOnPhone('r-1', 'allow', deps(t.phoneCall), { direct: where(freshSetup(), { stage: 'ask', host: 'gitlab.com' }) });
    expect((t.log.find((l) => l.type === 'direct.send')!.args.row as { payload: Record<string, unknown> }).payload).not.toHaveProperty('host'); // (a first-stage answer never carries a host)
  });
  it('a confirm with no host is no row: it goes the server\'s way (nothing is made up)', async () => {
    reset(); currentFetch = async () => json(200, { ok: true }); const s = shell(direct({ id: 'r', ok: true, state: 'done' }));
    await expect(answerOnPhone('r-1', 'allow', deps(s.phoneCall), { direct: where(freshSetup(), { stage: 'confirm', host: null }) })).resolves.toEqual({ kind: 'answered', decision: 'allow' });
    expect(s.count('direct.send')).toBe(0); expect(posts().length).toBe(1);
  });
  it('THE SAME SCREEN: «already answered» by the computer is the server\'s answered_by (no name · no decision) — and every other word reads as the card reads it', async () => {
    const cases: Array<[string, string | null, unknown]> = [
      ['done', null, { kind: 'answered', decision: 'allow' }], ['rejected', 'already_answered', { kind: 'answered_by', name: null, decision: null }], ['rejected', 'unknown_request', { kind: 'closed' }],
      ['rejected', 'answer_expired', { kind: 'expired' }], ['failed', 'answer_expired', { kind: 'expired' }], ['rejected', 'expired', { kind: 'expired' }], ['rejected', 'remote_control_off', { kind: 'closed' }],
      ['rejected', 'bad_signature', { kind: 'failed' }], ['rejected', 'mismatch', { kind: 'failed' }], ['rejected', 'reused', { kind: 'failed' }], ['rejected', 'terminal_only', { kind: 'failed' }], ['failed', 'error', { kind: 'failed' }],
    ];
    for (const [state, code, expected] of cases) { reset(); const s = shell(direct({ id: 'r', ok: true, state, ...(code ? { code } : {}) })); await expect(answerOnPhone('r-1', 'allow', deps(s.phoneCall), { direct: where(freshSetup()) }), `${state} ${code}`).resolves.toEqual(expected); expect(serverCalls).toEqual([]); }
    // …and the SERVER's own «already answered» (409 already_answered with a name) is the same kind of line
    reset(); currentFetch = async () => json(409, { error: { code: 'already_answered', detail: { answered_by_name: null, decision: null } } });
    await expect(answerOnPhone('r-1', 'allow', deps(shell({ 'approval.sign': SIGNED, 'shell.caps': { id: 'c', ok: true, caps: {} } }).phoneCall), { direct: where(freshSetup()) })).resolves.toEqual({ kind: 'answered_by', name: null, decision: null });
  });
  it('NO ROAD YET: the answer reaches the server\'s POST in the same breath (no fake clock moved) — and the road is opened behind it', async () => {
    vi.useFakeTimers();
    try {
      reset(); currentFetch = async () => json(200, { ok: true }); const setup = freshSetup();
      const s = shell({ 'approval.sign': SIGNED, 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'idle' }, 'direct.open': new Promise<PhoneAnswer>(() => {}) as unknown as PhoneAnswer });
      await expect(answerOnPhone('r-1', 'allow', deps(s.phoneCall), { direct: where(setup) })).resolves.toEqual({ kind: 'answered', decision: 'allow' });
      expect(posts().length).toBe(1); expect(s.count('direct.open')).toBe(1); expect(s.count('direct.send')).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('a shell without the road, a road being made, a refusal of the send: the server\'s way — the signature is made once', async () => {
    for (const map of [{ 'shell.caps': { id: 'c', ok: true, caps: {} } }, { 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'connecting' } }, direct({ id: 'r', ok: true, state: 'done' }, { 'direct.send': { id: 'x', ok: true, sent: false, why: 'busy' } })] as Array<Record<string, Handler>>) {
      reset(); currentFetch = async () => json(200, { ok: true }); const s = shell({ 'approval.sign': SIGNED, ...map });
      await expect(answerOnPhone('r-1', 'allow', deps(s.phoneCall), { direct: where(freshSetup()) })).resolves.toEqual({ kind: 'answered', decision: 'allow' }); expect(posts().length).toBe(1); expect(s.count('approval.sign')).toBe(1);
    }
  });
  it('a send the shell never answers is «maybe»: followed over the road and NEVER posted (a second answer would be refused as already answered)', async () => {
    vi.useFakeTimers();
    try {
      reset(); const s = shell(direct({ id: 'r', ok: true, state: 'done' }, { 'direct.send': () => new Promise<PhoneAnswer>(() => {}) }));
      const out = answerOnPhone('r-1', 'allow', deps(s.phoneCall), { direct: where(freshSetup()) }); await vi.advanceTimersByTimeAsync(10_001);
      await expect(out).resolves.toEqual({ kind: 'answered', decision: 'allow' }); expect(serverCalls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it('MISSED (the frame may have reached the computer): the server\'s way — the person\'s answer is not lost', async () => {
    reset(); currentFetch = async () => json(200, { ok: true });
    const s = shell(direct({ id: 'r', ok: true, state: 'done' }, { 'direct.send': { id: 'x', ok: true, sent: false, why: 'ack' } }));
    await expect(answerOnPhone('r-1', 'allow', deps(s.phoneCall), { direct: where(freshSetup()) })).resolves.toEqual({ kind: 'answered', decision: 'allow' }); expect(posts().length).toBe(1);
  });
  it('the computer never says its word: the end of the window is «failed» (the request is left as it was — the card\'s own read settles it), and the server is never posted', async () => {
    reset(); const s = shell(direct({ id: 'r', ok: true, state: 'pending' }));
    await expect(answerOnPhone('r-1', 'allow', { ...deps(s.phoneCall), pollMaxMs: 20 }, { direct: where(freshSetup()) })).resolves.toEqual({ kind: 'failed' }); expect(serverCalls).toEqual([]);
    reset(); await expect(answerOnPhone('r-1', 'allow', deps(shell(direct({ id: 'r', ok: true, state: 'unknown' })).phoneCall), { direct: where(freshSetup()) })).resolves.toEqual({ kind: 'failed' }); expect(serverCalls).toEqual([]);
  });
  it('a sealed card: the decision the shell SAYS it signed is the one that goes over the road (never the pressed stand-in)', async () => {
    reset(); const s = shell(direct({ id: 'r', ok: true, state: 'done' }, { 'approval.sign': { ...SIGNED, decision: 'deny' } }));
    await expect(answerOnPhone('r-1', 'allow', deps(s.phoneCall), { sealed: true, direct: where(freshSetup()) })).resolves.toEqual({ kind: 'answered', decision: 'deny' });
    expect((s.log.find((l) => l.type === 'direct.send')!.args.row as { payload: { decision: string } }).payload.decision).toBe('deny');
  });
  it('without the request\'s own values (no session: a terminal-only question · an older server) nothing is tried — the server\'s way as before', async () => {
    reset(); currentFetch = async () => json(200, { ok: true }); const s = shell(direct({ id: 'r', ok: true, state: 'done' }));
    await expect(answerOnPhone('r-1', 'allow', deps(s.phoneCall))).resolves.toEqual({ kind: 'answered', decision: 'allow' }); expect(s.count('shell.caps')).toBe(0); expect(posts().length).toBe(1);
  });
  it('a refusal of the signing itself (the person said no on the OS prompt) goes nowhere — neither road', async () => {
    reset(); const s = shell({ 'approval.sign': { id: 'w', ok: false, code: 'cancelled' } });
    await expect(answerOnPhone('r-1', 'allow', deps(s.phoneCall), { direct: where(freshSetup()) })).resolves.toEqual({ kind: 'cancelled' }); expect(serverCalls).toEqual([]); expect(s.count('shell.caps')).toBe(0);
  });
});

describe('[4993 5b-2] the first ask of the computer\'s word is soon, not a whole poll away', () => {
  it('the word that is already there is read 200 ms after the send, and the next asks keep the flow\'s own pace (1.5 s)', async () => {
    vi.useFakeTimers();
    try {
      reset(); let asks = 0; const times: number[] = []; const t0 = Date.now();
      const s = shell(direct(() => { asks += 1; times.push(Date.now() - t0); return asks < 3 ? { id: 'r', ok: true, state: 'pending' } : { id: 'r', ok: true, state: 'done' }; }));
      const out = answerOnPhone('r-1', 'allow', { phoneCall: s.phoneCall, newKey: () => 'answer-key-0001' }, { direct: where(freshSetup()) });
      await vi.advanceTimersByTimeAsync(199); expect(asks).toBe(0); // (not before 200 ms)
      await vi.advanceTimersByTimeAsync(2); expect(asks).toBe(1); // (the first ask at 200 ms)
      await vi.advanceTimersByTimeAsync(1_498); expect(asks).toBe(1); await vi.advanceTimersByTimeAsync(3); expect(asks).toBe(2); // (the next one a whole poll later)
      await vi.advanceTimersByTimeAsync(1_500); await expect(out).resolves.toEqual({ kind: 'answered', decision: 'allow' }); expect(times[0]).toBeLessThan(400);
    } finally { vi.useRealTimers(); }
  });
});
