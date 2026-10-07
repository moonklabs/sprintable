// story #4534 — every way a stop or an instruction from the phone app ends maps to one outcome (contract 48616ee0 v0.3 · 02d2cf71 §11 ②).
import { describe, expect, it, vi } from 'vitest';
import { checkCommand, commandOnPhone, type CommandDeps, type Pending } from './phone-command';
import type { PhoneAnswer } from './phone-bridge';

let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));

const AGENT = '22222222-3333-4444-8555-666666666666';
const CONV = '33333333-4444-4555-8666-777777777777';
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
    await expect(commandOnPhone(prompt, d)).resolves.toEqual({ kind: 'sent_as_message' });
    expect(d.sent).toEqual([prompt.text]); // the shell gave no text back — the typed one, never lost

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
    ['key_invalidated', 'key_invalidated'], ['not_registered', 'not_registered'], ['signed_out', 'signed_out'],
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
