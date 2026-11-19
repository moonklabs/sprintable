// story #4534 — every way a stop or an instruction from the phone app ends maps to one outcome (contract 48616ee0 v0.3 · 02d2cf71 §11 ②).
import { describe, expect, it, vi } from 'vitest';
import { checkCommand, commandOnPhone, type CommandDeps, type Pending } from './phone-command';
import type { PhoneAnswer } from './phone-bridge';

let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));

const AGENT = '22222222-3333-4444-8555-666666666666';
const CONV = '33333333-4444-4555-8666-777777777777';
const OTHER_CONV = '99999999-4444-4555-8666-777777777777';
const CMD = '44444444-5555-4666-8777-888888888888';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

/** a server: the POST answer, then the polls' answers in order (the last repeats) */
function server(post: Response | (() => Response), polls: Array<Response | (() => Response)> = []) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  currentFetch = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === 'POST') return typeof post === 'function' ? post() : post;
    const r = polls[Math.min(i++, polls.length - 1)];
    if (!r) throw new Error('no poll answer');
    return typeof r === 'function' ? r() : r;
  };
  return calls;
}
const deps = (answer: PhoneAnswer, extra: Partial<CommandDeps> = {}) => {
  const sent: string[] = [];
  const d: CommandDeps & { sent: string[]; phoneCall: ReturnType<typeof vi.fn> } = {
    phoneCall: vi.fn(async () => answer),
    sendMessage: async (t: string) => { sent.push(t); return true; },
    newKey: () => 'idem-1',
    wait: async () => {},
    sent,
    ...extra,
  } as never;
  return d;
};
const signedPrompt: PhoneAnswer = { id: 'w1', ok: true, signed: 'SIGNED', phone_key_id: 'k-1', session_key: 's-9', text: 'ls  then stop' };
const signedStop: PhoneAnswer = { id: 'w2', ok: true, signed: 'SIGNED-S', phone_key_id: 'k-1', session_key: 's-9' };
const prompt = { agentId: AGENT, kind: 'send_prompt' as const, text: 'ls \u202ethen stop', conversationId: CONV };
const stop = { agentId: AGENT, kind: 'stop_session' as const };

