// story #4733 (S4b) — session management from the phone app: what the web asks the shell, what it posts, how every end maps to one outcome, and what of the
// computer's closed view the screen keeps (copy yuna/4733-phone-clock-copy-1020.md · design §7 · §9).
import { describe, expect, it, vi } from 'vitest';
import { CLOCK_RESULTS, checkPress, editClock, parseClockRead, pressClock, readClock, type Pending, type PressDeps } from './phone-clock';
import { beginFlow, endFlow } from './phone-start';
import type { PhoneAnswer } from './phone-bridge';

let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));

const SETUP = '11111111-2222-4333-8444-555555555555';
const AGENT = '22222222-3333-4444-8555-666666666666';
const KEY = '99999999-9999-4999-8999-999999999999';
const CMD = '44444444-5555-4666-8777-888888888888';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const WHOLE = { setupId: SETUP, action: 'out_open' as const };
const ONE = { setupId: SETUP, action: 'in' as const, agentId: AGENT };

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
// a server that answers every GET with one thing (the read tests ask no POST)
function serverGet(answer: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  currentFetch = async (url, init) => { calls.push({ url, init }); return answer(); };
  return calls;
}

const signed: PhoneAnswer = { id: 'w1', ok: true, signed: 'SIGNED', phone_key_id: KEY };
const deps = (answer: PhoneAnswer, extra: Partial<PressDeps> = {}) =>
  ({ phoneCall: vi.fn(async () => answer), newKey: () => 'idem-1', wait: async () => {}, ...extra }) as PressDeps & { phoneCall: ReturnType<typeof vi.fn> };

