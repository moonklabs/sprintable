// story #4714 — a start from the phone app: what the web asks the shell, what it posts, how every end maps to one outcome
// (contract 02d2cf71 §14 v1.17 · v1.18 · Yuna 4714-copy-1017).
import { describe, expect, it, vi } from 'vitest';
import { beginFlow, checkStart, clearLeaving, endFlow, groupByComputer, groupForPress, isLeaving, markLeaving, parseStartable, readStartable, startOnPhone, waitForSession, type Pending, type StartDeps } from './phone-start';
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
    [{ state: 'rejected', result_code: 'remote_control_off' }, 'remote_off'], [{ state: 'failed', result_code: 'remote_control_off' }, 'remote_off'],
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

describe('[4714] codex round 1 — a valid JSON body that is not an object', () => {
  it('a post answered 201 with `null` (or a number) is unknown — never a throw; a poll answered `null` is asked again', async () => {
    for (const body of ['null', '7', '"x"']) {
      server(new Response(body, { status: 201 }));
      expect((await startOnPhone(input, deps(signed))).kind).toBe('unknown');
    }
    let t = 0;
    server(json(201, { command_id: CMD }), [new Response('null', { status: 200 }), json(200, { state: 'done' })]);
    await expect(startOnPhone(input, deps(signed, { now: () => t, wait: async (ms: number) => { t += ms; } }))).resolves.toEqual({ kind: 'started' });
    server(json(201, { command_id: CMD }), [new Response('null', { status: 200 })]);
    expect((await startOnPhone(input, deps(signed, { now: () => t, wait: async (ms: number) => { t += ms; } }))).kind).toBe('unknown');
  });
});

describe('[4714] Kadir 5140 lens — only `done` is a start (the mirror of the unknown rule)', () => {
  it.each(['queued', 'accepted', 'working', 'sent', 'running', 'pending'])('a command still in state %j for the whole two minutes is unknown — never started', async (state) => {
    let t = 0;
    server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state })]);
    const out = await startOnPhone(input, deps(signed, { now: () => t, wait: async (ms: number) => { t += ms; } }));
    expect(out.kind).toBe('unknown');
  });
});

