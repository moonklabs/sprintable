// story 4993 (5a) — a sealed instruction, a stop and an end go over the same-network direct road FIRST and to the server when they do not; every way a direct press ends reads as the relay's line reads — the same screen.
import { describe, expect, it, vi } from 'vitest';
import { checkCommand, commandOnPhone, type CommandDeps, type CommandInput, type Pending } from './phone-command';
import type { PhoneAnswer } from './phone-bridge';

let serverCalls: Array<{ url: string; init?: RequestInit }> = [];
let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => { serverCalls.push({ url, init }); return currentFetch(url, init); } }));

const AGENT = '22222222-3333-4444-8555-666666666666';
const CONV = '33333333-4444-4555-8666-777777777777';
const SETUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const CMD = '44444444-5555-4666-8777-888888888888';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

type Handler = PhoneAnswer | ((args: Record<string, unknown>) => PhoneAnswer | Promise<PhoneAnswer>);
function shell(map: Record<string, Handler>) {
  const log: Array<{ type: string; args: Record<string, unknown> }> = [];
  const phoneCall = vi.fn(async (type: string, args: Record<string, unknown>) => { log.push({ type, args }); const h = map[type]; if (h === undefined) throw new Error(`no handler: ${type}`); return typeof h === 'function' ? h(args) : h; });
  return { phoneCall, log, count: (t: string) => log.filter((l) => l.type === t).length };
}
const deps = (phoneCall: CommandDeps['phoneCall'], extra: Partial<CommandDeps> = {}) => { const sent: string[] = []; return { phoneCall, sendMessage: async (t: string) => { sent.push(t); return true; }, newKey: () => 'press-key-0001', wait: async () => {}, sent, ...extra } as CommandDeps & { sent: string[] }; };
const CAPS: PhoneAnswer = { id: 'c', ok: true, caps: { sealed_prompt: 1, direct: 1 } };
const CAPS_NO_DIRECT: PhoneAnswer = { id: 'c', ok: true, caps: { sealed_prompt: 1 } };
const SIGN_STOP: PhoneAnswer = { id: 'w', ok: true, signed: 'SIGNED-S', phone_key_id: 'k-1', session_key: 's-9' };
const SIGN_SEALED: PhoneAnswer = { id: 'w', ok: true, sealed: true, envelope: { v: 1, kind: 'send_prompt' }, phone_key_id: 'k-1', session_key: 's-9', conversation_id: CONV };
const stop: CommandInput = { agentId: AGENT, kind: 'stop_session', setupId: SETUP };
const end: CommandInput = { agentId: AGENT, kind: 'end_session', setupId: SETUP };
const prompt: CommandInput = { agentId: AGENT, kind: 'send_prompt', text: 'words', conversationId: CONV, computerOpensSealed: true, setupId: SETUP };
const direct = (result: Handler, extra: Record<string, Handler> = {}) => ({ 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'ready' }, 'direct.send': { id: 'x', ok: true, sent: true }, 'direct.result': result, ...extra } as Record<string, Handler>);
const reset = () => { serverCalls = []; currentFetch = async () => { throw new Error('the server must not be called'); }; };

