// story 4951 ①c — the part of the «바뀐 파일» sheet that is not drawing: ask · look once a second · keep the list the moment it came (the server deletes it on reading) ·
// a 404 after asking is «다시 불러오기», not a fault · the closed words of every refusal. The network and the clock are injected: nothing waits.
import { describe, expect, it } from 'vitest';
import { GIVE_UP_MS, loadChanges, normalizeFile, POLL_MS, problemOf, type ChangesDeps, type ChangesState } from './agent-changes';

const AGENT = '22222222-3333-4444-8555-666666666666';
const COMMAND = '33333333-4444-4555-8666-777777777777';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** a scripted server: each URL kind answers from its own queue; the clock moves only when `sleep` is called */
function world(script: { ask?: Response[]; look?: Response[] }) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const sleeps: number[] = [];
  let t = 1_000_000;
  const ask = [...(script.ask ?? [json(201, { command_id: COMMAND, expires_at: 'x' })])];
  const look = [...(script.look ?? [])];
  const deps: ChangesDeps = {
    paths: { ask: (a) => `/api/agents/${a}/desktop-changes`, look: (a, c) => `/api/agents/${a}/desktop-changes/${c}` },
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (init?.method === 'POST') return ask.shift() ?? json(500, {});
      return look.shift() ?? json(200, { state: 'delivered', code: null, files: null, more: false, total: 0 });
    },
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; return true; },
  };
  return { deps, calls, sleeps, advance: (ms: number) => { t += ms; } };
}
async function run(w: ReturnType<typeof world>, cancelled = () => false) {
  const states: ChangesState[] = [];
  await loadChanges({ agentId: AGENT, sessionKey: 's-1' }, w.deps, (s) => states.push(s), cancelled);
  return states;
}
const file = (over: Record<string, unknown> = {}) => ({ status: 'modified', name: 'src/a.ts', old_name: null, adds: 3, dels: 1, binary: false, hidden: false, ...over });