describe('[4534] commandOnPhone — what the web asks and posts', () => {
  it('an instruction: the shell gets agent · kind · text · conversation only; the post carries the shell\'s session_key and the text it showed', async () => {
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done', result_code: null })]);
    const d = deps(signedPrompt);
    await expect(commandOnPhone(prompt, d)).resolves.toEqual({ kind: 'sent_now' });
    expect(d.phoneCall).toHaveBeenCalledWith('command.sign', { agent_member_id: AGENT, kind: 'send_prompt', text: prompt.text, conversation_id: CONV });
    expect(calls[0]!.url).toBe(`/api/agents/${AGENT}/desktop-commands`);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      kind: 'send_prompt', idempotency_key: 'idem-1', session_key: 's-9', signed: 'SIGNED', phone_key_id: 'k-1', text: 'ls  then stop', conversation_id: CONV,
    });
    expect(calls[1]!.url).toBe(`/api/agents/${AGENT}/desktop-commands/${CMD}`);
  });

  it('a stop: no text, no conversation — to the shell or the server', async () => {
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done' })]);
    const d = deps(signedStop);
    await expect(commandOnPhone(stop, d)).resolves.toEqual({ kind: 'stopped' });
    expect(d.phoneCall).toHaveBeenCalledWith('command.sign', { agent_member_id: AGENT, kind: 'stop_session' });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ kind: 'stop_session', idempotency_key: 'idem-1', session_key: 's-9', signed: 'SIGNED-S', phone_key_id: 'k-1' });
  });

  // story 4943 (PO 11-14 ③ A): the daemon stopped the turn but a command Claude put in the background still runs — the result says so, the line stays true
  it('a stop done with commands_running → «stopped_commands_running» (not «stopped»); a plain done → stopped; an end is never it', async () => {
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done', result_code: 'commands_running' })]);
    await expect(commandOnPhone(stop, deps(signedStop))).resolves.toEqual({ kind: 'stopped_commands_running' });
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done' })]);
    await expect(commandOnPhone(stop, deps(signedStop))).resolves.toEqual({ kind: 'stopped' });
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done', result_code: 'commands_running' })]);
    await expect(commandOnPhone({ agentId: AGENT, kind: 'end_session' }, deps({ ...signedStop, kind: 'end_session' }))).resolves.toEqual({ kind: 'ended' });
  });

  // story #4599 (contract v1.13.2 · PO 14:08Z · 14:25Z · Min 387): an end of the whole session — its own kind, signed as such
  it('an end: the shell gets agent · kind end_session; the post carries the kind the shell signed (never a stop) · done → ended', async () => {
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done' })]);
    const d = deps({ ...signedStop, kind: 'end_session' });
    await expect(commandOnPhone({ agentId: AGENT, kind: 'end_session' }, d)).resolves.toEqual({ kind: 'ended' });
    expect(d.phoneCall).toHaveBeenCalledWith('command.sign', { agent_member_id: AGENT, kind: 'end_session' });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ kind: 'end_session', idempotency_key: 'idem-1', session_key: 's-9', signed: 'SIGNED-S', phone_key_id: 'k-1' });
    // a shell from before says no kind → the kind that was asked
    const calls2 = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done' })]);
    await expect(commandOnPhone({ agentId: AGENT, kind: 'end_session' }, deps(signedStop))).resolves.toEqual({ kind: 'ended' });
    expect(JSON.parse(calls2[0]!.init!.body as string).kind).toBe('end_session');
  });

  it('a stop refused because a macOS window holds the turn (409 system_wait_end_only · or the daemon\'s rejected with the same word) → its own outcome, nothing as a message', async () => {
    const d = deps(signedStop);
    server(json(409, { error: { code: 'system_wait_end_only' } }));
    await expect(commandOnPhone(stop, d)).resolves.toEqual({ kind: 'system_wait_end_only' });
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'delivered' }), json(200, { state: 'rejected', result_code: 'system_wait_end_only' })]);
    await expect(commandOnPhone(stop, d)).resolves.toEqual({ kind: 'system_wait_end_only' });
    expect(d.sent).toEqual([]);
  });

  // story #4599 (Yuna · PO 19:47Z): the shell signs no end when the window was answered on that Mac first (phoneCalls.js `not_held`)
  it('an end the shell refuses `not_held` (the window was answered on that Mac first) → its own outcome — never failed, nothing posted', async () => {
    const calls = server(json(201, { command_id: CMD, state: 'queued' }));
    const d = deps({ id: 'w', ok: false, code: 'not_held' } as PhoneAnswer);
    await expect(commandOnPhone({ agentId: AGENT, kind: 'end_session' }, d)).resolves.toEqual({ kind: 'not_held' }); // mutant: the code unknown → failed → RED
    expect(calls).toEqual([]);
    expect(d.sent).toEqual([]);
  });

  it('a shell answer missing what must be posted → failed, nothing posted', async () => {
    for (const a of [{ ...signedPrompt, session_key: undefined }, { ...signedPrompt, text: undefined }, { ...signedPrompt, signed: undefined }]) {
      const calls = server(json(201, {}));
      await expect(commandOnPhone(prompt, deps(a as PhoneAnswer))).resolves.toEqual({ kind: 'failed' });
      expect(calls).toEqual([]);
    }
  });
});