describe('[4714] codex round 3 — a bridge call that is rejected', () => {
  it('a rejected device.key.info is a failed read; a rejected command.sign is a failed start with nothing posted', async () => {
    const calls = server(json(201, { command_id: CMD }));
    await expect(readStartable(async () => { throw new Error('bridge'); })).resolves.toEqual({ kind: 'failed' });
    await expect(startOnPhone(input, deps(signed, { phoneCall: vi.fn(async () => { throw new Error('bridge'); }) } as never))).resolves.toEqual({ kind: 'failed' });
    expect(calls).toEqual([]);
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

describe('[SID:4714] parseStartable keeps the one reason the server may give for an empty list', () => {
  it('agents_hidden: message_policy is kept (and carried through the computer grouping); any other value is dropped', () => {
    const base = { setup_id: SETUP, device_name: 'Mac', reachable: true, agents: [] };
    expect(parseStartable({ remote_control: true, computers: [{ ...base, agents_hidden: 'message_policy' }] })?.computers[0]).toMatchObject({ agents_hidden: 'message_policy' });
    expect(parseStartable({ remote_control: true, computers: [{ ...base, agents_hidden: 'something else' }] })?.computers[0]).not.toHaveProperty('agents_hidden');
    expect(parseStartable({ remote_control: true, computers: [base] })?.computers[0]).not.toHaveProperty('agents_hidden');
  });
  it('two setups of one computer: the merged computer says «hidden» when any of them does and no agent is left', () => {
    const e = (id: string, hidden?: boolean) => ({ setup_id: id, device_name: 'Mac', reachable: true, agents: [], computer_id: 'comp-1', ...(hidden ? { agents_hidden: 'message_policy' as const } : {}) });
    expect(groupByComputer([e('s1'), e('s2', true)])[0]).toMatchObject({ agents_hidden: 'message_policy' });
    expect(groupByComputer([e('s1'), e('s2')])[0]).not.toHaveProperty('agents_hidden');
    // «no agent is left» is the whole claim: when another setup of the computer lists an agent, the merged computer does not say it
    const withAgent = { ...e('s3'), agents: [{ agent_member_id: 'a-1', name: 'Dev', can_command: true, projects: [], running: null }] };
    expect(groupByComputer([withAgent, e('s2', true)])[0]).not.toHaveProperty('agents_hidden');
    // … whichever of them is first (the reachable one ranks first and is the base of the merged entry)
    expect(groupByComputer([e('s2', true), withAgent])[0]).not.toHaveProperty('agents_hidden');
    expect(groupByComputer([{ ...e('s4', true), reachable: true }, { ...withAgent, reachable: false }])[0]).not.toHaveProperty('agents_hidden');
  });
});

describe('[4714] parseStartable — only what the screen draws', () => {
  it('keeps ids and names; drops anything else (a path field is not carried)', () => {
    const view = parseStartable({
      remote_control: true,
      computers: [{ setup_id: SETUP, device_name: 'Mac', reachable: true, path: '/Users/x', agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, cwd: '/x', projects: [{ project_id: PROJECT, name: 'Pay', folder: '/y' }] }] }],
    });
    expect(view).toEqual({ remote_control: true, computers: [{ setup_id: SETUP, device_name: 'Mac', reachable: true, agents: [{ agent_member_id: AGENT, name: 'Dev', can_command: true, projects: [{ project_id: PROJECT, name: 'Pay' }], running: null }] }] });
    expect(JSON.stringify(view)).not.toMatch(/\/Users|\/x|\/y|folder|cwd|path/);
  });
  it('a shape that is not ours is null; rows without their ids are dropped; can_command is true only when true', () => {
    expect(parseStartable(null)).toBeNull();
    expect(parseStartable([])).toBeNull();
    expect(parseStartable({ computers: [] })).toBeNull();
    expect(parseStartable({ remote_control: 'yes', computers: [] })).toBeNull();
    expect(parseStartable({ remote_control: false, computers: [{ device_name: 'x', agents: [] }, { setup_id: SETUP, device_name: 'M', agents: [{ name: 'noid', projects: [] }, { agent_member_id: AGENT, name: 'A', can_command: 'true', projects: [{ name: 'noid' }] }] }] }))
      .toEqual({ remote_control: false, computers: [{ setup_id: SETUP, device_name: 'M', reachable: false, agents: [{ agent_member_id: AGENT, name: 'A', can_command: false, projects: [], running: null }] }] });
  });
});

describe('[4714] parseStartable — `running`: what the server says about an agent, and nothing it does not say', () => {
  const one = (running: unknown) => parseStartable({ remote_control: true, computers: [{ setup_id: SETUP, device_name: 'M', reachable: true, agents: [{ agent_member_id: AGENT, name: 'A', can_command: true, projects: [], ...(running === undefined ? {} : { running }) }] }] })!.computers[0].agents[0].running;
  it('true and false are kept; null · missing (an older server) · any other value is null — never read as «not running»', () => {
    expect(one(true)).toBe(true);
    expect(one(false)).toBe(false);
    expect(one(null)).toBeNull();
    expect(one(undefined)).toBeNull();
    for (const odd of ['true', 'false', 0, 1, {}, []]) expect([odd, one(odd)]).toEqual([odd, null]);
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

describe('[4714] waitForSession — started ≠ stood: the server\'s `running` word on THAT agent on THAT computer', () => {
  const OTHER_SETUP = '11111111-2222-4333-8444-666666666666';
  const OTHER_AGENT = '22222222-3333-4444-8555-777777777777';
  const target = { setupId: SETUP, agentId: AGENT };
  const agent = (id: string, running: unknown) => ({ agent_member_id: id, name: 'a', can_command: true, projects: [{ project_id: PROJECT, name: 'p' }], ...(running === undefined ? {} : { running }) });
  const startable = (computers: Array<{ setup_id: string; agents: unknown[] }>) => ({ remote_control: true, computers: computers.map((c) => ({ device_name: 'm', reachable: true, ...c })) });
  const phoneCall = async () => ({ id: 'k', ok: true, public_key: 'PK', key_number: '482 917' }) as PhoneAnswer;
  /** each startable read answers the next body (the last one repeats); a clock the fake wait moves */
  function world(bodies: unknown[]) {
    let n = 0; let t = 0; const reads: number[] = [];
    currentFetch = async (url) => {
      if (url.startsWith('/api/remote-devices')) return json(200, { devices: [{ id: 'p-1', confirm_number: '482 917' }] });
      reads.push(t);
      const b = bodies[Math.min(n++, bodies.length - 1)];
      if (b instanceof Error) throw b;
      return json(200, b);
    };
    return { reads, deps: { phoneCall, wait: async (ms: number) => { t += ms; }, now: () => t } };
  }

  it('the agent runs on that computer → stood, with one read and no wait', async () => {
    const w = world([startable([{ setup_id: SETUP, agents: [agent(AGENT, true)] }])]);
    await expect(waitForSession(target, w.deps)).resolves.toBe('stood');
    expect(w.reads).toEqual([0]);
  });

  it('not yet → it asks again every 2 s and answers stood on the read that says it runs', async () => {
    const w = world([
      startable([{ setup_id: SETUP, agents: [agent(AGENT, false)] }]),
      startable([{ setup_id: SETUP, agents: [agent(AGENT, null)] }]),
      startable([{ setup_id: SETUP, agents: [agent(AGENT, true)] }]),
    ]);
    await expect(waitForSession(target, w.deps)).resolves.toBe('stood');
    expect(w.reads).toEqual([0, 2000, 4000]);
  });

  it('only THAT agent on THAT computer counts: another agent running, or the same agent id on another computer, is not it', async () => {
    // the wrong ones come FIRST in each list: a lookup that took the first computer / the first agent would say «stood»
    const w = world([startable([{ setup_id: OTHER_SETUP, agents: [agent(AGENT, true)] }, { setup_id: SETUP, agents: [agent(OTHER_AGENT, true), agent(AGENT, false)] }])]);
    await expect(waitForSession(target, { ...w.deps, pollMaxMs: 6000 })).resolves.toBe('waiting');
  });

  it('never within the limit → waiting, after the last read at the limit (30 s by default) — not before, not forever', async () => {
    const w = world([startable([{ setup_id: SETUP, agents: [agent(AGENT, false)] }])]);
    await expect(waitForSession(target, w.deps)).resolves.toBe('waiting');
    expect(w.reads[0]).toBe(0);
    expect(w.reads[w.reads.length - 1]).toBe(30_000);
    expect(w.reads.length).toBe(16);
  });

  it('the sleep between looks is cut by what is left of the limit: the last look is at the limit (5 s here), not 2 s after it', async () => {
    const w = world([startable([{ setup_id: SETUP, agents: [agent(AGENT, false)] }])]);
    await expect(waitForSession(target, { ...w.deps, pollMaxMs: 5000 })).resolves.toBe('waiting');
    expect(w.reads).toEqual([0, 2000, 4000, 5000]);
  });

  it('a read that fails (offline · 500 · not a view) is no answer — it asks again, and a later «runs» still lands', async () => {
    const w = world([new Error('offline'), { remote_control: 'x' }, startable([{ setup_id: SETUP, agents: [agent(AGENT, true)] }])]);
    await expect(waitForSession(target, w.deps)).resolves.toBe('stood');
    expect(w.reads).toEqual([0, 2000, 4000]);
  });

  it('a read that never answers is cut at the limit: waiting after pollMaxMs, not after the bridge\'s own minutes (a late read is dropped)', async () => {
    const hang = () => new Promise<PhoneAnswer>(() => {});
    const t0 = Date.now();
    await expect(waitForSession(target, { phoneCall: hang, pollMaxMs: 60 })).resolves.toBe('waiting');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a read the caller gave up (the limit passed while the bridge was still answering) makes no further request: no remote-devices, no startable', async () => {
    const urls: string[] = [];
    currentFetch = async (url) => { urls.push(url); return json(200, {}); };
    let answer: (a: PhoneAnswer) => void = () => undefined;
    const slow = () => new Promise<PhoneAnswer>((r) => { answer = r; });
    await expect(waitForSession(target, { phoneCall: slow, pollMaxMs: 40 })).resolves.toBe('waiting'); // the bridge has not answered by the limit
    answer({ id: 'k', ok: true, public_key: 'PK', key_number: '482 917' } as PhoneAnswer); // … and answers afterwards
    await new Promise((r) => setTimeout(r, 20));
    expect(urls).toEqual([]);
  });

  it('readStartable(phoneCall, stop): stopped after the key answer → no request; stopped after the device list → no startable read', async () => {
    const urls: string[] = [];
    currentFetch = async (url) => { urls.push(url); return url.startsWith('/api/remote-devices') ? json(200, { devices: [{ id: 'p-1', confirm_number: '482 917' }] }) : json(200, { remote_control: true, computers: [] }); };
    const ok = async () => ({ id: 'k', ok: true, public_key: 'PK', key_number: '482 917' }) as PhoneAnswer;
    await expect(readStartable(ok, () => true)).resolves.toEqual({ kind: 'failed' });
    expect(urls).toEqual([]);
    let calls = 0;
    await expect(readStartable(ok, () => ++calls > 1)).resolves.toEqual({ kind: 'failed' });
    expect(urls).toEqual(['/api/remote-devices']);
  });

  it('an answer that comes AFTER the limit is not «within the limit», even if it says runs (a late timer does not buy extra time)', async () => {
    let t = 0;
    currentFetch = async (url) => {
      if (url.startsWith('/api/remote-devices')) return json(200, { devices: [{ id: 'p-1', confirm_number: '482 917' }] });
      t += 40_000; // the read takes longer than the 30 s (its timer was late)
      return json(200, startable([{ setup_id: SETUP, agents: [agent(AGENT, true)] }]));
    };
    await expect(waitForSession(target, { phoneCall, wait: async (ms) => { t += ms; }, now: () => t })).resolves.toBe('waiting');
  });

  it('a sleep that ended after the limit (a late timer) is not one more read: waiting, with no read after the limit', async () => {
    const w = world([startable([{ setup_id: SETUP, agents: [agent(AGENT, false)] }])]);
    let t = 0;
    const late = { phoneCall, wait: async () => { t += 90_000; }, now: () => t };
    await expect(waitForSession(target, late)).resolves.toBe('waiting');
    expect(w.reads.length).toBe(1); // the first look only — the sleep jumped past the 30 s
  });

  it('a bridge call that is rejected is no answer either — it asks again', async () => {
    const w = world([startable([{ setup_id: SETUP, agents: [agent(AGENT, true)] }])]);
    let n = 0;
    const flaky = async () => { if (n++ === 0) throw new Error('bridge gone'); return { id: 'k', ok: true, public_key: 'PK', key_number: '482 917' } as PhoneAnswer; };
    await expect(waitForSession(target, { ...w.deps, phoneCall: flaky })).resolves.toBe('stood');
    expect(w.reads).toEqual([2000]);
  });

  it('a `running` that is not the boolean true (a string · 1 · missing) is not «runs»', async () => {
    for (const running of ['true', 1, undefined]) {
      const w = world([startable([{ setup_id: SETUP, agents: [agent(AGENT, running)] }])]);
      await expect(waitForSession(target, { ...w.deps, pollMaxMs: 2000 })).resolves.toBe('waiting');
    }
  });

  it('the screen left (alive false) → gone: before the first read, or while it waits — and nothing more is read', async () => {
    const w = world([startable([{ setup_id: SETUP, agents: [agent(AGENT, false)] }])]);
    const spy = vi.fn(w.deps.phoneCall);
    await expect(waitForSession(target, { ...w.deps, phoneCall: spy, alive: () => false })).resolves.toBe('gone');
    expect(w.reads).toEqual([]);
    expect(spy).not.toHaveBeenCalled(); // not even the bridge is asked for a screen that has left
    let reads = 0;
    const w2 = world([startable([{ setup_id: SETUP, agents: [agent(AGENT, false)] }])]);
    await expect(waitForSession(target, { ...w2.deps, alive: () => reads++ < 2 })).resolves.toBe('gone');
  });
});

describe('[4714] flows — one stop signal per press: what a stopped flow gets back later does nothing', () => {
  it('stopped after the bridge signed → nothing is posted (outcome `stopped`)', async () => {
    const calls = server(json(201, { command_id: CMD, state: 'queued' }), [json(200, { state: 'done', result_code: null })]);
    const flow = beginFlow();
    const d = deps(signed, { flow, phoneCall: vi.fn(async () => { flow.stopped = true; return signed; }) as never });
    await expect(startOnPhone(input, d)).resolves.toEqual({ kind: 'stopped' });
    expect(calls).toEqual([]);
    endFlow(flow);
  });

  it('stopped while the post is out → `stopped` (the command may exist on the Mac; nobody follows it)', async () => {
    const flow = beginFlow();
    currentFetch = async (_url, init) => { if (init?.method === 'POST') { flow.stopped = true; return json(201, { command_id: CMD, state: 'queued' }); } throw new Error('no poll expected'); };
    await expect(startOnPhone(input, deps(signed, { flow }))).resolves.toEqual({ kind: 'stopped' });
    endFlow(flow);
  });

  it('stopped while the command is followed → the poll ends at once: `stopped`, and no further request', async () => {
    const flow = beginFlow();
    let polls = 0;
    currentFetch = async (_url, init) => {
      if (init?.method === 'POST') return json(201, { command_id: CMD, state: 'queued' });
      polls += 1;
      if (polls === 2) flow.stopped = true;
      return json(200, { state: 'running', result_code: null });
    };
    await expect(startOnPhone(input, deps(signed, { flow }))).resolves.toEqual({ kind: 'stopped' });
    expect(polls).toBe(2);
    endFlow(flow);
  });

  it('PO 10-19: stopped AFTER the signature came back (while the post is out) the post still went — once — and nobody follows it', async () => {
    const flow = beginFlow();
    const posts: string[] = [];
    currentFetch = async (_url, init) => { if (init?.method === 'POST') { posts.push('post'); flow.stopped = true; return json(201, { command_id: CMD, state: 'queued' }); } throw new Error('no poll expected'); };
    await expect(startOnPhone(input, deps(signed, { flow }))).resolves.toEqual({ kind: 'stopped' });
    expect(posts).toEqual(['post']);
    endFlow(flow);
  });

  it('[결과 확인] of a stopped flow asks for nothing (no re-post · no poll)', async () => {
    const urls: string[] = [];
    currentFetch = async (url) => { urls.push(url); return json(200, {}); };
    const flow = beginFlow(); flow.stopped = true;
    const pending: Pending = { agentId: AGENT, key: 'k', body: {}, commandId: CMD };
    await expect(checkStart(pending, deps(signed, { flow }))).resolves.toEqual({ kind: 'stopped' });
    await expect(checkStart({ ...pending, commandId: undefined }, deps(signed, { flow }))).resolves.toEqual({ kind: 'stopped' });
    expect(urls).toEqual([]);
    endFlow(flow);
  });

  it('a sleep that ended after the command\'s two minutes is not one more look (a late timer buys nothing)', async () => {
    const urls: string[] = [];
    currentFetch = async (url) => { urls.push(url); return json(200, { state: 'running', result_code: null }); };
    let t = 0;
    const pending: Pending = { agentId: AGENT, key: 'k', body: {}, commandId: CMD };
    const out = await checkStart(pending, { phoneCall: vi.fn(), newKey: () => 'k', wait: async () => { t += 500_000; }, now: () => t } as never);
    expect(out).toEqual({ kind: 'unknown', pending });
    expect(urls).toEqual([]);
  });

  it('markLeaving stops every flow that is out, once: the second call is false (a second tap) until the window is over; clearLeaving ends it', () => {
    clearLeaving();
    const a = beginFlow(); const b = beginFlow(); endFlow(b);
    expect(isLeaving()).toBe(false);
    expect(markLeaving()).toBe(true);
    expect(a.stopped).toBe(true);
    expect(b.stopped).toBe(false); // an ended flow is not touched
    expect(isLeaving()).toBe(true);
    expect(markLeaving()).toBe(false);
    clearLeaving();
    expect(isLeaving()).toBe(false);
    endFlow(a);
  });

  it('the way-out window is a TIME: it is over after LEAVING_MS (a way out that failed can be pressed again)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clearLeaving();
    expect(markLeaving()).toBe(true);
    vi.advanceTimersByTime(9_999);
    expect(isLeaving()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isLeaving()).toBe(false);
    expect(markLeaving()).toBe(true);
    clearLeaving();
    vi.useRealTimers();
  });
});

describe('[4734 B] groupForPress — one card for a computer only when EVERY setup of it that is HEARD from takes the press of the whole computer', () => {
  const e = (id: string, o: Partial<import('./phone-start').StartableComputer> = {}): import('./phone-start').StartableComputer => ({
    setup_id: id, device_name: 'Mac', reachable: true, agents: [{ agent_member_id: `a-${id}`, name: `n-${id}`, can_command: true, projects: [], running: true }], ...o,
  });
  it('parseStartable keeps `computer_press` only as the boolean true', () => {
    const raw = (v: unknown) => ({ remote_control: true, computers: [{ setup_id: 's', device_name: 'Mac', agents: [], computer_id: 'c', computer_press: v }] });
    expect(parseStartable(raw(true))!.computers[0]).toMatchObject({ computer_press: true });
    for (const v of [false, 'true', 1, null, undefined]) expect(parseStartable(raw(v))!.computers[0]).not.toHaveProperty('computer_press');
  });
  it('every setup says it → ONE entry whose agents carry their own setup; the computer id stays', () => {
    const out = groupForPress([e('s1', { computer_id: 'c', computer_press: true }), e('s2', { computer_id: 'c', computer_press: true })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ computer_id: 'c' });
    expect(out[0]!.agents.map((a) => [a.agent_member_id, a.setup_id])).toEqual([['a-s1', 's1'], ['a-s2', 's2']]);
  });
  it('one of them does not (or none does) → each setup stays its own entry and loses the computer id; a lone setup of a computer that says it is still marked', () => {
    const mixed = groupForPress([e('s1', { computer_id: 'c', computer_press: true }), e('s2', { computer_id: 'c' }), e('s3', { computer_id: 'd', computer_press: true })]);
    expect(mixed.map((m) => [m.setup_id, m.computer_id ?? null])).toEqual([['s1', null], ['s2', null], ['s3', 'd']]);
    expect(groupForPress([e('s1')])).toHaveLength(1); // (an older server: no computer id at all)
  });
  it('old setups that are not heard from (never disconnected, silent, no word) neither keep a computer from being one card nor put their agents on it', () => {
    const silent = (id: string) => e(id, { computer_id: 'c', reachable: false });
    const out = groupForPress([silent('o1'), silent('o2'), e('s1', { computer_id: 'c', computer_press: true }), silent('o3')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ computer_id: 'c', reachable: true });
    expect(out[0]!.agents.map((a) => a.agent_member_id)).toEqual(['a-s1']); // N is the heard setup's — the dead ones' agents are not on the card
  });
  it('a setup that IS heard from and says nothing (an older app, alive) still splits the computer into one card per setup — the silent ones stay as they were', () => {
    const out = groupForPress([e('o1', { computer_id: 'c', reachable: false }), e('s1', { computer_id: 'c', computer_press: true }), e('s2', { computer_id: 'c' })]);
    expect(out.map((m) => [m.setup_id, m.computer_id ?? null])).toEqual([['o1', null], ['s1', null], ['s2', null]]);
  });
  it('a computer none of whose setups is heard from is not made one card (nothing to press)', () => {
    const out = groupForPress([e('o1', { computer_id: 'c', reachable: false, computer_press: true }), e('o2', { computer_id: 'c', reachable: false, computer_press: true })]);
    expect(out.map((m) => m.computer_id ?? null)).toEqual([null, null]);
  });
});