describe('loadChanges (story 4951 ①c)', () => {
  it('asks with exactly {session_key}, looks no closer than POLL_MS, and ends `ready` with the list the first successful look took', async () => {
    const w = world({ look: [json(200, { state: 'delivered', code: null, files: null }), json(200, { state: 'done', code: 'ok', files: [file(), file({ status: 'renamed', name: 'b.txt', old_name: 'a.txt', adds: null, dels: null }), file({ hidden: true, name: null, status: 'added' })], more: true, total: 260 })] });
    const states = await run(w);
    expect(w.calls[0]).toEqual({ url: `/api/agents/${AGENT}/desktop-changes`, method: 'POST', body: JSON.stringify({ session_key: 's-1' }) });
    expect(w.calls.slice(1).map((c) => [c.method, c.url])).toEqual([['GET', `/api/agents/${AGENT}/desktop-changes/${COMMAND}`], ['GET', `/api/agents/${AGENT}/desktop-changes/${COMMAND}`]]);
    expect(w.sleeps).toEqual([POLL_MS, POLL_MS]);
    expect(POLL_MS).toBeGreaterThanOrEqual(1000);
    expect(states.map((s) => s.kind)).toEqual(['asking', 'waiting', 'ready']);
    const ready = states[2]!;
    if (ready.kind !== 'ready') throw new Error('not ready');
    expect(ready.files.map((f) => [f.status, f.name, f.old_name, f.adds, f.hidden])).toEqual([['modified', 'src/a.ts', null, 3, false], ['renamed', 'b.txt', 'a.txt', null, false], ['added', null, null, null, true]]);
    expect([ready.more, ready.total]).toEqual([true, 260]);
  });

  it('never looks again once it has the list (the server deleted it on reading) — a third GET is not made', async () => {
    const w = world({ look: [json(200, { state: 'done', files: [file()], more: false, total: 1 }), json(404, { error: { code: 'changes_read_not_found' } })] });
    await run(w);
    expect(w.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('a 404 while looking is «expired · try again», never shown as a fault; a 429 (looked too soon) is waited out and looked at again', async () => {
    const taken = await run(world({ look: [json(404, { error: { code: 'changes_read_not_found' } })] }));
    expect(taken.at(-1)).toEqual({ kind: 'problem', problem: 'expired', retry: true });
    const w = world({ look: [json(429, { error: { code: 'changes_polled_too_fast' } }), json(200, { state: 'done', files: [file()], more: false, total: 1 })] });
    const states = await run(w);
    expect(states.at(-1)!.kind).toBe('ready');
    expect(w.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('every refusal of the ask is a closed word: not paired · computer silent · remote control off · busy · too fast', async () => {
    const cases: Array<[number, string, string, boolean]> = [
      [403, 'not_allowed_to_read_changes', 'not_allowed', false], [409, 'device_unreachable', 'unreachable', true], [409, 'remote_control_off', 'remote_off', false],
      [409, 'changes_busy', 'busy', true], [429, 'changes_too_fast', 'too_fast', true], [404, 'session_not_found', 'session_gone', false],
    ];
    for (const [status, code, problem, retry] of cases) {
      const states = await run(world({ ask: [json(status, { error: { code } })] }));
      expect(states).toEqual([{ kind: 'asking' }, { kind: 'problem', problem, retry }]);
    }
  });

  it('every outcome word of the computer is a closed word of the screen; an unknown one is the generic «failed», retryable', async () => {
    for (const [code, problem] of [['no_folder', 'no_folder'], ['not_a_repo', 'not_a_repo'], ['not_repo_root', 'not_repo_root'], ['unsafe_repo_config', 'unsafe_repo_config'], ['git_missing', 'git_missing'], ['timeout', 'timeout'], ['busy', 'busy'], ['upload_failed', 'upload_failed'], ['something_new', 'failed']] as const) {
      const states = await run(world({ look: [json(200, { state: 'failed', code, files: null })] }));
      expect(states.at(-1)).toMatchObject({ kind: 'problem', problem });
    }
    // a stale rejection from the server's own queue (`rejected · expired`) reads as «expired»
    expect((await run(world({ look: [json(200, { state: 'rejected', code: 'expired', files: null })] }))).at(-1)).toMatchObject({ problem: 'expired' });
  });

  it('gives up before the server\'s row ends (120 s): `expired · try again`', async () => {
    const w = world({ look: Array.from({ length: 200 }, () => json(200, { state: 'delivered', files: null })) });
    const states = await run(w);
    expect(states.at(-1)).toEqual({ kind: 'problem', problem: 'expired', retry: true });
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(GIVE_UP_MS + POLL_MS);
  });

  it('every look says `cache: no-store`, and a look answered with something that is not a JSON object ends «failed · retry» — never a read stuck on «waiting» (codex ①c r1 #3 · #4)', async () => {
    const w = world({ look: [json(200, { state: 'done', files: [], more: false, total: 0 })] });
    const inits: Array<RequestInit | undefined> = []; const real = w.deps.fetch;
    w.deps.fetch = async (u, i) => { if (i?.method !== 'POST') inits.push(i); return real(u, i); };
    await run(w);
    expect(inits).toEqual([{ cache: 'no-store' }]);
    for (const body of ['not json at all', 'null', '[1,2]', '"text"']) {
      const states = await run(world({ look: [new Response(body, { status: 200 })] }));
      expect(states.at(-1), body).toEqual({ kind: 'problem', problem: 'failed', retry: true });
    }
  });

  it('a cancelled read (the sheet closed) stops at once and says nothing more', async () => {
    let n = 0;
    const w = world({ look: [json(200, { state: 'delivered', files: null }), json(200, { state: 'done', files: [file()], more: false, total: 1 })] });
    const states = await run(w, () => n++ >= 2);
    expect(states.at(-1)!.kind).not.toBe('ready');
  });

  it('the computer ending «done» with no list is an empty list; a network hiccup while looking is looked at again', async () => {
    expect((await run(world({ look: [json(200, { state: 'done', code: 'ok', files: null })] }))).at(-1)).toMatchObject({ kind: 'ready', files: [] });
    const w = world({ look: [json(200, { state: 'done', files: [file()], more: false, total: 1 })] });
    let first = true; const real = w.deps.fetch;
    w.deps.fetch = async (u, i) => { if (!first || i?.method === 'POST') return real(u, i); first = false; throw new Error('offline'); };
    expect((await run(w)).at(-1)!.kind).toBe('ready');
  });
});

describe('normalizeFile / problemOf', () => {
  it('a hidden row carries no name, no counts; a row of an unknown status is shown as «modified»; a row with no name that is not hidden is dropped', () => {
    expect(normalizeFile(file({ hidden: true, name: 'SECRET.env', adds: 9, old_name: 'x' }))).toEqual({ status: 'modified', name: null, old_name: null, adds: null, dels: null, binary: false, hidden: true });
    expect(normalizeFile(file({ status: 'brand-new' }))!.status).toBe('modified');
    expect(normalizeFile(file({ name: undefined }))).toBeNull();
    expect(normalizeFile(null)).toBeNull();
    expect(normalizeFile(file({ adds: -1, dels: 'x' }))).toMatchObject({ adds: null, dels: null });
  });
  it('maps by status when the code is missing: 403 → not allowed, 429 → too fast, anything else → failed (retry)', () => {
    expect(problemOf(403, undefined)).toEqual({ problem: 'not_allowed', retry: false });
    expect(problemOf(429, undefined)).toEqual({ problem: 'too_fast', retry: true });
    expect(problemOf(500, undefined)).toEqual({ problem: 'failed', retry: true });
  });
});