describe('[4993 5a] the direct road first', () => {
  it('a stop: signed, sent over the road, its word read from the shell — and the server is never called', async () => {
    reset(); const s = shell({ 'command.sign': SIGN_STOP, ...direct({ id: 'r', ok: true, state: 'done' }) });
    await expect(commandOnPhone(stop, deps(s.phoneCall))).resolves.toEqual({ kind: 'stopped' });
    expect(serverCalls).toEqual([]); const sent = s.log.find((l) => l.type === 'direct.send')!; expect(sent.args.setup_id).toBe(SETUP);
    expect(sent.args.row).toMatchObject({ command_id: 'press-key-0001', kind: 'stop_session', session_key: 's-9', payload: { session_key: 's-9', signed: 'SIGNED-S' } });
    expect(s.log.find((l) => l.type === 'direct.result')!.args).toEqual({ setup_id: SETUP, command_id: 'press-key-0001' });
  });
  it('an end of the session and a sealed instruction the same way (sent_now · ended)', async () => {
    reset(); const e = shell({ 'command.sign': SIGN_STOP, ...direct({ id: 'r', ok: true, state: 'done' }) }); await expect(commandOnPhone(end, deps(e.phoneCall))).resolves.toEqual({ kind: 'ended' });
    const p = shell({ 'command.sign': SIGN_SEALED, ...direct({ id: 'r', ok: true, state: 'done' }) }); await expect(commandOnPhone(prompt, deps(p.phoneCall))).resolves.toEqual({ kind: 'sent_now' });
    const row = p.log.find((l) => l.type === 'direct.send')!.args.row as Record<string, unknown>; expect(row.payload).toEqual({ session_key: 's-9', conversation_id: CONV, envelope: { v: 1, kind: 'send_prompt' } }); expect(JSON.stringify(row)).not.toContain('words'); expect(serverCalls).toEqual([]);
  });
  it('the words the daemon says are read as the relay\'s line is read', async () => {
    reset();
    for (const [state, code, input, expected] of [
      ['done', 'after_step', prompt, { kind: 'sent_after_step' }], ['done', 'commands_running', stop, { kind: 'stopped_commands_running' }], ['rejected', 'system_wait_end_only', stop, { kind: 'system_wait_end_only' }],
      ['rejected', 'session_not_working', stop, { kind: 'already_stopped' }], ['rejected', 'instruct_hidden_text', prompt, { kind: 'hidden_text' }], ['rejected', 'instruct_too_long', prompt, { kind: 'too_long' }],
      ['rejected', 'session_not_working', prompt, { kind: 'sealed_not_taken' }], ['rejected', 'instruct_not_now', prompt, { kind: 'sealed_not_taken' }], ['rejected', 'unsigned', stop, { kind: 'failed' }], ['rejected', 'bad_signature', stop, { kind: 'failed' }], ['failed', 'error', stop, { kind: 'failed' }],
    ] as Array<[string, string, CommandInput, unknown]>) {
      const d = deps(shell({ 'command.sign': input.kind === 'send_prompt' ? SIGN_SEALED : SIGN_STOP }).phoneCall);
      const s = shell({ 'command.sign': input.kind === 'send_prompt' ? SIGN_SEALED : SIGN_STOP, ...direct({ id: 'r', ok: true, state, code }) });
      await expect(commandOnPhone(input, deps(s.phoneCall))).resolves.toEqual(expected); void d;
    }
    expect(serverCalls).toEqual([]);
  });
  it('THE SAME SCREEN: every (state, code) the daemon can say ends as the same outcome whether the line came from the server or from the direct road', async () => {
    const pairs: Array<[string, string | null]> = [['done', null], ['done', 'after_step'], ['done', 'commands_running'], ['rejected', 'system_wait_end_only'], ['rejected', 'session_not_working'], ['rejected', 'instruct_hidden_text'], ['rejected', 'instruct_too_long'], ['rejected', 'instruct_not_now'], ['rejected', 'unsigned'], ['rejected', 'bad_signature'], ['rejected', 'schema_rejected'], ['rejected', 'not_allowed'], ['failed', 'error'], ['failed', 'stopped'], ['failed', null]];
    for (const input of [stop, end, prompt]) {
      for (const [state, code] of pairs) {
        const sign = input.kind === 'send_prompt' ? SIGN_SEALED : SIGN_STOP;
        // by the server (a shell without the direct road)
        reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state, result_code: code }));
        const relayShell = shell({ 'command.sign': sign, 'shell.caps': CAPS_NO_DIRECT }); const viaServer = await commandOnPhone(input, deps(relayShell.phoneCall));
        // by the road
        reset(); const roadShell = shell({ 'command.sign': sign, ...direct({ id: 'r', ok: true, state, ...(code ? { code } : {}) }) }); const viaRoad = await commandOnPhone(input, deps(roadShell.phoneCall));
        expect(viaRoad, `${input.kind} ${state} ${code}`).toEqual(viaServer);
      }
    }
  });
  it('a signature the Mac refuses on the direct road shows the line a refusal shows on the relay (failed) — and nothing was posted', async () => {
    reset(); const s = shell({ 'command.sign': SIGN_STOP, ...direct({ id: 'r', ok: true, state: 'rejected', code: 'bad_signature' }) });
    await expect(commandOnPhone(stop, deps(s.phoneCall))).resolves.toEqual({ kind: 'failed' }); expect(serverCalls).toEqual([]);
  });
});