describe('[4733 S4b] pressClock — what the web asks and posts', () => {
  it('[4734 B] the whole-computer press signs and posts the mark `computer: true` (no agent); the mark with an agent signs nothing; an older shell\'s refusal is `app_too_old` (nothing posted) — and only for the mark', async () => {
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done', result_code: 'ok' })]);
    const d = deps(signed);
    await expect(pressClock({ ...WHOLE, computer: true }, d)).resolves.toEqual({ kind: 'done', result: 'ok' });
    expect(d.phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'out_open', computer: true });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ action: 'out_open', signed: 'SIGNED', phone_key_id: KEY, computer: true, idempotency_key: 'idem-1' });
    const d2 = deps(signed);
    await expect(pressClock({ ...WHOLE, agentId: AGENT, computer: true }, d2)).resolves.toEqual({ kind: 'failed' });
    expect(d2.phoneCall).not.toHaveBeenCalled();
    const old = server(json(201, {}), []);
    const d3 = deps({ id: 's', ok: false, code: 'bad_request' } as PhoneAnswer);
    await expect(pressClock({ ...WHOLE, computer: true }, d3)).resolves.toEqual({ kind: 'app_too_old' });
    await expect(pressClock(WHOLE, deps({ id: 's', ok: false, code: 'bad_request' } as PhoneAnswer))).resolves.toEqual({ kind: 'failed' }); // (an unmarked press keeps its old word)
    expect(old).toHaveLength(0);
  });

  it('the shell gets the kind, the computer, the action (and the agent for one agent) — nothing else; the post carries the action + the shell\'s two values + the key', async () => {
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done', result_code: 'ok' })]);
    const d = deps(signed);
    await expect(pressClock(WHOLE, d)).resolves.toEqual({ kind: 'done', result: 'ok' });
    expect(d.phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'out_open' });
    expect(calls[0]!.url).toBe(`/api/desktop/setups/${SETUP}/clock`);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ action: 'out_open', signed: 'SIGNED', phone_key_id: KEY, idempotency_key: 'idem-1' });
    expect(calls[1]!.url).toBe(`/api/desktop/setups/${SETUP}/clock/commands/${CMD}`);
  });

  it('one agent: the agent id goes to the shell and into the post; the whole-computer press has NO agent key at all (not null, not empty)', async () => {
    const calls = server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: 'ok' })]);
    const d = deps(signed);
    await pressClock(ONE, d);
    expect(d.phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'in', agent_member_id: AGENT });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ action: 'in', signed: 'SIGNED', phone_key_id: KEY, agent_member_id: AGENT, idempotency_key: 'idem-1' });
    const calls2 = server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: 'ok' })]);
    const d2 = deps(signed);
    await pressClock(WHOLE, d2);
    expect(Object.keys(d2.phoneCall.mock.calls[0]![1]).sort()).toEqual(['action', 'kind', 'setup_id']);
    expect('agent_member_id' in JSON.parse(calls2[0]!.init!.body as string)).toBe(false);
  });

  it('never a text · name · path · expiry — a closed set of keys on the shell call and on the post', async () => {
    const calls = server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: 'ok' })]);
    const d = deps(signed);
    await pressClock(ONE, d);
    expect(Object.keys(d.phoneCall.mock.calls[0]![1]).sort()).toEqual(['action', 'agent_member_id', 'kind', 'setup_id']);
    expect(Object.keys(JSON.parse(calls[0]!.init!.body as string)).sort()).toEqual(['action', 'agent_member_id', 'idempotency_key', 'phone_key_id', 'signed']);
  });

  it.each(CLOCK_RESULTS.map((r) => [r]))('the computer ends the command with «%s» → done with that word', async (result) => {
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: result })]);
    await expect(pressClock(WHOLE, deps(signed))).resolves.toEqual({ kind: 'done', result });
  });

  it('a done with a word this page does not know (or none) is NOT read as a success', async () => {
    for (const result_code of ['something_new', null, '']) {
      server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code })]);
      await expect(pressClock(WHOLE, deps(signed))).resolves.toEqual({ kind: 'failed' });
    }
  });

  it.each([
    ['cancelled', 'cancelled'], ['biometric_required', 'biometric_required'], ['no_screen_lock', 'no_screen_lock'], ['key_invalidated', 'key_invalidated'],
    ['not_registered', 'not_registered'], ['signed_out', 'signed_out'], ['remote_control_off', 'remote_off'], ['computer_not_found', 'not_paired'],
    ['device_unreachable', 'unreachable'], ['not_allowed', 'not_allowed'], ['agent_not_found', 'failed'], ['sign_failed', 'failed'], ['bad_request', 'failed'], ['something_new', 'failed'],
  ])('the shell says %s → %s, and nothing is posted', async (code, kind) => {
    const calls = server(json(201, {}));
    await expect(pressClock(WHOLE, deps({ id: 'w1', ok: false, code }))).resolves.toEqual({ kind });
    expect(calls).toHaveLength(0);
  });

  it('a bridge call that is rejected, or an answer without the two values, is failed — nothing posted', async () => {
    const calls = server(json(201, {}));
    const bad = { ...deps(signed), phoneCall: vi.fn(async () => { throw new Error('bridge'); }) } as PressDeps;
    await expect(pressClock(WHOLE, bad)).resolves.toEqual({ kind: 'failed' });
    await expect(pressClock(WHOLE, deps({ id: 'w', ok: true }))).resolves.toEqual({ kind: 'failed' });
    await expect(pressClock(WHOLE, deps({ id: 'w', ok: true, signed: 'S' }))).resolves.toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [409, { error: { code: 'device_unreachable' } }, 'unreachable'], [409, { error: { code: 'remote_control_off' } }, 'remote_off'], [409, { error: { code: 'phone_not_paired' } }, 'not_paired'],
    [403, { error: { code: 'not_allowed_to_command' } }, 'not_allowed'], [403, { error: { code: 'person_session_required' } }, 'not_allowed'], [422, { error: { code: 'bad_request' } }, 'failed'], [404, {}, 'failed'],
  ])('the post is refused %s %j → %s (refused before anything was made — nothing followed)', async (status, body, kind) => {
    const calls = server(json(status, body));
    await expect(pressClock(WHOLE, deps(signed))).resolves.toEqual({ kind });
    expect(calls).toHaveLength(1);
  });

  it('a 5xx, a lost answer, or an answer that is no command may have gone: unknown with the SAME key and body — never failed, never reposted by itself', async () => {
    for (const post of [() => json(500, {}), () => json(502), () => { throw new Error('network'); }, () => json(201, 'not json'), () => json(201, null), () => json(201, { state: 'queued' })] as Array<() => Response>) {
      const calls = server(post);
      const out = await pressClock(WHOLE, deps(signed));
      expect(out.kind).toBe('unknown');
      expect(calls).toHaveLength(1);
      const pending = (out as { kind: 'unknown'; pending: Pending }).pending;
      expect(pending).toEqual({ setupId: SETUP, key: 'idem-1', body: { action: 'out_open', signed: 'SIGNED', phone_key_id: KEY } });
    }
  });
});

