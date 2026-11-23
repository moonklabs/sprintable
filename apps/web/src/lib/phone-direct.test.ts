// story 4993 (5a) — the web's direct road: the contract copy is the mobile repository's byte for byte, the row the web builds is the one the server's payload says (contracts/direct-rows.json — the server's test reads the same file),
// a plain instruction never rides, and every step of `tryDirect` ends in the one word that keeps the rule «never send twice · never lose a press».
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_NEGOTIATE_MAX_MS, DIRECT_OPEN_AGAIN_MS, DIRECT_PROBE_BUDGET_MS, DIRECT_SEND_BUDGET_MS, directRow, tryDirect } from './phone-direct';
import type { PhoneAnswer } from './phone-bridge';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (f: string) => readFileSync(path.join(ROOT, 'contracts', f));
const BRIDGE_SHA = '3ba5217c63df8d7083eafb093b519b3493a10b92b97debf811b9b9c20f2b1a98'; // mobile `contracts/direct-bridge.json` (story 4993 · file direct, version 3) — a copy that drifts is a failure, not a quiet divergence
const ROWS = JSON.parse(read('direct-rows.json').toString('utf8')) as { row_keys: string[]; cases: Array<{ name: string; kind: string; sealed: boolean; payload_from_body: string[] }>; never_direct: Array<{ name: string; kind: string; sealed: boolean }> };
const BRIDGE = JSON.parse(read('direct-bridge.json').toString('utf8'));

const KEY = 'press-key-0001';
const SETUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const bodies: Record<string, Record<string, unknown>> = {
  send_prompt: { kind: 'send_prompt', session_key: 's-9', conversation_id: '33333333-4444-4555-8666-777777777777', envelope: { v: 1, kind: 'send_prompt' }, phone_key_id: 'k-1' },
  stop_session: { kind: 'stop_session', session_key: 's-9', signed: 'SIGNED-S', phone_key_id: 'k-1' },
  end_session: { kind: 'end_session', session_key: 's-9', signed: 'SIGNED-E', phone_key_id: 'k-1' },
};
const pendingOf = (c: { kind: string; sealed: boolean }, over: Record<string, unknown> = {}) => ({ verb: c.kind === 'send_prompt' ? 'send' : c.kind === 'end_session' ? 'end' : 'stop', key: KEY, body: bodies[c.kind]!, ...(c.sealed ? { sealed: true as const } : {}), ...over });

describe('[4993 5a] the contract copies', () => {
  it('direct-bridge.json is the mobile repository\'s file byte for byte', () => { expect(createHash('sha256').update(read('direct-bridge.json')).digest('hex')).toBe(BRIDGE_SHA); });
  it('the bridge names the seven calls the web uses and the closed words it relies on', () => {
    expect(Object.keys(BRIDGE.calls).sort()).toEqual(['direct.ask', 'direct.close', 'direct.download_save', 'direct.offer', 'direct.result', 'direct.send', 'direct.status']);
    expect(BRIDGE.allowed.kinds).toEqual(expect.arrayContaining(['send_prompt', 'stop_session', 'end_session', 'file_download'])); // (version 3: a download rides the road)
    expect(BRIDGE.version).toBe(3);
    expect(BRIDGE.command_row.keys).toEqual(ROWS.row_keys);
  });
});