describe('[4534] commandOnPhone — the ends', () => {
  it('done after_step → «… 단계를 마치면 바로 들어가요» · queued/delivered/acked are waited through', async () => {
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'delivered' }), json(200, { state: 'acked' }), json(200, { state: 'done', result_code: 'after_step' })]);
    await expect(commandOnPhone(prompt, deps(signedPrompt))).resolves.toEqual({ kind: 'sent_after_step' });
  });

  it('the turn had ended — the instruction goes in as a message (the shell\'s text, once): the shell · the server (409) · the daemon (rejected)', async () => {
    let d = deps({ id: 'w', ok: false, code: 'not_working' });
    server(json(201, {}));
    // story 4633: the typed text holds a bidi override (U+202E) — the same check that the daemon runs refuses it; nothing goes to the chat
    await expect(commandOnPhone(prompt, d)).resolves.toEqual({ kind: 'hidden_text' });
    expect(d.sent).toEqual([]);

    d = deps(signedPrompt);
    server(json(409, { error: { code: 'session_not_working' } }));
    await expect(commandOnPhone(prompt, d)).resolves.toEqual({ kind: 'sent_as_message' });
    expect(d.sent).toEqual(['ls  then stop']);

    d = deps(signedPrompt);
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'rejected', result_code: 'session_not_working' })]);
    await expect(commandOnPhone(prompt, d)).resolves.toEqual({ kind: 'sent_as_message' });
    expect(d.sent).toEqual(['ls  then stop']);
  });

  it('the message could not be sent either → failed (the line says press again)', async () => {
    server(json(409, { error: { code: 'session_not_working' } }));
    await expect(commandOnPhone(prompt, deps(signedPrompt, { sendMessage: async () => false }))).resolves.toEqual({ kind: 'failed' });
  });

  it('a stop on nothing working: the shell · the server\'s 200 already_stopped · the daemon — «이미 멈춰 있었어요», nothing sent as a message', async () => {
    let d = deps({ id: 'w', ok: false, code: 'not_working' });
    await expect(commandOnPhone(stop, d)).resolves.toEqual({ kind: 'already_stopped' });
    d = deps({ id: 'w', ok: false, code: 'no_session' });
    await expect(commandOnPhone(stop, d)).resolves.toEqual({ kind: 'already_stopped' });
    d = deps(signedStop);
    server(json(200, { state: 'already_stopped' }));
    await expect(commandOnPhone(stop, d)).resolves.toEqual({ kind: 'already_stopped' });
    d = deps(signedStop);
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'rejected', result_code: 'session_not_working' })]);
    await expect(commandOnPhone(stop, d)).resolves.toEqual({ kind: 'already_stopped' });
    expect(d.sent).toEqual([]);
  });

  it('Kadir 4955: no end in two minutes on the WALL clock → unknown (never «not sent») · nothing sent as a message · a failed read is asked again', async () => {
    // each poll takes 31 s of wall time (a slow fetch): the two minutes end after 4 polls, not 80
    let t = 0;
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(503), () => json(200, { state: 'delivered' })]);
    const d = deps(signedPrompt, { now: () => t, wait: async (ms) => { t += ms + 29_500; } });
    const out = await commandOnPhone(prompt, d);
    expect(out.kind).toBe('unknown');
    expect(calls.filter((c) => c.init?.method !== 'POST').length).toBe(4);
    expect(d.sent).toEqual([]);
    expect(out.kind === 'unknown' && out.pending).toEqual({ verb: 'send', key: 'idem-1', commandId: CMD, body: { kind: 'send_prompt', session_key: 's-9', signed: 'SIGNED', phone_key_id: 'k-1', text: 'ls  then stop', conversation_id: CONV } });
  });

  it('Kadir 4955: the post\'s answer lost (network · 5xx without a word · no id) → unknown, nothing as a message', async () => {
    for (const post of [() => { throw new TypeError('network'); }, () => json(502), () => json(201, {})] as Array<() => Response>) {
      const d = deps(signedPrompt);
      server(post);
      const out = await commandOnPhone(prompt, d);
      expect(out.kind).toBe('unknown');
      expect(out.kind === 'unknown' && out.pending.commandId).toBeUndefined();
      expect(d.sent).toEqual([]);
    }
  });

  it('Kadir 4955 (5981640479): a 5xx WITH a code (the backend\'s INTERNAL_ERROR envelope · a proxy timeout) is unknown too — kept, never failed', async () => {
    for (const post of [() => json(500, { error: { code: 'INTERNAL_ERROR' } }), () => json(504, { error: { code: 'upstream_timeout' } }), () => json(503, { code: 'unavailable' })] as Array<() => Response>) {
      const d = deps(signedPrompt);
      server(post);
      const out = await commandOnPhone(prompt, d);
      expect(out.kind).toBe('unknown');
      expect(out.kind === 'unknown' && out.pending.key).toBe('idem-1');
      expect(d.sent).toEqual([]);
    }
  });

  // story 4943 (codex r1 LOW): the lost-answer re-check and a send never turn commands_running into anything else
  it('[결과 확인] a stop whose answer was lost: the re-check reads done + commands_running → stopped_commands_running; the same code on a SEND is just sent_now', async () => {
    const knownStop: Pending = { verb: 'stop', key: 'idem-1', commandId: CMD, body: { kind: 'stop_session', session_key: 's-9', signed: 'SIGNED', phone_key_id: 'k-1' } };
    server(json(201, {}), [json(200, { state: 'done', result_code: 'commands_running' })]);
    await expect(checkCommand(AGENT, knownStop, deps(signedStop))).resolves.toEqual({ kind: 'stopped_commands_running' });
    const knownSend: Pending = { verb: 'send', key: 'idem-2', commandId: CMD, body: { kind: 'send_prompt', session_key: 's-9', signed: 'SIGNED', phone_key_id: 'k-1', text: 'go', conversation_id: CONV } };
    server(json(201, {}), [json(200, { state: 'done', result_code: 'commands_running' })]);
    await expect(checkCommand(AGENT, knownSend, deps(signedPrompt))).resolves.toEqual({ kind: 'sent_now' });
  });

  it('[결과 확인] follows THAT command: its id → polls only (no post · no signature) · no id yet → the same key and body again', async () => {
    const known: Pending = { verb: 'send', key: 'idem-1', commandId: CMD, body: { kind: 'send_prompt', session_key: 's-9', signed: 'SIGNED', phone_key_id: 'k-1', text: 'go', conversation_id: CONV } };
    let calls = server(json(201, {}), [json(200, { state: 'done', result_code: 'after_step' })]);
    let d = deps(signedPrompt);
    await expect(checkCommand(AGENT, known, d)).resolves.toEqual({ kind: 'sent_after_step' });
    expect(d.phoneCall).not.toHaveBeenCalled();
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    expect(calls[0]!.url).toBe(`/api/agents/${AGENT}/desktop-commands/${CMD}`);

    const unsure: Pending = { ...known, commandId: undefined };
    calls = server(json(201, { command_id: CMD, state: 'done' }), [json(200, { state: 'done' })]);
    d = deps(signedPrompt);
    await expect(checkCommand(AGENT, unsure, d)).resolves.toEqual({ kind: 'sent_now' });
    expect(d.phoneCall).not.toHaveBeenCalled();
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ ...unsure.body, idempotency_key: 'idem-1' }); // the same key — the server gives back its command
  });

  it('rejected or failed for another reason → failed', async () => {
    for (const r of [{ state: 'rejected', result_code: 'bad_signature' }, { state: 'failed', result_code: 'error' }]) {
      server(json(201, { command_id: CMD, state: 'queued' }), [json(200, r)]);
      await expect(commandOnPhone(prompt, deps(signedPrompt))).resolves.toEqual({ kind: 'failed' });
    }
  });

  it.each([
    ['cancelled', 'cancelled'], ['biometric_required', 'biometric_required'], ['no_screen_lock', 'no_screen_lock'],
    ['key_invalidated', 'key_invalidated'], ['no_key', 'not_paired'], ['not_registered', 'not_registered'], ['signed_out', 'signed_out'], // [SID:4834] no_key = never paired
    ['remote_control_off', 'remote_off'], ['conversation_not_found', 'conversation_not_found'],
    ['sign_failed', 'failed'], ['bad_request', 'failed'], ['not_phone_app', 'failed'], ['timeout', 'failed'],
  ])('the shell says %s → %s, nothing posted', async (code, kind) => {
    const calls = server(json(201, {}));
    await expect(commandOnPhone(prompt, deps({ id: 'w', ok: false, code }))).resolves.toEqual({ kind });
    expect(calls).toEqual([]);
  });

  it.each([
    ['device_unreachable', 'unreachable'], ['remote_control_off', 'remote_off'], ['conversation_not_found', 'conversation_not_found'],
    ['phone_not_paired', 'not_paired'], ['not_allowed_to_command', 'failed'], ['invalid_payload', 'failed'],
  ])('the server refuses %s → %s', async (code, kind) => {
    server(json(409, { error: { code } }));
    await expect(commandOnPhone(prompt, deps(signedPrompt))).resolves.toEqual({ kind });
  });
});