describe('[4993 5a] when the direct road does not take it, the server does — exactly as before', () => {
  it('NO ROAD YET: the press reaches the server\'s POST in the same breath — not one millisecond of a door being made is waited for (a fake clock that is never advanced)', async () => {
    reset(); vi.useFakeTimers();
    try {
      currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'done' }));
      const s = shell({ 'command.sign': SIGN_STOP, 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'idle' }, 'direct.open': () => new Promise<PhoneAnswer>(() => {}) });
      const p = commandOnPhone(stop, deps(s.phoneCall)); await vi.advanceTimersByTimeAsync(0); // (microtasks only: no time passes)
      expect(serverCalls.filter((c) => c.init?.method === 'POST').length).toBe(1); expect(s.log.map((l) => l.type)).toEqual(['command.sign', 'shell.caps', 'direct.status', 'direct.open']);
      await expect(p).resolves.toEqual({ kind: 'stopped' });
    } finally { vi.useRealTimers(); }
  });
  const posted = () => serverCalls.filter((c) => c.init?.method === 'POST');
  const server = () => { currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'done' })); };
  it('no setup id given → the shell is not even asked about the road', async () => {
    reset(); server(); const s = shell({ 'command.sign': SIGN_STOP }); await expect(commandOnPhone({ agentId: AGENT, kind: 'stop_session' }, deps(s.phoneCall))).resolves.toEqual({ kind: 'stopped' }); expect(s.log.map((l) => l.type)).toEqual(['command.sign']); expect(posted().length).toBe(1);
  });
  it('two presses together on a road that is not there ask the shell to open it ONCE (the page keeps the guard for all presses)', async () => {
    reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'done' }));
    const OTHER_SETUP = '22222222-0b0a-4908-8706-050403020100'; // (a computer of its own: the guard is per computer, and the test above used the first one)
    const s = shell({ 'command.sign': SIGN_STOP, 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'idle' }, 'direct.open': { id: 'o', ok: true } });
    await Promise.all([commandOnPhone({ ...stop, setupId: OTHER_SETUP }, deps(s.phoneCall)), commandOnPhone({ ...stop, setupId: OTHER_SETUP }, deps(s.phoneCall))]);
    expect(s.count('direct.open')).toBe(1); expect(serverCalls.filter((c) => c.init?.method === 'POST').length).toBe(2);
  });
  it('a shell without the road · a refused open · a closed word on the send → one POST with the same key and body as ever', async () => {
    for (const map of [
      { 'shell.caps': CAPS_NO_DIRECT } as Record<string, Handler>,
      { 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'idle' }, 'direct.open': { id: 'o', ok: false, why: 'cooling' } } as Record<string, Handler>,
      { 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'ready' }, 'direct.send': { id: 'x', ok: true, sent: false, why: 'ack' } } as Record<string, Handler>,
    ]) {
      reset(); server(); const s = shell({ 'command.sign': SIGN_STOP, ...map }); await expect(commandOnPhone(stop, deps(s.phoneCall))).resolves.toEqual({ kind: 'stopped' });
      expect(posted().length).toBe(1); expect(JSON.parse(posted()[0]!.init!.body as string)).toEqual({ kind: 'stop_session', idempotency_key: 'press-key-0001', session_key: 's-9', signed: 'SIGNED-S', phone_key_id: 'k-1' });
      expect(s.count('direct.result')).toBe(0);
    }
  });
  it('a plain (signed) instruction never goes direct: the shell is not asked about the road for it', async () => {
    reset(); server(); const s = shell({ 'command.sign': { id: 'w', ok: true, signed: 'SIGNED', phone_key_id: 'k-1', session_key: 's-9', text: 'words' } });
    await expect(commandOnPhone({ agentId: AGENT, kind: 'send_prompt', text: 'words', conversationId: CONV, setupId: SETUP }, deps(s.phoneCall))).resolves.toEqual({ kind: 'sent_now' }); expect(s.log.map((l) => l.type)).toEqual(['command.sign']); expect(posted().length).toBe(1);
  });
});

