// story #4714 — a start from the phone app: what the web asks the shell, what it posts, how every end maps to one outcome
// (contract 02d2cf71 §14 v1.17 · v1.18 · Yuna 4714-copy-1017).
import { describe, expect, it, vi } from 'vitest';
import { checkStart, parseStartable, readStartable, startOnPhone, type Pending, type StartDeps } from './phone-start';
import type { PhoneAnswer } from './phone-bridge';

let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));

const SETUP = '11111111-2222-4333-8444-555555555555';
const AGENT = '22222222-3333-4444-8555-666666666666';
const PROJECT = '33333333-4444-4555-8666-777777777777';
const CMD = '44444444-5555-4666-8777-888888888888';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const input = { setupId: SETUP, agentId: AGENT, projectId: PROJECT };

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
const signed: PhoneAnswer = { id: 'w1', ok: true, signed: 'SIGNED', phone_key_id: 'k-1' };
const deps = (answer: PhoneAnswer, extra: Partial<StartDeps> = {}) => {
  const d = { phoneCall: vi.fn(async () => answer), newKey: () => 'idem-1', wait: async () => {}, ...extra } as StartDeps & { phoneCall: ReturnType<typeof vi.fn> };
  return d;
};

describe('[4714] startOnPhone — what the web asks and posts', () => {
  it('the shell gets the kind and three ids only; the post carries the three ids + the shell\'s two values + the key — nothing else', async () => {
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done', result_code: null })]);
    const d = deps(signed);
    await expect(startOnPhone(input, d)).resolves.toEqual({ kind: 'started' });
    expect(d.phoneCall).toHaveBeenCalledWith('command.sign', { kind: 'start_session', setup_id: SETUP, agent_member_id: AGENT, project_id: PROJECT });
    expect(calls[0]!.url).toBe(`/api/agents/${AGENT}/desktop-start`);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ setup_id: SETUP, project_id: PROJECT, signed: 'SIGNED', phone_key_id: 'k-1', idempotency_key: 'idem-1' });
    expect(calls[1]!.url).toBe(`/api/agents/${AGENT}/desktop-commands/${CMD}`);
  });

  it('never a path · folder · cwd · mode · args · runtime — on the shell call or the post (a closed set of keys)', async () => {
    const calls = server(json(201, { command_id: CMD }), [json(200, { state: 'done' })]);
    const d = deps(signed);
    await startOnPhone(input, d);
    const keys = (o: unknown) => Object.keys(o as object).sort();
    expect(keys(d.phoneCall.mock.calls[0]![1])).toEqual(['agent_member_id', 'kind', 'project_id', 'setup_id']);
    expect(keys(JSON.parse(calls[0]!.init!.body as string))).toEqual(['idempotency_key', 'phone_key_id', 'project_id', 'setup_id', 'signed']);
  });

  it.each([
    ['cancelled', 'cancelled'], ['biometric_required', 'biometric_required'], ['no_screen_lock', 'no_screen_lock'], ['key_invalidated', 'key_invalidated'],
    ['not_registered', 'not_registered'], ['signed_out', 'signed_out'], ['remote_control_off', 'remote_off'], ['computer_not_found', 'not_paired'],
    ['device_unreachable', 'unreachable'], ['no_folder', 'no_folder'], ['agent_not_found', 'failed'], ['not_allowed', 'failed'], ['sign_failed', 'failed'], ['something_new', 'failed'],
  ])('the shell says %s → %s, and nothing is posted', async (code, kind) => {
    const calls = server(json(201, {}));
    await expect(startOnPhone(input, deps({ id: 'w', ok: false, code }))).resolves.toEqual({ kind });
    expect(calls).toEqual([]);
  });

  it('a shell answer without the signed value or the key id is a failure — nothing is posted', async () => {
    const calls = server(json(201, {}));
    await expect(startOnPhone(input, deps({ id: 'w', ok: true, signed: 'S' }))).resolves.toEqual({ kind: 'failed' });
    await expect(startOnPhone(input, deps({ id: 'w', ok: true, phone_key_id: 'k' }))).resolves.toEqual({ kind: 'failed' });
    expect(calls).toEqual([]);
  });
});