describe('[4993 5a] the row of a press (contracts/direct-rows.json)', () => {
  for (const c of ROWS.cases) {
    it(`${c.name}: the payload is exactly the body's ${c.payload_from_body.join(' · ')} and the command id is the press's key`, () => {
      const p = pendingOf(c); const row = directRow(p, Date.UTC(2026, 10, 23, 9, 0, 0))!;
      expect(Object.keys(row)).toEqual(ROWS.row_keys);
      expect(row.payload).toEqual(Object.fromEntries(c.payload_from_body.map((k) => [k, p.body[k]])));
      expect(Object.keys(row.payload as object)).toEqual(c.payload_from_body);
      expect([row.command_id, row.kind, row.session_key, row.created_at]).toEqual([KEY, c.kind, 's-9', '2026-11-23T09:00:00.000Z']);
      expect(JSON.stringify(row)).not.toContain('phone_key_id'); // the server keeps the key id beside the command, never in the payload
    });
  }
  for (const c of ROWS.never_direct) {
    it(`${c.name}: never a row`, () => {
      expect(directRow(pendingOf(c, { body: { kind: 'send_prompt', session_key: 's-9', signed: 'S', text: 'words', conversation_id: 'c', phone_key_id: 'k' } }), 0)).toBeNull();
      expect(directRow(pendingOf({ kind: 'send_prompt', sealed: false }), 0)).toBeNull(); // a sealed-looking body that is not marked sealed
    });
  }
  it('a row is refused when the body is not what the kind needs', () => {
    const sealed = pendingOf({ kind: 'send_prompt', sealed: true });
    const t = (p: unknown) => directRow(p as never, 0);
    expect(t({ ...sealed, body: { ...bodies.send_prompt!, envelope: 'x' } })).toBeNull(); expect(t({ ...sealed, body: { ...bodies.send_prompt!, envelope: [] } })).toBeNull(); expect(t({ ...sealed, body: { ...bodies.send_prompt!, envelope: null } })).toBeNull();
    expect(t({ ...sealed, body: { ...bodies.send_prompt!, conversation_id: 5 } })).toBeNull(); expect(t({ ...sealed, body: { ...bodies.send_prompt!, session_key: '' } })).toBeNull(); expect(t({ ...sealed, body: { ...bodies.send_prompt!, session_key: undefined } })).toBeNull();
    for (const k of ['stop_session', 'end_session']) { const p = pendingOf({ kind: k, sealed: false }); expect(t({ ...p, body: { ...p.body, signed: '' } })).toBeNull(); expect(t({ ...p, body: { ...p.body, signed: 5 } })).toBeNull(); expect(t({ ...p, body: { ...p.body, signed: undefined } })).toBeNull(); }
    expect(t({ ...sealed, body: { ...bodies.send_prompt!, kind: 'file_list' } })).toBeNull(); expect(t({ ...sealed, body: { ...bodies.send_prompt!, kind: 'answer_approval' } })).toBeNull();
    for (const key of ['short', 'has space 0001', 'x'.repeat(101), '', 5]) expect(t({ ...sealed, key })).toBeNull();
  });
  it('the row\'s time is the phone\'s clock as an ISO text the shell\'s judgement accepts', () => { const r = directRow(pendingOf(ROWS.cases[1]!), Date.now())!; expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); });
});

/** a shell: each call's answer by type (a function may await · throw) and a log of the calls */
function shell(answers: Record<string, PhoneAnswer | (() => Promise<PhoneAnswer>)>) {
  const log: Array<{ type: string; args: Record<string, unknown> }> = [];
  const phoneCall = vi.fn(async (type: string, args: Record<string, unknown>) => { log.push({ type, args }); const a = answers[type]; if (a === undefined) throw new Error(`no answer for ${type}`); return typeof a === 'function' ? a() : a; });
  return { phoneCall, log };
}
const CAPS: PhoneAnswer = { id: 'c', ok: true, caps: { sealed_prompt: 1, direct: 1 } };
const READY: PhoneAnswer = { id: 's', ok: true, state: 'ready' };
const IDLE: PhoneAnswer = { id: 's', ok: true, state: 'idle' };
const OPEN: PhoneAnswer = { id: 'o', ok: true };
const SENT: PhoneAnswer = { id: 'x', ok: true, sent: true };
const stopP = () => pendingOf({ kind: 'stop_session', sealed: false });