describe('[4733 S4b] following a press', () => {
  const t = (start = 0) => { let n = start; return { now: () => n, wait: async (ms: number) => { n += ms; } }; };

  it('queued → delivered → done: followed until the end', async () => {
    const calls = server(json(201, { command_id: CMD }), [json(200, { state: 'queued' }), json(200, { state: 'delivered' }), json(200, { state: 'done', result_code: 'already' })]);
    await expect(pressClock(WHOLE, deps(signed, t()))).resolves.toEqual({ kind: 'done', result: 'already' });
    expect(calls.filter((c) => c.init?.method !== 'POST')).toHaveLength(3);
  });

  it('rejected · failed → failed; switched off on the way → remote_off', async () => {
    for (const [state, result_code, kind] of [['rejected', 'unsigned', 'failed'], ['failed', null, 'failed'], ['rejected', 'remote_control_off', 'remote_off']] as const) {
      server(json(201, { command_id: CMD }), [json(200, { state, result_code })]);
      await expect(pressClock(WHOLE, deps(signed, t()))).resolves.toEqual({ kind });
    }
  });

  it('still queued the whole window (the computer never took it) → expired: nothing was stopped', async () => {
    const calls = server(json(201, { command_id: CMD }), [() => json(200, { state: 'queued' })]); // (a Response body can be read once: every look gets a new one)
    await expect(pressClock(WHOLE, deps(signed, t()))).resolves.toEqual({ kind: 'expired' });
    expect(calls.filter((c) => c.init?.method !== 'POST').length).toBeGreaterThan(50);
  });

  it('queued early, then every read fails → unknown, NOT «nothing was stopped» (the computer may have taken it in between)', async () => {
    let n = 0;
    server(json(201, { command_id: CMD }), [() => (n++ === 0 ? json(200, { state: 'queued' }) : json(500, {}))]);
    const out = await pressClock(WHOLE, deps(signed, t()));
    expect(out.kind).toBe('unknown');
  });

  it('«expired» needs a look AFTER the command\'s life (121 s) that still found it queued; queued until 100 s and then failing reads is unknown', async () => {
    let looks = 0;
    server(json(201, { command_id: CMD }), [() => (++looks < 66 ? json(200, { state: 'queued' }) : json(500, {}))]); // 66 looks × 1.5 s ≈ 99 s
    expect((await pressClock(WHOLE, deps(signed, t()))).kind).toBe('unknown');
    looks = 0;
    server(json(201, { command_id: CMD }), [() => (++looks < 83 ? json(200, { state: 'queued' }) : json(500, {}))]); // up to ≈ 123 s, then failing
    expect((await pressClock(WHOLE, deps(signed, t()))).kind).toBe('expired');
  });

  it('taken by the computer but no end in the window → unknown (it may have happened) — never expired', async () => {
    server(json(201, { command_id: CMD }), [() => json(200, { state: 'queued' }), () => json(200, { state: 'acked' })]);
    const out = await pressClock(WHOLE, deps(signed, t()));
    expect(out.kind).toBe('unknown');
    expect((out as { pending: Pending }).pending.commandId).toBe(CMD);
  });

  it('no look ever succeeded (every read failed) → unknown, never expired', async () => {
    server(json(201, { command_id: CMD }), [json(500, {})]);
    expect((await pressClock(WHOLE, deps(signed, t()))).kind).toBe('unknown');
    server(json(201, { command_id: CMD }), [() => { throw new Error('net'); }]);
    expect((await pressClock(WHOLE, deps(signed, t()))).kind).toBe('unknown');
  });

  it('a read that failed is not an end: the next look goes on', async () => {
    server(json(201, { command_id: CMD }), [json(500, {}), () => { throw new Error('net'); }, json(200, { state: 'done', result_code: 'ok' })]);
    await expect(pressClock(WHOLE, deps(signed, t()))).resolves.toEqual({ kind: 'done', result: 'ok' });
  });

  it('checkPress follows the command when its id is known (no new post), and reposts the SAME key and body when it is not', async () => {
    let calls = server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: 'ok' })]);
    await expect(checkPress({ setupId: SETUP, key: 'k-1', body: { action: 'in', signed: 'S', phone_key_id: KEY }, commandId: CMD }, deps(signed, t()))).resolves.toEqual({ kind: 'done', result: 'ok' });
    expect(calls.map((c) => c.init?.method ?? 'GET')).toEqual(['GET']);
    calls = server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: 'ok' })]);
    await checkPress({ setupId: SETUP, key: 'k-1', body: { action: 'in', signed: 'S', phone_key_id: KEY } }, deps(signed, t()));
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ action: 'in', signed: 'S', phone_key_id: KEY, idempotency_key: 'k-1' });
  });

  it('a stopped flow makes no further request: stopped before the signature → nothing posted; stopped while following → the next look is not made', async () => {
    let calls = server(json(201, { command_id: CMD }));
    const f1 = beginFlow();
    const d1 = deps(signed, { flow: f1, phoneCall: vi.fn(async () => { f1.stopped = true; return signed; }) });
    await expect(pressClock(WHOLE, d1)).resolves.toEqual({ kind: 'stopped' });
    endFlow(f1);
    expect(calls).toHaveLength(0);
    calls = server(json(201, { command_id: CMD }), [json(200, { state: 'queued' })]);
    const f2 = beginFlow();
    const wait = vi.fn(async () => { f2.stopped = true; });
    await expect(pressClock(WHOLE, deps(signed, { flow: f2, wait }))).resolves.toEqual({ kind: 'stopped' });
    endFlow(f2);
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1); // the person had signed: the press went; only the waiting stopped
    expect(calls.filter((c) => c.init?.method !== 'POST')).toHaveLength(0);
  });
});