describe('[4993 5a] a press the road MISSED (no verified receipt) and the server then takes', () => {
  const posted = () => serverCalls.filter((c) => c.init?.method === 'POST');
  const MISSED = { 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'ready' }, 'direct.send': { id: 'x', ok: true, sent: false, why: 'ack' } } as Record<string, Handler>;
  it('the server\'s line says «replay» (the computer already had it): `unknown`, not a failure — for a signed stop (reused) and for a sealed instruction (envelope_replay)', async () => {
    for (const [input, sign, code] of [[stop, SIGN_STOP, 'reused'], [prompt, SIGN_SEALED, 'envelope_replay']] as Array<[CommandInput, PhoneAnswer, string]>) {
      reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'rejected', result_code: code }));
      const s = shell({ 'command.sign': sign, ...MISSED }); const out = await commandOnPhone(input, deps(s.phoneCall));
      expect(out.kind, code).toBe('unknown'); expect(posted().length).toBe(1);
    }
  });
  it('the same «replay» on a press the direct road never touched is what it always was: a failure', async () => {
    reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'rejected', result_code: 'reused' }));
    const s = shell({ 'command.sign': SIGN_STOP, 'shell.caps': CAPS_NO_DIRECT }); await expect(commandOnPhone(stop, deps(s.phoneCall))).resolves.toEqual({ kind: 'failed' });
    reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'rejected', result_code: 'reused' }));
    const n = shell({ 'command.sign': SIGN_STOP, 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'ready' }, 'direct.send': { id: 'x', ok: true, sent: false, why: 'not_open' } }); await expect(commandOnPhone(stop, deps(n.phoneCall))).resolves.toEqual({ kind: 'failed' }); // (nothing was written: a replay would be a real refusal)
  });
  it('a press that WENT over the road and whose word is «replay» (the computer already had it) is `unknown` too — never a failure of what ran', async () => {
    for (const [input, sign, code] of [[stop, SIGN_STOP, 'reused'], [prompt, SIGN_SEALED, 'envelope_replay']] as Array<[CommandInput, PhoneAnswer, string]>) {
      reset(); const s = shell({ 'command.sign': sign, ...direct({ id: 'r', ok: true, state: 'rejected', code }) }); const out = await commandOnPhone(input, deps(s.phoneCall));
      expect(out.kind, code).toBe('unknown'); expect(serverCalls).toEqual([]);
    }
  });
  it('another refusal after a miss is still what it is (an unsigned stop → failed · a window holds the turn → its own line)', async () => {
    for (const [code, expected] of [['unsigned', { kind: 'failed' }], ['system_wait_end_only', { kind: 'system_wait_end_only' }]] as Array<[string, unknown]>) {
      reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'rejected', result_code: code }));
      const s = shell({ 'command.sign': SIGN_STOP, ...MISSED }); await expect(commandOnPhone(stop, deps(s.phoneCall))).resolves.toEqual(expected);
    }
  });
});