// ── story 4976 A3: the instruction goes SEALED when the shell says it can ───────────────────────────────────────────────────────────────────────────────────
describe('[4976 A3] a sealed instruction — the words never leave the phone app but as an envelope', () => {
  const MARK = 'MK4976webwords';
  const typed = { agentId: AGENT, kind: 'send_prompt' as const, text: `run ${MARK}`, conversationId: CONV, computerOpensSealed: true };
  const ENV = { v: 1, kind: 'send_prompt', setup_id: 'setup', session_key: 's-9', command_id: 'idem-1', from: 'k-1', ct: 'AAAA' };
  const sealedAnswer: PhoneAnswer = { id: 'w', ok: true, sealed: true, envelope: ENV, phone_key_id: 'k-1', session_key: 's-9', conversation_id: CONV };
  const CAPS: PhoneAnswer = { id: 'c', ok: true, caps: { sealed_prompt: 1 } };
  /** a shell by call type: `caps` answers shell.caps; `signs` answers the command.sign calls in order (the last repeats) */
  const shell = (caps: PhoneAnswer | Error, signs: PhoneAnswer[], extra: Partial<CommandDeps> = {}) => {
    let i = 0;
    const phoneCall = vi.fn(async (type: string, _args?: unknown) => {
      if (type === 'shell.caps') { if (caps instanceof Error) throw caps; return caps; }
      return signs[Math.min(i++, signs.length - 1)]!;
    });
    const sent: string[] = [];
    let k = 0;
    const d = { phoneCall, sendMessage: async (t: string) => { sent.push(t); return true; }, newKey: () => `idem-${++k}`, wait: async () => {}, sent, ...extra } as unknown as CommandDeps & { sent: string[]; phoneCall: typeof phoneCall };
    return d;
  };
  const signCalls = (d: { phoneCall: ReturnType<typeof vi.fn> }) => d.phoneCall.mock.calls.filter((c) => c[0] === 'command.sign');

  it('a shell that can seal: the shell gets the press key first · the post is {kind, session_key, conversation_id, envelope, phone_key_id, idempotency_key} — no text, no signed — and the words are in no byte of it', async () => {
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done', result_code: null })]);
    const d = shell(CAPS, [sealedAnswer]);
    await expect(commandOnPhone(typed, d)).resolves.toEqual({ kind: 'sent_now' });
    expect(signCalls(d)).toEqual([['command.sign', { agent_member_id: AGENT, kind: 'send_prompt', text: typed.text, conversation_id: CONV, sealed: true, idempotency_key: 'idem-1' }]]);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toEqual({ kind: 'send_prompt', idempotency_key: 'idem-1', session_key: 's-9', conversation_id: CONV, envelope: ENV, phone_key_id: 'k-1' });
    expect(d.phoneCall.mock.calls.filter((c) => c[0] === 'command.sign')[0]![1]).toHaveProperty('idempotency_key', body.idempotency_key); // the key the shell sealed into the header is the key posted
    expect(Object.keys(body)).not.toContain('text');
    expect(Object.keys(body)).not.toContain('signed');
    expect(calls.map((c) => String(c.init?.body ?? '')).join('')).not.toContain(MARK);
    expect(d.sent).toEqual([]);
  });

  it('a shell that cannot (old shell: the question is refused · answers without the flag · flag 0 · the question throws) → the plain road exactly as before, never `sealed`', async () => {
    for (const caps of [{ id: 'c', ok: false, code: 'bad_request' }, { id: 'c', ok: true }, { id: 'c', ok: true, caps: {} }, { id: 'c', ok: true, caps: { sealed_prompt: 0 } }, { id: 'c', ok: true, caps: { sealed_prompt: '1' } }, new Error('no bridge')] as Array<PhoneAnswer | Error>) {
      const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done' })]);
      const d = shell(caps, [signedPrompt]);
      await expect(commandOnPhone(typed, d)).resolves.toEqual({ kind: 'sent_now' });
      expect(signCalls(d)).toEqual([['command.sign', { agent_member_id: AGENT, kind: 'send_prompt', text: typed.text, conversation_id: CONV }]]);
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ kind: 'send_prompt', idempotency_key: 'idem-1', session_key: 's-9', signed: 'SIGNED', phone_key_id: 'k-1', text: 'ls  then stop', conversation_id: CONV });
    }
  });

  it('a computer that did not say its app opens a sealed instruction (absent · false · null — an app from before) → the plain road, and the shell is not even asked what it can do', async () => {
    for (const flag of [undefined, false] as const) {
      const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done' })]);
      const d = shell(CAPS, [signedPrompt]);
      await expect(commandOnPhone({ ...typed, computerOpensSealed: flag }, d)).resolves.toEqual({ kind: 'sent_now' });
      expect(d.phoneCall.mock.calls.map((c) => c[0])).toEqual(['command.sign']);
      expect(signCalls(d)[0]![1]).not.toHaveProperty('sealed');
      expect(JSON.parse(calls[0]!.init!.body as string)).toHaveProperty('signed', 'SIGNED');
    }
  });

  it('a stop and an end never ask `shell.caps` and never go sealed', async () => {
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done' })]);
    const d = shell(CAPS, [signedStop]);
    await commandOnPhone(stop, d);
    expect(d.phoneCall.mock.calls.map((c) => c[0])).toEqual(['command.sign']);
  });

  it('the shell cannot seal for THIS computer (host_not_pinned · host_not_sealing): the same words then go the plain road — a second sign, without `sealed`', async () => {
    for (const code of ['host_not_pinned', 'host_not_sealing']) {
      const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done' })]);
      const d = shell(CAPS, [{ id: 'w', ok: false, code }, signedPrompt]);
      await expect(commandOnPhone(typed, d)).resolves.toEqual({ kind: 'sent_now' });
      expect(signCalls(d).map((c) => (c[1] as { sealed?: boolean }).sealed)).toEqual([true, undefined]);
      expect(JSON.parse(calls[0]!.init!.body as string)).toHaveProperty('signed', 'SIGNED');
    }
  });

  it('every other refusal of a sealing shell is its own line — a vault that does not answer is «failed» (never a quiet drop to the plain road) · too_long · cancelled · key refusals · the turn ended → the words go as a message', async () => {
    const cases: Array<[string, unknown]> = [['vault_unavailable', { kind: 'failed' }], ['bad_request', { kind: 'failed' }], ['too_long', { kind: 'too_long' }], ['cancelled', { kind: 'cancelled' }], ['biometric_required', { kind: 'biometric_required' }],
      ['no_screen_lock', { kind: 'no_screen_lock' }], ['key_invalidated', { kind: 'key_invalidated' }], ['not_registered', { kind: 'not_registered' }], ['remote_control_off', { kind: 'remote_off' }], ['conversation_not_found', { kind: 'conversation_not_found' }], ['no_key', { kind: 'not_paired' }]];
    for (const [code, outcome] of cases) {
      const calls = server(json(500));
      const d = shell(CAPS, [{ id: 'w', ok: false, code }, signedPrompt]);
      await expect(commandOnPhone(typed, d)).resolves.toEqual(outcome);
      expect(signCalls(d)).toHaveLength(1);
      expect(calls).toHaveLength(0); // nothing was posted
    }
    for (const code of ['not_working', 'no_session']) {
      const d = shell(CAPS, [{ id: 'w', ok: false, code }]);
      await expect(commandOnPhone(typed, d)).resolves.toEqual({ kind: 'sealed_not_taken' });
      expect(d.sent).toEqual([]); // never quietly turned into a chat message
    }
  });

  it('an answer that is not exactly a sealed one (flag missing · no envelope · a list · another room · no key id · no session) is «failed» and nothing is posted', async () => {
    for (const bad of [{ ...sealedAnswer, sealed: undefined }, { ...sealedAnswer, envelope: undefined }, { ...sealedAnswer, envelope: [ENV] }, { ...sealedAnswer, envelope: 'x' }, { ...sealedAnswer, conversation_id: OTHER_CONV }, { ...sealedAnswer, phone_key_id: undefined }, { ...sealedAnswer, session_key: undefined }] as PhoneAnswer[]) {
      const calls = server(json(500));
      await expect(commandOnPhone(typed, shell(CAPS, [bad]))).resolves.toEqual({ kind: 'failed' });
      expect(calls).toHaveLength(0);
    }
  });

  it('the turn had ended (the Mac says so · the server says so) or the session cannot take it into the turn now → «sealed_not_taken»: NOT sent as a chat message (that would put the words on the server in the clear)', async () => {
    for (const poll of [{ state: 'rejected', result_code: 'session_not_working' }, { state: 'rejected', result_code: 'instruct_not_now' }]) {
      server(json(201, { command_id: CMD, state: 'queued' }), [json(200, poll)]);
      const d = shell(CAPS, [sealedAnswer]);
      await expect(commandOnPhone(typed, d)).resolves.toEqual({ kind: 'sealed_not_taken' });
      expect(d.sent).toEqual([]);
    }
    for (const code of ['session_not_working', 'session_not_found']) {
      server(json(409, { error: { code } }));
      const d = shell(CAPS, [sealedAnswer]);
      await expect(commandOnPhone(typed, d)).resolves.toEqual({ kind: 'sealed_not_taken' });
      expect(d.sent).toEqual([]);
    }
    // …while the PLAIN road keeps what it always did (its words are in the body the person signed): a message
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'rejected', result_code: 'session_not_working' })]);
    const plain = shell({ id: 'c', ok: false, code: 'bad_request' }, [signedPrompt]);
    await expect(commandOnPhone(typed, plain)).resolves.toEqual({ kind: 'sent_as_message' });
    expect(plain.sent).toEqual(['ls  then stop']);
  });

  it('the Mac refuses a sealed instruction for its length or its hidden characters → their own lines (no message, no retry)', async () => {
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'rejected', result_code: 'instruct_too_long' })]);
    const d = shell(CAPS, [sealedAnswer]);
    await expect(commandOnPhone(typed, d)).resolves.toEqual({ kind: 'too_long' });
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'rejected', result_code: 'instruct_hidden_text' })]);
    const d2 = shell(CAPS, [sealedAnswer]);
    await expect(commandOnPhone(typed, d2)).resolves.toEqual({ kind: 'hidden_text' });
    expect(d.sent.concat(d2.sent)).toEqual([]);
  });

  it('an end the web cannot see → «unknown» holds the SAME body and key (no words held); [결과 확인] posts them again — no new sign, no new key, no words in the post', async () => {
    currentFetch = async () => { throw new Error('offline'); };
    const d = shell(CAPS, [sealedAnswer]);
    const first = await commandOnPhone(typed, d);
    expect(first.kind).toBe('unknown');
    const pending = (first as { pending: Pending }).pending;
    expect(pending.key).toBe('idem-1');
    expect(pending.sealed).toBe(true);
    expect(JSON.stringify(pending)).not.toContain(MARK); // the web keeps no copy of the words in what it holds for [결과 확인]
    expect(Object.keys(pending.body).sort()).toEqual(['conversation_id', 'envelope', 'kind', 'phone_key_id', 'session_key']);
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done' })]);
    await expect(checkCommand(AGENT, pending, d)).resolves.toEqual({ kind: 'sent_now' });
    expect(signCalls(d)).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.idempotency_key).toBe('idem-1');
    expect(body.envelope).toEqual(ENV);
    expect(calls.map((c) => String(c.init?.body ?? '')).join('')).not.toContain(MARK);
  });

  it('the server refuses the envelope (422 envelope_header_mismatch · another 4xx) → «failed» (nothing was made); a 5xx → unknown (kept, followed with the same key)', async () => {
    server(json(422, { error: { code: 'envelope_header_mismatch' } }));
    await expect(commandOnPhone(typed, shell(CAPS, [sealedAnswer]))).resolves.toEqual({ kind: 'failed' });
    server(json(502));
    const r = await commandOnPhone(typed, shell(CAPS, [sealedAnswer]));
    expect(r.kind).toBe('unknown');
  });
});