describe('[4733 S4b] readClock · parseClockRead', () => {
  const READ = { remote_control: true, reachable: true, supported: true, view: null };

  it('asks for exactly the computer\'s clock with this phone key id', async () => {
    const calls = serverGet(() => json(200, READ));
    await expect(readClock(SETUP, KEY)).resolves.toEqual({ kind: 'read', read: { remoteControl: true, reachable: true, supported: true, view: null, computer: null } });
    expect(calls[0]!.url).toBe(`/api/desktop/setups/${SETUP}/clock?phone_key_id=${KEY}`);
  });

  it('[4734 B] asked with `computer`, the read carries `&computer=true` and keeps the server\'s counts (only plain numbers, pressable never above total)', async () => {
    const calls = serverGet(() => json(200, { ...READ, computer: { agents: { total: 3, pressable: 2 } } }));
    await expect(readClock(SETUP, KEY, undefined, { computer: true })).resolves.toMatchObject({ kind: 'read', read: { computer: { total: 3, pressable: 2 } } });
    expect(calls[0]!.url).toBe(`/api/desktop/setups/${SETUP}/clock?phone_key_id=${KEY}&computer=true`);
    for (const bad of [{ agents: { total: 2, pressable: 3 } }, { agents: { total: -1, pressable: 0 } }, { agents: { total: '3', pressable: 2 } }, { agents: null }, 'x', null]) {
      expect(parseClockRead({ ...READ, computer: bad })!.computer).toBeNull();
    }
    expect(parseClockRead(READ)!.computer).toBeNull(); // an older server: none
  });

  it('403 → not_allowed (the card is not drawn) · 409 phone_not_paired → not_paired · anything else → failed', async () => {
    serverGet(() => json(403, { error: { code: 'not_allowed_to_command' } }));
    expect((await readClock(SETUP, KEY)).kind).toBe('not_allowed');
    serverGet(() => json(409, { error: { code: 'phone_not_paired' } }));
    expect((await readClock(SETUP, KEY)).kind).toBe('not_paired');
    serverGet(() => json(409, { error: { code: 'other' } }));
    expect((await readClock(SETUP, KEY)).kind).toBe('failed');
    for (const r of [() => json(500, {}), () => json(200, 'nope'), () => json(200, { remote_control: true }), () => { throw new Error('net'); }] as Array<() => Response>) {
      serverGet(r);
      expect((await readClock(SETUP, KEY)).kind).toBe('failed');
    }
  });

  it('a stopped read asks for nothing and answers nothing', async () => {
    const calls = serverGet(() => json(200, READ));
    expect((await readClock(SETUP, KEY, () => true)).kind).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  const row = (o: Record<string, unknown>) => ({ agent_member_id: AGENT, name: 'Dev', state: 'ready', missing: [], first_line: '오늘 한 일', idle: false, ...o });
  const panel = (extra: Record<string, unknown> = {}) => ({ ...READ, view: { mode: 'panel', scope: 'computer', opened_from: 'mac', count: { ready: 1, needs_you: 0, drafting: 0 }, rows: [row({})], outs: [], reported_at: '2026-10-20T01:00:00Z', ...extra } });

  it('a panel: counts, rows (name · state · missing · first line · idle), who opened it', () => {
    const r = parseClockRead(panel())!;
    expect(r.view).toMatchObject({ mode: 'panel', scope: 'computer', openedFrom: 'mac', count: { ready: 1, needsYou: 0, drafting: 0 }, reportedAt: '2026-10-20T01:00:00Z' });
    expect(r.view!.rows).toEqual([{ agentId: AGENT, name: 'Dev', state: 'ready', missing: [], firstLine: '오늘 한 일', idle: false, rev: 0, edited: false }]);
  });

  it('the draft\'s first line is kept as plain characters (a tag · url · newline is data, not markup); a row with missing flags keeps only the known ones', () => {
    const r = parseClockRead(panel({ rows: [row({ first_line: '<b>x</b> https://evil.example' }), row({ agent_member_id: 'b'.repeat(8), state: 'needs_you', missing: ['done', 'plan', 'x'], first_line: null })] }))!;
    expect(r.view!.rows.map((x) => x.firstLine)).toEqual(['<b>x</b> https://evil.example', null]);
    expect(r.view!.rows[1]!.missing).toEqual(['done', 'plan']);
  });

  it('direction overrides / isolates / marks in a draft line or a name are taken out before it is drawn (a line must not reorder what stands beside it); a line of nothing else is no line', () => {
    const bidi = '\u202E\u202A\u2066\u2069\u200F\u061C';
    const r = parseClockRead(panel({ rows: [row({ first_line: `${bidi}끝낸 일${bidi}`, name: `Dev${bidi}`, state: 'ready' }), row({ agent_member_id: 'd'.repeat(8), first_line: bidi, state: 'ready' })] }))!;
    expect(r.view!.rows[0]!.firstLine).toBe('끝낸 일');
    expect(r.view!.rows[0]!.name).toBe('Dev');
    expect(r.view!.rows[1]!.firstLine).toBeNull();
    const o = parseClockRead({ ...READ, view: { mode: 'out', out: { at: '2026-10-20T01:00:00Z', left: [`A${bidi}`], still_working: [`B${bidi}`] }, outs: [{ agent_member_id: AGENT, name: `C${bidi}`, at: '2026-10-20T01:00:00Z' }] } })!;
    expect(o.view!.out!.left).toEqual(['A']);
    expect(o.view!.out!.stillWorking).toEqual(['B']);
    expect(o.view!.outs[0]!.name).toBe('C');
  });

  it('a row this page cannot read (no id · a state it does not know) makes the WHOLE view unreadable — never a view with fewer rows than the computer sent', () => {
    for (const bad of [row({ agent_member_id: undefined }), row({ state: 'confused' }), null, 'x', row({ agent_member_id: '' })]) {
      expect(parseClockRead(panel({ rows: [row({}), bad] }))).toBeNull();
    }
  });

  it('an `out` without its card, or an `in` without its steps, is no view (the page would fall back to the idle buttons for a state it cannot read)', () => {
    expect(parseClockRead({ ...READ, view: { mode: 'out', opened_from: 'mac', outs: [] } })).toBeNull();
    expect(parseClockRead({ ...READ, view: { mode: 'out', out: { came: 1 }, outs: [] } })).toBeNull();
    expect(parseClockRead({ ...READ, view: { mode: 'in', outs: [] } })).toBeNull();
    expect(parseClockRead({ ...READ, view: { mode: 'out', out: { at: '2026-10-20T01:00:00Z' }, outs: [] } })).not.toBeNull();
  });

  it('a one-agent panel is exactly one row: none or two is no view', () => {
    expect(parseClockRead(panel({ scope: 'one', rows: [] }))).toBeNull();
    expect(parseClockRead(panel({ scope: 'one', rows: [row({}), row({ agent_member_id: 'c'.repeat(8) })] }))).toBeNull();
    expect(parseClockRead(panel({ scope: 'one', rows: [row({})] }))).not.toBeNull();
  });

  it('out: the ended names, what came in, the warning, how many ended one by one; in: the steps, the failures; outs: who is out on their own', () => {
    const out = parseClockRead({ ...READ, view: { mode: 'out', opened_from: 'phone', out: { at: '2026-10-20T10:00:00+09:00', came: 4, warn: 'many', still_working: ['Lead'], left: ['Dev', 'Docs'], alone: 1 }, outs: [{ agent_member_id: AGENT, name: 'Dev', at: '2026-10-20T01:00:00Z' }] } })!;
    expect(out.view).toMatchObject({ mode: 'out', openedFrom: 'phone', out: { at: '2026-10-20T10:00:00+09:00', came: 4, warn: 'many', stillWorking: ['Lead'], left: ['Dev', 'Docs'], alone: 1 }, outs: [{ agentId: AGENT, name: 'Dev', at: '2026-10-20T01:00:00Z' }] });
    const inn = parseClockRead({ ...READ, view: { mode: 'in', in: { at: null, starting: { k: 1, n: 3 }, handing: { k: 0, m: 2 }, came: { total: 5 }, failed: [{ name: 'Dev', code: 'session_limit', limit: 3 }], unread: ['Docs'] } } })!;
    expect(inn.view!.in).toEqual({ at: null, starting: { k: 1, n: 3 }, handing: { k: 0, m: 2 }, came: { total: 5 }, failed: [{ name: 'Dev', code: 'session_limit', limit: 3 }], unread: ['Docs'] });
  });

  it('a panel that does not say whether it is the computer\'s or one agent\'s is no view this page can act on (it would press for the whole computer)', () => {
    for (const scope of [undefined, null, 'all', '', 5]) {
      expect(parseClockRead({ ...READ, view: { mode: 'panel', scope, count: { ready: 1, needs_you: 0, drafting: 0 }, rows: [row({})], outs: [] } })).toBeNull();
    }
    expect(parseClockRead({ ...READ, view: { mode: 'panel', scope: 'one', rows: [row({})], outs: [] } })!.view!.scope).toBe('one');
  });

  it('an old record\'s `opened_from` null stays null; a mode this page does not know is no view; `supported` false is carried (no buttons)', () => {
    expect(parseClockRead({ ...READ, view: { mode: 'out', opened_from: null, out: { at: 'x', came: 0, warn: 'none' } } })!.view!.openedFrom).toBeNull();
    expect(parseClockRead({ ...READ, view: { mode: 'future' } })).toBeNull();
    expect(parseClockRead({ ...READ, supported: false })!.supported).toBe(false);
    expect(parseClockRead(null)).toBeNull();
    expect(parseClockRead({ remote_control: 'yes', reachable: true, supported: true })).toBeNull();
  });
});


describe('[4733 S5·P2] editClock — a person\'s words for one agent\'s draft', () => {
  const EDIT = { setupId: SETUP, agentId: AGENT, baseRev: 4, fields: { plan: '내일 이어서 함' } };
  const edited: PhoneAnswer = { id: 'e1', ok: true, signed: 'SIGNED', phone_key_id: KEY, edit: { base_rev: 4, plan: '내일 이어서 함' } };

  it('the shell gets the computer, the action out_edit, the agent and the edit (the revision + the touched fields); the post carries what the shell handed back', async () => {
    const calls = server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: 'ok' })]);
    const d = deps(edited);
    await expect(editClock(EDIT, d)).resolves.toEqual({ kind: 'done', result: 'ok' });
    expect(d.phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'clock', setup_id: SETUP, action: 'out_edit', agent_member_id: AGENT, edit: { base_rev: 4, plan: '내일 이어서 함' } });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ action: 'out_edit', signed: 'SIGNED', phone_key_id: KEY, agent_member_id: AGENT, edit: { base_rev: 4, plan: '내일 이어서 함' }, idempotency_key: 'idem-1' });
  });

  it('only the touched fields: an untouched field is not a key on the shell call or the post; an edit that touches nothing is failed before anything is asked', async () => {
    const calls = server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: 'ok' })]);
    const d = deps({ ...edited, edit: { base_rev: 4, done: 'D', blockers: '' } });
    await editClock({ ...EDIT, fields: { done: 'D', blockers: '' } }, d);
    expect(Object.keys((d.phoneCall.mock.calls[0]![1] as { edit: object }).edit).sort()).toEqual(['base_rev', 'blockers', 'done']);
    expect(Object.keys(JSON.parse(calls[0]!.init!.body as string).edit).sort()).toEqual(['base_rev', 'blockers', 'done']);
    const none = deps(edited);
    await expect(editClock({ ...EDIT, fields: {} }, none)).resolves.toEqual({ kind: 'failed' });
    expect(none.phoneCall).not.toHaveBeenCalled();
  });

  it.each(['stale', 'not_editable', 'not_open', 'unknown_agent'])('the computer ends the edit with «%s» → done with that word', async (result) => {
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: result })]);
    await expect(editClock(EDIT, deps(edited))).resolves.toEqual({ kind: 'done', result });
  });

  it('the shell\'s answer must be the edit that was asked (revision · field set · text): anything else is failed and nothing is posted', async () => {
    const wrong: unknown[] = [undefined, null, 'plan', [], { plan: 'x' }, { base_rev: 5, plan: 'x' }, { base_rev: 4, done: 'x' }, { base_rev: 4, plan: 'x', done: 'y' }, { base_rev: 4, plan: 7 }, { base_rev: 4 }];
    for (const edit of wrong) {
      const calls = server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: 'ok' })]);
      await expect(editClock(EDIT, deps({ ...edited, edit } as PhoneAnswer)), JSON.stringify(edit)).resolves.toEqual({ kind: 'failed' });
      expect(calls, JSON.stringify(edit)).toHaveLength(0);
    }
  });

  it('the shell\'s refusals map as a press\'s do; a cleaned text is posted as cleaned', async () => {
    const calls = server(json(201, {}));
    await expect(editClock(EDIT, deps({ id: 'e', ok: false, code: 'cancelled' }))).resolves.toEqual({ kind: 'cancelled' });
    await expect(editClock(EDIT, deps({ id: 'e', ok: false, code: 'agent_not_found' }))).resolves.toEqual({ kind: 'failed' });
    await expect(editClock(EDIT, deps({ id: 'e', ok: false, code: 'not_allowed' }))).resolves.toEqual({ kind: 'not_allowed' });
    expect(calls).toHaveLength(0);
    const c2 = server(json(201, { command_id: CMD }), [json(200, { state: 'done', result_code: 'ok' })]);
    await editClock({ ...EDIT, fields: { plan: 'a\u200bb' } }, deps({ ...edited, edit: { base_rev: 4, plan: 'ab' } }));
    expect(JSON.parse(c2[0]!.init!.body as string).edit).toEqual({ base_rev: 4, plan: 'ab' });
  });

  it('a lost answer is `unknown` (followed with the same key and body, never redone with a new signature)', async () => {
    server(new Response('x', { status: 502 }));
    const out = await editClock(EDIT, deps(edited));
    expect(out.kind).toBe('unknown');
    expect((out as { pending: Pending }).pending.body).toMatchObject({ action: 'out_edit', agent_member_id: AGENT, edit: { base_rev: 4, plan: '내일 이어서 함' } });
  });

  it('the rows keep their revision and the mark of a person\'s hand; an older computer\'s row has neither (0 · not edited)', () => {
    const base = { remote_control: true, reachable: true, supported: true };
    const r = (o: Record<string, unknown>) => ({ agent_member_id: AGENT, state: 'ready', missing: [], first_line: '줄', idle: false, ...o });
    const view = (rows: unknown[]) => parseClockRead({ ...base, view: { mode: 'panel', scope: 'computer', count: { ready: 1, needs_you: 0, drafting: 0 }, rows, outs: [] } })!.view!;
    expect(view([r({ rev: 7, edited: true })]).rows[0]).toMatchObject({ rev: 7, edited: true });
    expect(view([r({})]).rows[0]).toMatchObject({ rev: 0, edited: false });
    for (const rev of [-1, 1.5, '3', null]) expect(view([r({ rev })]).rows[0]!.rev).toBe(0);
    expect(view([r({ edited: 'yes' })]).rows[0]!.edited).toBe(false);
  });
});