describe('[4993 5a] tryDirect — one word for each way it can end', () => {
  it('the road is ready: send the ONE row → sent (and the row sent is the press\'s row)', async () => {
    const s = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': SENT });
    await expect(tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall, now: () => 0 })).resolves.toBe('sent');
    expect(s.log.map((l) => l.type)).toEqual(['shell.caps', 'direct.status', 'direct.send']); expect(s.log[2]!.args).toEqual({ setup_id: SETUP, row: directRow(stopP(), 0) });
  });
  it('NO ROAD YET (idle): the press goes to the server AT ONCE — no waiting for a door — and the road is opened BEHIND it', async () => {
    vi.useFakeTimers(); try {
      const s = shell({ 'shell.caps': CAPS, 'direct.status': IDLE, 'direct.ask': () => new Promise<PhoneAnswer>(() => {}), 'direct.send': SENT }); const p = tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall, now: () => 0 });
      await expect(p).resolves.toBe('not_sent'); // (not one timer was advanced: the open never answers, and the press did not wait for it)
      expect(s.log.map((l) => l.type)).toEqual(['shell.caps', 'direct.status', 'direct.ask']); expect(s.log[2]!.args).toEqual({ setup_id: SETUP }); expect(s.log.some((l) => l.type === 'direct.send')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('a shell that does not know the question, says no, or says anything but 1 → the server (nothing else is asked)', async () => {
    for (const caps of [{ id: 'c', ok: false, code: 'bad_request' }, { id: 'c', ok: true, caps: {} }, { id: 'c', ok: true, caps: { direct: 0 } }, { id: 'c', ok: true, caps: { direct: true } }, { id: 'c', ok: true, caps: { direct: '1' } }, { id: 'c', ok: true }, { id: 'c', ok: true, caps: 'x' }] as PhoneAnswer[]) {
      const s = shell({ 'shell.caps': caps }); await expect(tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall, now: () => 0 })).resolves.toBe('not_sent'); expect(s.log.map((l) => l.type)).toEqual(['shell.caps']);
    }
    const t = shell({ 'shell.caps': async () => { throw new Error('page gone'); } }); await expect(tryDirect(SETUP, stopP(), { phoneCall: t.phoneCall })).resolves.toBe('not_sent');
  });
  it('a failed answer is a failed answer, whatever else it carries (caps · status)', async () => {
    const c = shell({ 'shell.caps': { id: 'c', ok: false, code: 'bad_request', caps: { direct: 1 } } as PhoneAnswer }); await expect(tryDirect(SETUP, stopP(), { phoneCall: c.phoneCall })).resolves.toBe('not_sent'); expect(c.log.map((l) => l.type)).toEqual(['shell.caps']);
    const st = shell({ 'shell.caps': CAPS, 'direct.status': { id: 's', ok: false, code: 'bad_request', state: 'ready' } as PhoneAnswer, 'direct.send': SENT }); await expect(tryDirect(SETUP, stopP(), { phoneCall: st.phoneCall })).resolves.toBe('not_sent'); expect(st.log.some((l) => l.type === 'direct.send')).toBe(false);
  });
  it('a press that cannot be a direct row never asks the shell anything', async () => {
    const s = shell({}); await expect(tryDirect(SETUP, pendingOf({ kind: 'send_prompt', sealed: false }), { phoneCall: s.phoneCall })).resolves.toBe('not_sent'); expect(s.log).toEqual([]);
  });
  it('what the open says is nobody\'s business: a refusal · an answer that never comes · a call that fails — the press already went to the server and nothing is thrown', async () => {
    for (const open of [{ id: 'o', ok: false, why: 'cooling' } as PhoneAnswer, { id: 'o', ok: false, code: 'bad_request' } as PhoneAnswer, (async () => { throw new Error('gone'); }) as () => Promise<PhoneAnswer>, () => new Promise<PhoneAnswer>(() => {})]) {
      const s = shell({ 'shell.caps': CAPS, 'direct.status': IDLE, 'direct.ask': open }); await expect(tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall })).resolves.toBe('not_sent'); expect(s.log.some((l) => l.type === 'direct.send')).toBe(false);
    }
    // a rejected open is caught where it is started: no unhandled rejection escapes into the page
    const stray: unknown[] = []; const onStray = (e: unknown) => { stray.push(e); }; process.on('unhandledRejection', onStray);
    try { const plain = async (type: string): Promise<PhoneAnswer> => { if (type === 'shell.caps') return CAPS; if (type === 'direct.status') return IDLE; throw new Error('the open failed'); }; /* (a plain function: a vi.fn would attach its own handler to what it returns and hide the stray) */ await tryDirect(SETUP, stopP(), { phoneCall: plain }); await new Promise<void>((r) => setImmediate(r)); await new Promise<void>((r) => setImmediate(r)); } finally { process.off('unhandledRejection', onStray); }
    expect(stray).toEqual([]);
    const sync = shell({ 'shell.caps': CAPS, 'direct.status': IDLE }); const throwing = async (type: string, args: Record<string, unknown>): Promise<PhoneAnswer> => sync.phoneCall(type, args); void throwing;
    const atOnce = (type: string): Promise<PhoneAnswer> => { if (type === 'shell.caps') return Promise.resolve(CAPS); if (type === 'direct.status') return Promise.resolve(IDLE); throw new Error('threw at once, before any promise'); };
    await expect(tryDirect(SETUP, stopP(), { phoneCall: atOnce })).resolves.toBe('not_sent'); // (a call that THROWS instead of rejecting: the press still goes to the server)
  });
  it('a shell that never answers caps → the server within the small box (the press is never left hanging)', async () => {
    vi.useFakeTimers(); try {
      const s = shell({ 'shell.caps': () => new Promise<PhoneAnswer>(() => {}) }); const p = tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall }); await vi.advanceTimersByTimeAsync(DIRECT_PROBE_BUDGET_MS); await expect(p).resolves.toBe('not_sent'); expect(s.log.map((l) => l.type)).toEqual(['shell.caps']);
    } finally { vi.useRealTimers(); }
  });
  it('caps and status share ONE small box (1 s): a slow caps leaves status only what is left, and a box that is spent asks nothing more', async () => {
    vi.useFakeTimers(); try {
      const s = shell({ 'shell.caps': () => new Promise<PhoneAnswer>((r) => setTimeout(() => r(CAPS), 600)), 'direct.status': () => new Promise<PhoneAnswer>((r) => setTimeout(() => r(READY), 600)), 'direct.send': SENT });
      const p = tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall }); let at = -1; const t0 = Date.now(); void p.then(() => { at = Date.now() - t0; });
      await vi.advanceTimersByTimeAsync(DIRECT_PROBE_BUDGET_MS + 100); await expect(p).resolves.toBe('not_sent'); expect(at).toBeLessThanOrEqual(DIRECT_PROBE_BUDGET_MS); expect(at).toBeGreaterThanOrEqual(DIRECT_PROBE_BUDGET_MS - 5); expect(s.log.some((l) => l.type === 'direct.send')).toBe(false);
      const gone = shell({ 'shell.caps': () => new Promise<PhoneAnswer>((r) => setTimeout(() => r(CAPS), DIRECT_PROBE_BUDGET_MS)), 'direct.status': READY, 'direct.send': SENT }); const w = tryDirect(SETUP, stopP(), { phoneCall: gone.phoneCall }); await vi.advanceTimersByTimeAsync(DIRECT_PROBE_BUDGET_MS + 10); await expect(w).resolves.toBe('not_sent'); expect(gone.log.map((l) => l.type)).toEqual(['shell.caps', 'direct.status']); // (the press sends nothing and does not wait; the status is asked LATE only to decide whether to open the road behind — READY here: nothing is opened, no send — see phone-direct-slow.test.ts)
    } finally { vi.useRealTimers(); }
  });
  it('a ready status that answers just as the box ends sends nothing', async () => {
    vi.useFakeTimers(); try {
      const s = shell({ 'shell.caps': CAPS, 'direct.status': () => new Promise<PhoneAnswer>((r) => setTimeout(() => r(READY), DIRECT_PROBE_BUDGET_MS)), 'direct.send': SENT });
      const p = tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall }); await vi.advanceTimersByTimeAsync(DIRECT_PROBE_BUDGET_MS); await expect(p).resolves.toBe('not_sent'); expect(s.log.some((l) => l.type === 'direct.send')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('two presses together ask the shell to open the road ONCE (and again only after a while)', async () => {
    const fired = new Map<string, number>(); const s = shell({ 'shell.caps': CAPS, 'direct.status': IDLE, 'direct.ask': OPEN });
    await Promise.all([tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall, openFired: fired }), tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall, openFired: fired })]);
    expect(s.log.filter((l) => l.type === 'direct.ask').length).toBe(1);
    vi.useFakeTimers(); try {
      const t = shell({ 'shell.caps': CAPS, 'direct.status': IDLE, 'direct.ask': OPEN }); const f2 = new Map<string, number>();
      await tryDirect(SETUP, stopP(), { phoneCall: t.phoneCall, openFired: f2 }); await vi.advanceTimersByTimeAsync(DIRECT_OPEN_AGAIN_MS - 1); await tryDirect(SETUP, stopP(), { phoneCall: t.phoneCall, openFired: f2 }); expect(t.log.filter((l) => l.type === 'direct.ask').length).toBe(1);
      await vi.advanceTimersByTimeAsync(1); await tryDirect(SETUP, stopP(), { phoneCall: t.phoneCall, openFired: f2 }); expect(t.log.filter((l) => l.type === 'direct.ask').length).toBe(2);
      const other = shell({ 'shell.caps': CAPS, 'direct.status': IDLE, 'direct.ask': OPEN }); await tryDirect('11111111-0b0a-4908-8706-050403020100', stopP(), { phoneCall: other.phoneCall, openFired: f2 }); expect(other.log.filter((l) => l.type === 'direct.ask').length).toBe(1); // (another computer is its own)
    } finally { vi.useRealTimers(); }
  });
  it('a bridge that THROWS before it returns a promise (the WebView bridge is not there): every call is «no road» for the press — to the server — and a send that threw is certainly not sent', async () => {
    const mk = (throwOn: string) => { const log: string[] = []; const phoneCall = ((type: string): Promise<PhoneAnswer> => { log.push(type); if (type === throwOn) throw new Error(`the bridge threw on ${type}`); return Promise.resolve(type === 'shell.caps' ? CAPS : type === 'direct.status' ? READY : SENT); }); return { log, phoneCall }; };
    for (const on of ['shell.caps', 'direct.status', 'direct.send']) { const t = mk(on); await expect(tryDirect(SETUP, stopP(), { phoneCall: t.phoneCall }), on).resolves.toBe('not_sent'); }
  });
  it('a road that is ALREADY being made is not opened again (asking · connecting · proving → the server this time)', async () => {
    for (const state of ['asking', 'connecting', 'proving', 'whatever']) { const s = shell({ 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state }, 'direct.ask': OPEN, 'direct.send': SENT }); await expect(tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall })).resolves.toBe('not_sent'); expect(s.log.map((l) => l.type)).toEqual(['shell.caps', 'direct.status']); }
  });
  it('a status that does not answer in time or is refused → the server', async () => {
    vi.useFakeTimers(); try {
      const s = shell({ 'shell.caps': CAPS, 'direct.status': () => new Promise<PhoneAnswer>(() => {}) }); const p = tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall }); await vi.advanceTimersByTimeAsync(DIRECT_PROBE_BUDGET_MS); await expect(p).resolves.toBe('not_sent');
    } finally { vi.useRealTimers(); }
    const r = shell({ 'shell.caps': CAPS, 'direct.status': { id: 's', ok: false, code: 'bad_request' } }); await expect(tryDirect(SETUP, stopP(), { phoneCall: r.phoneCall })).resolves.toBe('not_sent');
  });
  it('the shell says it was NOT sent (a closed word: nothing went out) → the server; ok:false from the bridge too', async () => {
    for (const why of ['not_open', 'busy', 'too_big', 'not_allowed', 'bad_row', 'no_road']) { const s = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': { id: 'x', ok: true, sent: false, why } }); await expect(tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall })).resolves.toBe('not_sent'); }
    for (const why of ['ack', 'closed', 'protocol']) { const s = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': { id: 'x', ok: true, sent: false, why } }); await expect(tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall })).resolves.toBe('missed'); } // (no verified receipt: the frame may have reached the Mac)
    for (const odd of [undefined, 5, 'ECONNRESET 192.168.1.1', '']) { const s = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': { id: 'x', ok: true, sent: false, why: odd } as PhoneAnswer }); await expect(tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall })).resolves.toBe('not_sent'); }
    const e = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': { id: 'x', ok: false, code: 'bad_request' } }); await expect(tryDirect(SETUP, stopP(), { phoneCall: e.phoneCall })).resolves.toBe('not_sent');
    const sentTrueButNotOk = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': { id: 'x', ok: false, sent: true } as PhoneAnswer }); await expect(tryDirect(SETUP, stopP(), { phoneCall: sentTrueButNotOk.phoneCall })).resolves.toBe('not_sent');
    const sentStr = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': { id: 'x', ok: true, sent: 'true' } as PhoneAnswer }); await expect(tryDirect(SETUP, stopP(), { phoneCall: sentStr.phoneCall })).resolves.toBe('not_sent');
  });
  it('a send that does not answer in time — or whose call fails — MAY have gone: `maybe`, never `not_sent` (it is followed, never posted)', async () => {
    vi.useFakeTimers(); try {
      const s = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': () => new Promise<PhoneAnswer>(() => {}) }); const p = tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall });
      await vi.advanceTimersByTimeAsync(DIRECT_SEND_BUDGET_MS - 1); let done = false; void p.then(() => { done = true; }); await vi.advanceTimersByTimeAsync(0); expect(done).toBe(false); await vi.advanceTimersByTimeAsync(1); await expect(p).resolves.toBe('maybe');
    } finally { vi.useRealTimers(); }
    const f = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': async () => { throw new Error('page hidden'); } }); await expect(tryDirect(SETUP, stopP(), { phoneCall: f.phoneCall })).resolves.toBe('maybe');
  });
  it('the probe box is short (a press waits at most this long for the two local questions) and the send box is longer than the shell\'s own wait for a receipt (4 s)', () => { expect(DIRECT_PROBE_BUDGET_MS).toBeLessThanOrEqual(1_000); expect(DIRECT_SEND_BUDGET_MS).toBeGreaterThan(4_000); });
  it('the budgets can be given (tests and a slower phone)', async () => {
    vi.useFakeTimers(); try {
      const s = shell({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': () => new Promise<PhoneAnswer>(() => {}) }); const p = tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall, budget: { send: 50 } }); await vi.advanceTimersByTimeAsync(50); await expect(p).resolves.toBe('maybe');
    } finally { vi.useRealTimers(); }
  });
});

// ── story 4993 (4c-2 · PO decision B): the negotiation the PAGE carries — ask (shell) → POST → look → offer (shell). The page makes up nothing and hands over only what the server gave for THIS ask.
describe('[4993 4c-2] the road is made behind a press: ask → POST → look → offer', () => {
  const ASK: PhoneAnswer = { id: 'a', ok: true, command_id: 'press-ask-0001', envelope: { v: 1, kind: 'direct_open', ct: 'SEALED-ASK' }, phone_key_id: 'phone-key-1' };
  const SERVER_ID = '33333333-4444-4555-8666-777777777777';
  const ANSWER = { v: 1, kind: 'direct_offer', ct: 'SEALED-ANSWER' };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  /** a server: the POST's answer · the looks' answers in order (the last repeats) · every call logged */
  function server(post: () => Response | Promise<Response>, looks: Array<() => Response | Promise<Response>>) {
    const log: Array<{ method: string; url: string; body?: unknown }> = []; let i = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'; log.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (method === 'POST') return post(); if (method === 'DELETE') return json(200, { deleted: true });
      const f = looks[Math.min(i++, looks.length - 1)]!; return f();
    });
    return { fetch, log };
  }
  const run = async (s: ReturnType<typeof shell>, srv: ReturnType<typeof server>, extra: Record<string, unknown> = {}) => {
    const waits: number[] = []; let t = 0;
    await tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall, fetch: srv.fetch, wait: async (ms) => { waits.push(ms); t += ms; }, now: () => t, openFired: new Map(), ...extra });
    for (let k = 0; k < 40; k++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 20)); // (the negotiation runs BEHIND the press: let it end)
    return { waits };
  };
  const idle = (offer: PhoneAnswer | (() => Promise<PhoneAnswer>) = OPEN) => shell({ 'shell.caps': CAPS, 'direct.status': IDLE, 'direct.ask': ASK, 'direct.offer': offer });

  it('the whole way: the shell\'s ask is POSTed with exactly its three fields; the server\'s answer reaches the shell as it is, once; the server row is not deleted (reading deleted it)', async () => {
    const s = idle(); const srv = server(() => json(201, { command_id: SERVER_ID, expires_at: 'x' }), [() => json(200, { state: 'queued', code: null, envelope: null }), () => json(200, { state: 'done', code: null, envelope: ANSWER })]);
    await run(s, srv);
    expect(s.log.map((l) => l.type)).toEqual(['shell.caps', 'direct.status', 'direct.ask', 'direct.offer']);
    expect(srv.log[0]).toEqual({ method: 'POST', url: `/api/desktop/computers/${SETUP}/direct`, body: { idempotency_key: 'press-ask-0001', phone_key_id: 'phone-key-1', envelope: ASK.envelope } });
    expect(srv.log.filter((l) => l.method === 'GET').map((l) => l.url)).toEqual([`/api/desktop/computers/${SETUP}/direct/${SERVER_ID}`, `/api/desktop/computers/${SETUP}/direct/${SERVER_ID}`]);
    expect(s.log[3]!.args).toEqual({ setup_id: SETUP, command_id: 'press-ask-0001', envelope: ANSWER }); // (the press key of the ASK, and the server's envelope untouched)
    expect(srv.log.some((l) => l.method === 'DELETE')).toBe(false);
  });

  it('the page hands over nothing the server did not give: no envelope · a non-object · the Mac ended without one → no offer', async () => {
    for (const looks of [[() => json(200, { state: 'done', code: null, envelope: 'text' })], [() => json(200, { state: 'done', code: null, envelope: [] })], [() => json(200, { state: 'rejected', code: 'DIR_NO_NETWORK', envelope: null })], [() => json(200, { state: 'failed', code: 'x', envelope: null })]]) {
      const s = idle(); const srv = server(() => json(201, { command_id: SERVER_ID }), looks); await run(s, srv);
      expect(s.log.some((l) => l.type === 'direct.offer')).toBe(false);
      expect(srv.log.filter((l) => l.method === 'GET').length).toBe(1); expect(srv.log.some((l) => l.method === 'DELETE')).toBe(false); // (an ended ask is looked at once: the server already deleted its row)
    }
  });

  it('no ask was made (ok:false · a word · no envelope · a call that fails) → nothing is POSTed', async () => {
    for (const ask of [{ id: 'a', ok: false, why: 'cooling' }, { id: 'a', ok: false, code: 'bad_request' }, { id: 'a', ok: true }, { id: 'a', ok: false, why: 'busy', command_id: 'k', envelope: { v: 1 }, phone_key_id: 'p' }, { id: 'a', ok: true, command_id: 'k', envelope: 'x', phone_key_id: 'p' }, { id: 'a', ok: true, command_id: '', envelope: {}, phone_key_id: 'p' }, { id: 'a', ok: true, command_id: 'k', envelope: {}, phone_key_id: '' }] as PhoneAnswer[]) {
      const s = shell({ 'shell.caps': CAPS, 'direct.status': IDLE, 'direct.ask': ask }); const srv = server(() => json(201, { command_id: SERVER_ID }), [() => json(200, {})]); await run(s, srv); expect(srv.fetch).not.toHaveBeenCalled();
    }
    const t = shell({ 'shell.caps': CAPS, 'direct.status': IDLE, 'direct.ask': async () => { throw new Error('gone'); } }); const srv = server(() => json(201, { command_id: SERVER_ID }), [() => json(200, {})]); await run(t, srv); expect(srv.fetch).not.toHaveBeenCalled();
  });

  it('a POST the server refuses or that fails or has no id → no look, no offer (the press went to the server already; nothing is told to the person)', async () => {
    for (const post of [() => json(429, { error: { code: 'direct_ask_too_fast' } }), () => json(409, {}), () => json(201, {}), () => json(201, { command_id: 5 }), () => { throw new Error('network'); }]) {
      const s = idle(); const srv = server(post as never, [() => json(200, { envelope: ANSWER })]); await run(s, srv);
      expect(srv.log.map((l) => l.method)).toEqual(['POST']); expect(s.log.some((l) => l.type === 'direct.offer')).toBe(false);
    }
  });

  it('a look that fails (429 «too fast» · 5xx · a body that is no JSON · a throw) is not an end — the next look comes; a 404 is the end and deletes nothing', async () => {
    const s = idle(); const srv = server(() => json(201, { command_id: SERVER_ID }), [() => json(429, {}), () => json(503, {}), () => new Response('not json', { status: 200 }), () => { throw new Error('net'); }, () => json(200, { state: 'done', envelope: ANSWER })]);
    await run(s, srv); expect(s.log.filter((l) => l.type === 'direct.offer').length).toBe(1);
    const t = idle(); const gone = server(() => json(201, { command_id: SERVER_ID }), [() => json(404, { error: { code: 'direct_ask_not_found' } })]); await run(t, gone);
    expect(t.log.some((l) => l.type === 'direct.offer')).toBe(false); expect(gone.log.map((l) => l.method)).toEqual(['POST', 'GET']);
  });

  it('no answer within the time (25 s): the looks stop, the server row is deleted ONCE, the shell is offered nothing', async () => {
    const s = idle(); const srv = server(() => json(201, { command_id: SERVER_ID }), [() => json(200, { state: 'delivered', code: null, envelope: null })]);
    const { waits } = await run(s, srv);
    const looks = srv.log.filter((l) => l.method === 'GET').length; expect(looks).toBeGreaterThan(30); expect(DIRECT_NEGOTIATE_MAX_MS).toBe(25_000); expect(looks).toBeLessThanOrEqual(42); /* (25 s ÷ 0.6 s, written out: a limit that moved with the constant would prove nothing) */ expect(waits.every((w) => w === 600)).toBe(true);
    expect(srv.log.filter((l) => l.method === 'DELETE')).toEqual([{ method: 'DELETE', url: `/api/desktop/computers/${SETUP}/direct/${SERVER_ID}` }]); expect(s.log.some((l) => l.type === 'direct.offer')).toBe(false);
  });

  it('what the shell says to the offer is its own business: a refusal · a throw · a never-answering call end quietly, nothing is retried or posted again', async () => {
    for (const offer of [{ id: 'o', ok: false, why: 'answer_bad' } as PhoneAnswer, async () => { throw new Error('bridge gone'); }, () => new Promise<PhoneAnswer>((r) => setTimeout(() => r(OPEN), 50))]) {
      const s = idle(offer); const srv = server(() => json(201, { command_id: SERVER_ID }), [() => json(200, { state: 'done', envelope: ANSWER })]); await run(s, srv);
      expect(s.log.filter((l) => l.type === 'direct.offer').length).toBe(1); expect(srv.log.filter((l) => l.method === 'POST').length).toBe(1);
    }
  });

  it('two presses together make ONE ask (the shared «opened lately» map), and a road that is not idle is never asked for', async () => {
    const fired = new Map<string, number>(); const s = idle(); const srv = server(() => json(201, { command_id: SERVER_ID }), [() => json(200, { state: 'done', envelope: ANSWER })]);
    await Promise.all([tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall, fetch: srv.fetch, wait: async () => undefined, openFired: fired }), tryDirect(SETUP, stopP(), { phoneCall: s.phoneCall, fetch: srv.fetch, wait: async () => undefined, openFired: fired })]);
    await new Promise((r) => setTimeout(r, 30)); expect(s.log.filter((l) => l.type === 'direct.ask').length).toBe(1);
    for (const state of ['asking', 'connecting', 'proving', 'ready']) { const t = shell({ 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state }, 'direct.ask': ASK, 'direct.send': SENT }); await tryDirect(SETUP, stopP(), { phoneCall: t.phoneCall, fetch: srv.fetch, openFired: new Map() }); expect(t.log.some((l) => l.type === 'direct.ask')).toBe(false); }
  });

  it('nothing of the ask or the answer is ever put in a thrown error or logged (the page keeps neither)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined); const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try { const s = idle(); const srv = server(() => json(201, { command_id: SERVER_ID }), [() => json(200, { state: 'done', envelope: ANSWER })]); await run(s, srv); expect(spy).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); } finally { spy.mockRestore(); warn.mockRestore(); log.mockRestore(); }
  });
});