describe('[4714] the server\'s refusals and the command\'s ends', () => {
  it.each([
    [409, { error: { code: 'device_unreachable' } }, 'unreachable'], [409, { error: { code: 'remote_control_off' } }, 'remote_off'],
    [409, { error: { code: 'phone_not_paired' } }, 'not_paired'], [409, { error: { code: 'no_folder' } }, 'no_folder'],
    [404, { error: { code: 'computer_not_found' } }, 'failed'], [403, { error: { code: 'not_allowed_to_command' } }, 'failed'],
    [422, { code: 'schema' }, 'failed'], [401, {}, 'failed'],
  ])('post %s %j → %s (refused before anything was made)', async (status, body, kind) => {
    server(json(status, body));
    await expect(startOnPhone(input, deps(signed))).resolves.toEqual({ kind });
  });

  it('a 5xx · a lost answer · a body without a command id: unknown — kept, never an end', async () => {
    for (const post of [json(500, { error: { code: 'INTERNAL_ERROR' } }), json(502), () => { throw new Error('network'); }, json(201, {}), new Response('not json', { status: 201 })]) {
      server(post as never);
      const out = await startOnPhone(input, deps(signed));
      expect(out.kind).toBe('unknown');
    }
  });

  it.each([
    [{ state: 'done' }, 'started'], [{ state: 'rejected', result_code: 'already_running' }, 'already_running'], [{ state: 'rejected', result_code: 'no_folder' }, 'no_folder'],
    [{ state: 'rejected', result_code: 'unknown_agent' }, 'failed'], [{ state: 'rejected', result_code: 'schema_rejected' }, 'failed'], [{ state: 'rejected', result_code: 'expired' }, 'failed'],
    [{ state: 'failed', result_code: 'workdir_refused' }, 'no_folder'], [{ state: 'failed', result_code: 'unknown_agent' }, 'failed'], [{ state: 'failed' }, 'failed'],
  ])('the command ends as %j → %s', async (poll, kind) => {
    server(json(201, { command_id: CMD }), [json(200, poll)]);
    await expect(startOnPhone(input, deps(signed))).resolves.toEqual({ kind });
  });

  it('a read that failed is asked again; two minutes on the wall clock with no end → unknown', async () => {
    let t = 0;
    server(json(201, { command_id: CMD }), [json(500), () => { throw new Error('x'); }, json(200, { state: 'working' })]);
    const out = await startOnPhone(input, deps(signed, { now: () => t, wait: async (ms: number) => { t += ms; } }));
    expect(out.kind).toBe('unknown');
    expect((out as { pending: Pending }).pending.commandId).toBe(CMD);
  });
});

describe('[4714] [결과 확인] never signs again and never starts twice', () => {
  it('unknown with an id → the same command is followed (no post, no shell call); unknown without one → the same post with the same key and the same signed body', async () => {
    const lost = server(() => { throw new Error('network'); });
    const first = await startOnPhone(input, deps(signed));
    expect(first.kind).toBe('unknown');
    const pending = (first as { pending: Pending }).pending;
    expect(pending.commandId).toBeUndefined();
    const d = deps(signed);
    const again = server(json(201, { command_id: CMD }), [json(200, { state: 'done' })]);
    await expect(checkStart(pending, d)).resolves.toEqual({ kind: 'started' });
    expect(d.phoneCall).not.toHaveBeenCalled(); // no new signature
    expect(JSON.parse(again[0]!.init!.body as string).idempotency_key).toBe('idem-1');
    expect(JSON.parse(again[0]!.init!.body as string).signed).toBe('SIGNED');
    expect(lost.length).toBe(1);
    const followed = server(json(500), [json(200, { state: 'done' })]);
    await expect(checkStart({ ...pending, commandId: CMD }, d)).resolves.toEqual({ kind: 'started' });
    expect(followed.every((c) => c.init?.method !== 'POST')).toBe(true); // an id → followed, not re-posted
  });
});