describe('[4993 5a] a press that MAY have gone is followed, never posted', () => {
  it('no answer to the send in time → `unknown` with a direct pending (no POST) — and [결과 확인] asks the shell again, never the server', async () => {
    reset(); vi.useFakeTimers();
    try {
      const s = shell({ 'command.sign': SIGN_STOP, 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'ready' }, 'direct.send': () => new Promise<PhoneAnswer>(() => {}), 'direct.result': { id: 'r', ok: true, state: 'unknown' } });
      const p = commandOnPhone(stop, deps(s.phoneCall, { wait: async () => {} })); await vi.advanceTimersByTimeAsync(10_000);
      const out = await p; expect(out).toMatchObject({ kind: 'unknown', pending: { direct: { setupId: SETUP }, key: 'press-key-0001' } }); expect(serverCalls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it('the shell says «unknown» for the id (the road ended · forgotten) → `unknown`, and checkCommand on a direct pending polls the shell and posts nothing', async () => {
    reset(); const s = shell({ 'command.sign': SIGN_STOP, ...direct({ id: 'r', ok: true, state: 'unknown' }) });
    const out = await commandOnPhone(stop, deps(s.phoneCall)); expect(out.kind).toBe('unknown'); const pending = (out as { pending: Pending }).pending; expect(pending.direct).toEqual({ setupId: SETUP }); expect(s.count('direct.result')).toBe(1); // (the shell said «unknown» once: that is the end — it is not asked for two minutes more)
    const s2 = shell({ 'direct.result': { id: 'r', ok: true, state: 'done' } }); await expect(checkCommand(AGENT, pending, deps(s2.phoneCall))).resolves.toEqual({ kind: 'stopped' }); expect(serverCalls).toEqual([]); expect(s2.log.map((l) => l.type)).toEqual(['direct.result']);
  });
  it('«pending» is waited for; a call that does not answer is asked again; two minutes without an end is `unknown`', async () => {
    reset(); let n = 0; const s = shell({ 'command.sign': SIGN_STOP, ...direct((): PhoneAnswer => { n += 1; if (n === 1) return { id: 'r', ok: true, state: 'pending' }; if (n === 2) return { id: 'r', ok: false, code: 'bad_request' }; return { id: 'r', ok: true, state: 'done' }; }) });
    await expect(commandOnPhone(stop, deps(s.phoneCall))).resolves.toEqual({ kind: 'stopped' }); expect(n).toBe(3);
    reset(); let t = 0; const forever = shell({ 'command.sign': SIGN_STOP, ...direct({ id: 'r', ok: true, state: 'pending' }) });
    const out = await commandOnPhone(stop, deps(forever.phoneCall, { now: () => (t += 30_000), pollMaxMs: 120_000 })); expect(out.kind).toBe('unknown'); expect((out as { pending: Pending }).pending.direct).toEqual({ setupId: SETUP }); expect(serverCalls).toEqual([]); expect(forever.count('direct.result')).toBeLessThan(10); // (the two minutes are the CLOCK's: a clock that moves 30 s a call ends it after a handful of asks, not after the count belt)
  });
  it('a clock that does not move and a wait that takes no time cannot hold a press for ever: the asks are counted too (two minutes ÷ every 1.5 s, and two more)', async () => {
    reset(); const s = shell({ 'command.sign': SIGN_STOP, ...direct({ id: 'r', ok: true, state: 'pending' }) });
    const out = await commandOnPhone(stop, deps(s.phoneCall, { now: () => 1_000, wait: async () => {} })); expect(out.kind).toBe('unknown');
    expect(s.count('direct.result')).toBe(Math.ceil(120_000 / 1_500) + 2); expect(serverCalls).toEqual([]);
  });
  it('a bridge that accepts the question and never answers cannot hold a press: each ask has its own box (5 s) and the two minutes end it', async () => {
    reset(); vi.useFakeTimers();
    try {
      const s = shell({ 'command.sign': SIGN_STOP, ...direct(() => new Promise<PhoneAnswer>(() => {})) });
      const p = commandOnPhone(stop, deps(s.phoneCall, { wait: (ms) => new Promise<void>((r) => setTimeout(r, ms)) })); let done: unknown = null; void p.then((o) => { done = o; });
      await vi.advanceTimersByTimeAsync(119_000); expect(done).toBeNull(); await vi.advanceTimersByTimeAsync(20_000);
      expect(done).toMatchObject({ kind: 'unknown', pending: { direct: { setupId: SETUP } } }); expect(s.count('direct.result')).toBeGreaterThan(5); expect(serverCalls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it('the last ask is cut at the two minutes\' end: an ask near the end gets only what is left, and a wait that spends the time starts no ask', async () => {
    reset(); vi.useFakeTimers();
    try {
      const hung = () => shell({ 'command.sign': SIGN_STOP, ...direct(() => new Promise<PhoneAnswer>(() => {})) });
      // ten seconds, asked every second: every ask is boxed at 5 s, the last one at what is left — the whole press ends at 10 s, not at 12
      const a = hung(); const t0 = Date.now(); let ended = -1; const p = commandOnPhone(stop, deps(a.phoneCall, { pollMs: 1_000, pollMaxMs: 10_000, wait: (ms) => new Promise<void>((r) => setTimeout(r, ms)) })); void p.then(() => { ended = Date.now() - t0; });
      await vi.advanceTimersByTimeAsync(30_000); expect(ended).toBeGreaterThanOrEqual(9_000); expect(ended).toBeLessThanOrEqual(10_000);
      // a wait longer than the time that is left: the time is over when it ends, and no ask is made at all
      const b = hung(); const q = commandOnPhone(stop, deps(b.phoneCall, { pollMs: 2_000, pollMaxMs: 1_500, wait: (ms) => new Promise<void>((r) => setTimeout(r, ms)) })); await vi.advanceTimersByTimeAsync(10_000);
      await expect(q).resolves.toMatchObject({ kind: 'unknown' }); expect(b.count('direct.result')).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('a page that is hidden — a wait that never comes back — cannot hold the follow past the two minutes', async () => {
    reset(); vi.useFakeTimers();
    try {
      const s = shell({ 'command.sign': SIGN_STOP, ...direct({ id: 'r', ok: true, state: 'pending' }) });
      const t0 = Date.now(); let ended = -1; const p = commandOnPhone(stop, deps(s.phoneCall, { pollMs: 1_500, pollMaxMs: 20_000, wait: () => new Promise<void>(() => {}) })); void p.then((o) => { ended = Date.now() - t0; void o; });
      await vi.advanceTimersByTimeAsync(40_000); expect(ended).toBeGreaterThanOrEqual(19_000); expect(ended).toBeLessThanOrEqual(21_000); await expect(p).resolves.toMatchObject({ kind: 'unknown', pending: { direct: { setupId: SETUP } } });
    } finally { vi.useRealTimers(); }
  });
  it('a frozen command clock and a wait that takes no time cannot stretch the two minutes: the page\'s own clock ends it', async () => {
    reset(); vi.useFakeTimers();
    try {
      const s = shell({ 'command.sign': SIGN_STOP, ...direct(() => new Promise<PhoneAnswer>(() => {})) });
      const t0 = Date.now(); let ended = -1; const p = commandOnPhone(stop, deps(s.phoneCall, { now: () => 1_000, wait: async () => {}, pollMaxMs: 120_000 })); void p.then(() => { ended = Date.now() - t0; });
      await vi.advanceTimersByTimeAsync(600_000); expect(ended).toBeGreaterThanOrEqual(115_000); expect(ended).toBeLessThanOrEqual(125_000); await expect(p).resolves.toMatchObject({ kind: 'unknown' });
    } finally { vi.useRealTimers(); }
  });
  it('a bridge that throws on the way to a press never loses it: the server gets it (a sign that works · the road calls that throw)', async () => {
    reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'done' }));
    const phoneCall = ((type: string): Promise<PhoneAnswer> => { if (type === 'command.sign') return Promise.resolve(SIGN_STOP); throw new Error('the bridge threw'); }) as CommandDeps['phoneCall'];
    await expect(commandOnPhone(stop, deps(phoneCall))).resolves.toEqual({ kind: 'stopped' }); expect(serverCalls.filter((c) => c.init?.method === 'POST').length).toBe(1);
  });
  it('a word the page does not know is not an end: it is asked again', async () => {
    reset(); let n = 0; const s = shell({ 'command.sign': SIGN_STOP, ...direct((): PhoneAnswer => { n += 1; return n === 1 ? { id: 'r', ok: true, state: 'acked' } : { id: 'r', ok: true, state: 'done' }; }) });
    await expect(commandOnPhone(stop, deps(s.phoneCall))).resolves.toEqual({ kind: 'stopped' }); expect(n).toBe(2);
  });
});