describe('[4714] parseStartable — only what the screen draws', () => {
  it('keeps ids and names; drops anything else (a path field is not carried)', () => {
    const view = parseStartable({
      remote_control: true,
      computers: [{ setup_id: SETUP, device_name: 'Mac', reachable: true, path: '/Users/x', agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, cwd: '/x', projects: [{ project_id: PROJECT, name: 'Pay', folder: '/y' }] }] }],
    });
    expect(view).toEqual({ remote_control: true, computers: [{ setup_id: SETUP, device_name: 'Mac', reachable: true, agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, projects: [{ project_id: PROJECT, name: 'Pay' }] }] }] });
    expect(JSON.stringify(view)).not.toMatch(/\/Users|\/x|\/y|folder|cwd|path/);
  });
  it('a shape that is not ours is null; rows without their ids are dropped; can_command is true only when true', () => {
    expect(parseStartable(null)).toBeNull();
    expect(parseStartable([])).toBeNull();
    expect(parseStartable({ computers: [] })).toBeNull();
    expect(parseStartable({ remote_control: 'yes', computers: [] })).toBeNull();
    expect(parseStartable({ remote_control: false, computers: [{ device_name: 'x', agents: [] }, { setup_id: SETUP, device_name: 'M', agents: [{ name: 'noid', projects: [] }, { agent_member_id: AGENT, name: 'A', can_command: 'true', projects: [{ name: 'noid' }] }] }] }))
      .toEqual({ remote_control: false, computers: [{ setup_id: SETUP, device_name: 'M', reachable: false, agents: [{ agent_member_id: AGENT, name: 'A', can_command: false, projects: [] }] }] });
  });
});

describe('[4714] readStartable — this phone\'s key found by the number the server prints (read-only)', () => {
  const view = { remote_control: true, computers: [] };
  const answer = (over: Partial<PhoneAnswer> = {}): PhoneAnswer => ({ id: 'k', ok: true, public_key: 'PK', key_number: '482 917', ...over });
  const list = [{ id: 'other', confirm_number: '111 111' }, { id: 'p-1', confirm_number: '482 917' }];
  it('device.key.info → the row whose confirm_number is the key number → the startable read for THAT key id; nothing is written', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    currentFetch = async (url, init) => { calls.push({ url, init }); return url.startsWith('/api/remote-devices') ? json(200, { devices: list }) : json(200, view); };
    const phoneCall = vi.fn(async () => answer());
    await expect(readStartable(phoneCall)).resolves.toEqual({ kind: 'view', view });
    expect(phoneCall).toHaveBeenCalledWith('device.key.info', {});
    expect(calls.map((c) => c.url)).toEqual(['/api/remote-devices', '/api/desktop/startable?phone_key_id=p-1']);
    expect(calls.every((c) => (c.init?.method ?? 'GET') === 'GET')).toBe(true);
  });
  it('a key the server does not list → no_phone (paired with nothing) and the startable read is not made', async () => {
    const urls: string[] = [];
    currentFetch = async (url) => { urls.push(url); return json(200, { devices: [{ id: 'x', confirm_number: '000 000' }] }); };
    await expect(readStartable(async () => answer())).resolves.toEqual({ kind: 'no_phone' });
    expect(urls).toEqual(['/api/remote-devices']);
  });
  it('the shell refuses → no_screen_lock / failed; a read that fails or is not ours → failed', async () => {
    currentFetch = async () => json(200, {});
    await expect(readStartable(async () => ({ id: 'k', ok: false, code: 'no_screen_lock' }))).resolves.toEqual({ kind: 'no_screen_lock' });
    await expect(readStartable(async () => ({ id: 'k', ok: false, code: 'failed' }))).resolves.toEqual({ kind: 'failed' });
    await expect(readStartable(async () => ({ id: 'k', ok: true }))).resolves.toEqual({ kind: 'failed' });
    currentFetch = async () => json(500, {});
    await expect(readStartable(async () => answer())).resolves.toEqual({ kind: 'failed' });
    currentFetch = async (url) => (url.startsWith('/api/remote-devices') ? json(200, { devices: list }) : json(200, { remote_control: 'x' }));
    await expect(readStartable(async () => answer())).resolves.toEqual({ kind: 'failed' });
    currentFetch = async () => { throw new Error('network'); };
    await expect(readStartable(async () => answer())).resolves.toEqual({ kind: 'failed' });
  });
});
