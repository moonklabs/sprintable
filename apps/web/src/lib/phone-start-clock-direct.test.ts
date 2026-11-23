// story 4993 (5b-1) — a START and a CLOCK press of one agent go over the same-network direct road FIRST and to the server when they do not; their rows are the ones contracts/direct-rows.json says (the server's test reads the same file);
// every way a direct press ends reads as the server's line reads — the same screen; a press NEVER waits for a road to be made.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { directRow } from './phone-direct';
import { checkPress, pressClock, type PressDeps, type PressInput } from './phone-clock';
import { checkStart, startOnPhone, type StartDeps, type StartInput } from './phone-start';
import type { PhoneAnswer } from './phone-bridge';

let serverCalls: Array<{ url: string; init?: RequestInit }> = [];
let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => { serverCalls.push({ url, init }); return currentFetch(url, init); } }));

const ROOT = path.resolve(__dirname, '../../../..');
type Other = { name: string; verb: 'start' | 'clock' | 'approval'; kind: string; session_key: string | null; body_extra?: Record<string, unknown>; payload_keys: string[] };
const ROWS = JSON.parse(readFileSync(path.join(ROOT, 'contracts', 'direct-rows.json'), 'utf8')) as { row_keys: string[]; other_routes: Other[]; never_direct_other: Array<{ name: string; verb: 'clock'; body_extra: Record<string, unknown> }> };

const AGENT = '22222222-3333-4444-8555-666666666666';
const PROJECT = '33333333-4444-4555-8666-777777777777';
const CMD = '44444444-5555-4666-8777-888888888888';
let n = 0; const freshSetup = () => `0f0e0d0c-0b0a-4908-8706-${String(++n).padStart(12, '0')}`; // (each test its own computer: the page keeps one «opened lately» note per computer)
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const reset = () => { serverCalls = []; currentFetch = async () => { throw new Error('the server must not be called'); }; };
const posts = () => serverCalls.filter((c) => c.init?.method === 'POST');

type Handler = PhoneAnswer | ((args: Record<string, unknown>) => PhoneAnswer | Promise<PhoneAnswer>);
function shell(map: Record<string, Handler>) {
  const log: Array<{ type: string; args: Record<string, unknown> }> = [];
  const phoneCall = vi.fn(async (type: string, args: Record<string, unknown>) => { log.push({ type, args }); const h = map[type]; if (h === undefined) throw new Error(`no handler: ${type}`); return typeof h === 'function' ? h(args) : h; });
  return { phoneCall, log, count: (t: string) => log.filter((l) => l.type === t).length };
}
const CAPS: PhoneAnswer = { id: 'c', ok: true, caps: { sealed_prompt: 1, direct: 1 } };
const SIGNED: PhoneAnswer = { id: 'w', ok: true, signed: 'SIGNED-X', phone_key_id: 'k-1' };
const READY: PhoneAnswer = { id: 's', ok: true, state: 'ready' };
const direct = (result: Handler, extra: Record<string, Handler> = {}) => ({ 'shell.caps': CAPS, 'direct.status': READY, 'direct.send': { id: 'x', ok: true, sent: true }, 'direct.result': result, ...extra });
const startDeps = (phoneCall: StartDeps['phoneCall'], extra: Partial<StartDeps> = {}): StartDeps => ({ phoneCall, newKey: () => 'press-key-0001', wait: async () => {}, pollMs: 1, ...extra });
const clockDeps = (phoneCall: PressDeps['phoneCall'], extra: Partial<PressDeps> = {}): PressDeps => ({ phoneCall, newKey: () => 'press-key-0002', wait: async () => {}, pollMs: 1, ...extra });
const startIn = (setupId: string): StartInput => ({ setupId, agentId: AGENT, projectId: PROJECT });
const clockIn = (setupId: string, over: Partial<PressInput> = {}): PressInput => ({ setupId, action: 'out_open', agentId: AGENT, ...over });

describe('[4993 5b-1] the rows (contracts/direct-rows.json other_routes)', () => {
  const bodies: Record<string, Record<string, unknown>> = {
    start: { setup_id: 'S', project_id: PROJECT, signed: 'SIGNED-X', phone_key_id: 'k-1' },
    clock: { action: 'out_open', signed: 'SIGNED-X', phone_key_id: 'k-1', agent_member_id: AGENT },
    approval: { session_key: 's-9', request_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd', decision: 'allow', signed: 'SIGNED-A', phone_key_id: 'k-1' },
  };
  for (const c of ROWS.other_routes) {
    it(`${c.name}: the payload is exactly ${c.payload_keys.join(' · ')}, the row has no session, the command id is the press's key`, () => {
      const body = { ...bodies[c.verb]!, ...(c.body_extra ?? {}) }; if (c.verb === 'clock' && !c.payload_keys.includes('agent_member_id')) delete body.agent_member_id;
      const row = directRow({ verb: c.verb, key: 'press-key-0003', body, ...(c.verb === 'start' ? { agentId: AGENT } : {}) }, Date.UTC(2026, 10, 23, 9, 0, 0))!;
      expect(Object.keys(row)).toEqual(ROWS.row_keys);
      expect(row.kind).toBe(c.kind); expect(row.session_key).toBe(typeof c.session_key === 'string' ? 's-9' : null); expect(row.command_id).toBe('press-key-0003');
      expect(Object.keys(row.payload as object)).toEqual(c.payload_keys);
      expect(row.payload).toEqual(Object.fromEntries(c.payload_keys.map((k) => [k, k === 'agent_member_id' ? AGENT : body[k]])));
      expect(Object.keys(row.payload as object)).not.toContain('phone_key_id');
    });
  }
  for (const c of ROWS.never_direct_other) {
    it(`${c.name} never rides the road`, () => { expect(directRow({ verb: c.verb, key: 'press-key-0003', body: { ...bodies.clock!, ...c.body_extra } }, Date.now())).toBeNull(); });
  }
  it('an ANSWER to a permission request: nothing without its session · request id · a decision of the two words · a signature; a stage of another word is no row; a first answer never carries a host', () => {
    const ok = bodies.approval!; const row = (over: Record<string, unknown>) => directRow({ verb: 'approval', key: 'press-key-0003', body: { ...ok, ...over } }, Date.now());
    expect(row({})).not.toBeNull();
    for (const over of [{ session_key: undefined }, { session_key: '' }, { request_id: undefined }, { request_id: '' }, { decision: 'maybe' }, { decision: undefined }, { signed: undefined }, { signed: '' }, { stage: 'bogus' }, { stage: 'confirm' }, { stage: 'confirm', host: '' }]) expect(row(over), JSON.stringify(over)).toBeNull();
    expect(row({ stage: 'ask', host: 'gitlab.com' })!.payload).not.toHaveProperty('host'); expect(row({ host: 'gitlab.com' })!.payload).not.toHaveProperty('stage');
    expect(row({ stage: 'confirm', host: 'gitlab.com' })!.payload).toMatchObject({ stage: 'confirm', host: 'gitlab.com' });
  });
  it('nothing without the signature or the ids a row must carry', () => {
    expect(directRow({ verb: 'start', key: 'press-key-0003', body: { ...bodies.start!, signed: '' }, agentId: AGENT }, Date.now())).toBeNull();
    expect(directRow({ verb: 'start', key: 'press-key-0003', body: bodies.start! }, Date.now())).toBeNull(); // (no agent)
    expect(directRow({ verb: 'start', key: 'press-key-0003', body: { ...bodies.start!, project_id: undefined }, agentId: AGENT }, Date.now())).toBeNull();
    expect(directRow({ verb: 'clock', key: 'press-key-0003', body: { ...bodies.clock!, signed: undefined } }, Date.now())).toBeNull();
    expect(directRow({ verb: 'clock', key: 'press-key-0003', body: { ...bodies.clock!, action: undefined } }, Date.now())).toBeNull();
    expect(directRow({ verb: 'clock', key: 'press-key-0003', body: { ...bodies.clock!, action: '' } }, Date.now())).toBeNull();
    expect(directRow({ verb: 'clock', key: 'press-key-0003', body: { ...bodies.clock!, agent_member_id: 7 } }, Date.now())).toBeNull();
    expect(directRow({ verb: 'start', key: 'x', body: bodies.start!, agentId: AGENT }, Date.now())).toBeNull(); // (a key the Mac would not take as an id)
  });
});

describe('[4993 5b-1] a start over the road', () => {
  it('signed, sent over the road, its word read from the shell — the server is never called', async () => {
    reset(); const setup = freshSetup(); const s = shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'done' }) });
    await expect(startOnPhone(startIn(setup), startDeps(s.phoneCall))).resolves.toEqual({ kind: 'started' });
    expect(serverCalls).toEqual([]);
    expect(s.log.find((l) => l.type === 'direct.send')!.args).toEqual({ setup_id: setup, row: expect.objectContaining({ command_id: 'press-key-0001', kind: 'start_session', session_key: null, payload: { agent_member_id: AGENT, project_id: PROJECT, signed: 'SIGNED-X' } }) });
    expect(s.log.find((l) => l.type === 'direct.result')!.args).toEqual({ setup_id: setup, command_id: 'press-key-0001' });
  });
  it('THE SAME SCREEN: every (state, code) the daemon can say ends as the same outcome whether the line came from the server or from the road', async () => {
    const pairs: Array<[string, string | null]> = [['done', null], ['rejected', 'already_running'], ['rejected', 'no_folder'], ['failed', 'workdir_refused'], ['failed', 'remote_control_off'], ['rejected', 'remote_control_off'], ['rejected', 'bad_signature'], ['failed', 'error'], ['rejected', 'unsigned']];
    for (const [state, code] of pairs) {
      reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state, result_code: code }));
      const viaServer = await startOnPhone(startIn(freshSetup()), startDeps(shell({ 'command.sign': SIGNED, 'shell.caps': { id: 'c', ok: true, caps: {} } }).phoneCall));
      reset(); const viaRoad = await startOnPhone(startIn(freshSetup()), startDeps(shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state, ...(code ? { code } : {}) }) }).phoneCall));
      expect(viaRoad, `${state} ${code}`).toEqual(viaServer);
    }
  });
  it('NO ROAD YET: the press reaches the server\'s POST in the same breath (no fake clock moved) — and the road is opened behind it, once', async () => {
    vi.useFakeTimers();
    try {
      reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'done' }));
      const setup = freshSetup(); const s = shell({ 'command.sign': SIGNED, 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'idle' }, 'direct.open': new Promise<PhoneAnswer>(() => {}) as unknown as PhoneAnswer });
      const out = startOnPhone(startIn(setup), startDeps(s.phoneCall)); await expect(out).resolves.toEqual({ kind: 'started' });
      expect(posts().length).toBe(1); expect(s.count('direct.open')).toBe(1); expect(s.count('direct.send')).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('a shell without the road, a road that is being made, and a refusal of the send all go to the server — the signature is made once', async () => {
    for (const map of [{ 'shell.caps': { id: 'c', ok: true, caps: {} } }, { 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'connecting' } }, direct({ id: 'r', ok: true, state: 'done' }, { 'direct.send': { id: 'x', ok: true, sent: false, why: 'busy' } })] as Array<Record<string, Handler>>) {
      reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'done' }));
      const s = shell({ 'command.sign': SIGNED, ...map }); await expect(startOnPhone(startIn(freshSetup()), startDeps(s.phoneCall))).resolves.toEqual({ kind: 'started' });
      expect(posts().length).toBe(1); expect(s.count('command.sign')).toBe(1);
    }
  });
  it('MISSED (the frame may have reached the computer): to the server marked, and its «replay» is not told as a failure', async () => {
    reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'rejected', result_code: 'envelope_replay' }));
    const s = shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'done' }, { 'direct.send': { id: 'x', ok: true, sent: false, why: 'ack' } }) });
    const out = await startOnPhone(startIn(freshSetup()), startDeps(s.phoneCall)); expect(out).toMatchObject({ kind: 'unknown', pending: { afterDirectMiss: true } }); expect(posts().length).toBe(1);
  });
  it('a replay word over the road is unknown (the computer already had it); a word nobody knows is asked again; «unknown» from the shell ends it as unknown — never posted', async () => {
    for (const code of ['reused', 'envelope_replay']) {
      reset(); const out = await startOnPhone(startIn(freshSetup()), startDeps(shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'rejected', code }) }).phoneCall));
      expect(out).toMatchObject({ kind: 'unknown', pending: { direct: { setupId: expect.any(String) } } }); expect(serverCalls).toEqual([]);
    }
    reset(); let asks = 0; const s = shell({ 'command.sign': SIGNED, ...direct(() => (++asks < 3 ? { id: 'r', ok: true, state: 'pending' } : { id: 'r', ok: true, state: 'done' })) });
    await expect(startOnPhone(startIn(freshSetup()), startDeps(s.phoneCall))).resolves.toEqual({ kind: 'started' }); expect(s.count('direct.result')).toBe(3);
    reset(); await expect(startOnPhone(startIn(freshSetup()), startDeps(shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'unknown' }) }).phoneCall))).resolves.toMatchObject({ kind: 'unknown' }); expect(serverCalls).toEqual([]);
  });
  it('a send the shell never answers is «maybe»: it may have gone — followed over the road, NEVER posted', async () => {
    vi.useFakeTimers();
    try {
      reset(); const s = shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'done' }, { 'direct.send': () => new Promise<PhoneAnswer>(() => {}) }) });
      const out = startOnPhone(startIn(freshSetup()), startDeps(s.phoneCall)); await vi.advanceTimersByTimeAsync(10_001);
      await expect(out).resolves.toEqual({ kind: 'started' }); expect(serverCalls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it('a start that went by the server only (no road) and is refused as a replay there is a FAILURE — «the computer already had it» is said only of a press the road may have carried', async () => {
    reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'rejected', result_code: 'envelope_replay' }));
    await expect(startOnPhone(startIn(freshSetup()), startDeps(shell({ 'command.sign': SIGNED, 'shell.caps': { id: 'c', ok: true, caps: {} } }).phoneCall))).resolves.toEqual({ kind: 'failed' });
  });
  it('the road never answers: the follow ends as unknown at the window\'s end (the wall clock\'s), never posted', async () => {
    reset(); const out = await startOnPhone(startIn(freshSetup()), startDeps(shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'pending' }) }).phoneCall, { pollMaxMs: 20 }));
    expect(out).toMatchObject({ kind: 'unknown', pending: { direct: { setupId: expect.any(String) } } }); expect(serverCalls).toEqual([]);
  });
  it('[결과 확인] of a direct start asks the shell again and never posts', async () => {
    reset(); const setup = freshSetup(); const first = await startOnPhone(startIn(setup), startDeps(shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'unknown' }) }).phoneCall));
    if (first.kind !== 'unknown') throw new Error('expected unknown');
    const again = shell({ 'direct.result': { id: 'r', ok: true, state: 'done' } }); await expect(checkStart(first.pending, startDeps(again.phoneCall))).resolves.toEqual({ kind: 'started' }); expect(serverCalls).toEqual([]);
  });
  it('a flow that was left makes no further ask over the road', async () => {
    reset(); const flow = { stopped: false }; let asks = 0;
    const s = shell({ 'command.sign': SIGNED, ...direct(() => { asks += 1; flow.stopped = true; return { id: 'r', ok: true, state: 'pending' }; }) });
    await expect(startOnPhone(startIn(freshSetup()), startDeps(s.phoneCall, { flow: flow as StartDeps['flow'] }))).resolves.toEqual({ kind: 'stopped' }); expect(asks).toBe(1); expect(serverCalls).toEqual([]);
  });
});

describe('[4993 5b-1] a clock press over the road', () => {
  it('one agent: signed, sent over the road, its word read from the shell — the server is never called', async () => {
    reset(); const setup = freshSetup(); const s = shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'done', code: 'ok' }) });
    await expect(pressClock(clockIn(setup), clockDeps(s.phoneCall))).resolves.toEqual({ kind: 'done', result: 'ok' }); expect(serverCalls).toEqual([]);
    expect(s.log.find((l) => l.type === 'direct.send')!.args.row).toMatchObject({ command_id: 'press-key-0002', kind: 'clock', session_key: null, payload: { action: 'out_open', signed: 'SIGNED-X', agent_member_id: AGENT } });
  });
  it('a clock press that went by the server only (no road) and is refused as a replay there is a FAILURE — «the computer already had it» is said only of a press the road may have carried', async () => {
    reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'rejected', result_code: 'reused' }));
    await expect(pressClock(clockIn(freshSetup()), clockDeps(shell({ 'command.sign': SIGNED, 'shell.caps': { id: 'c', ok: true, caps: {} } }).phoneCall))).resolves.toEqual({ kind: 'failed' });
  });
  it('the press of the WHOLE computer is the server\'s way: no road is asked for', async () => {
    reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'done', result_code: 'ok' }));
    const s = shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'done', code: 'ok' }) });
    await expect(pressClock({ setupId: freshSetup(), action: 'out_open', computer: true }, clockDeps(s.phoneCall))).resolves.toEqual({ kind: 'done', result: 'ok' });
    expect(posts().length).toBe(1); expect(s.count('direct.send')).toBe(0);
  });
  it('THE SAME SCREEN: every (state, code) ends as the same outcome whether the line came from the server or from the road', async () => {
    const pairs: Array<[string, string | null]> = [['done', 'ok'], ['done', 'already'], ['done', 'nothing_running'], ['done', 'needs_hands'], ['done', 'a-word-nobody-knows'], ['done', null], ['rejected', 'remote_control_off'], ['failed', 'remote_control_off'], ['rejected', 'bad_signature'], ['failed', 'error']];
    for (const [state, code] of pairs) {
      reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state, result_code: code }));
      const viaServer = await pressClock(clockIn(freshSetup()), clockDeps(shell({ 'command.sign': SIGNED, 'shell.caps': { id: 'c', ok: true, caps: {} } }).phoneCall));
      reset(); const viaRoad = await pressClock(clockIn(freshSetup()), clockDeps(shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state, ...(code ? { code } : {}) }) }).phoneCall));
      expect(viaRoad, `${state} ${code}`).toEqual(viaServer);
    }
  });
  it('NO ROAD YET: the press reaches the server\'s POST in the same breath (no fake clock moved) — and the road is opened behind it', async () => {
    vi.useFakeTimers();
    try {
      reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'done', result_code: 'ok' }));
      const s = shell({ 'command.sign': SIGNED, 'shell.caps': CAPS, 'direct.status': { id: 's', ok: true, state: 'idle' }, 'direct.open': new Promise<PhoneAnswer>(() => {}) as unknown as PhoneAnswer });
      await expect(pressClock(clockIn(freshSetup()), clockDeps(s.phoneCall))).resolves.toEqual({ kind: 'done', result: 'ok' });
      expect(posts().length).toBe(1); expect(s.count('direct.open')).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it('MISSED: to the server marked, its «replay» is unknown; a replay word over the road is unknown too; the end of the window over the road is unknown, never «expired»', async () => {
    reset(); currentFetch = async (_u, init) => (init?.method === 'POST' ? json(201, { command_id: CMD, state: 'queued' }) : json(200, { state: 'rejected', result_code: 'reused' }));
    const m = shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'done' }, { 'direct.send': { id: 'x', ok: true, sent: false, why: 'closed' } }) });
    await expect(pressClock(clockIn(freshSetup()), clockDeps(m.phoneCall))).resolves.toMatchObject({ kind: 'unknown', pending: { afterDirectMiss: true } });
    reset(); await expect(pressClock(clockIn(freshSetup()), clockDeps(shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'rejected', code: 'envelope_replay' }) }).phoneCall))).resolves.toMatchObject({ kind: 'unknown', pending: { direct: true } });
    reset(); await expect(pressClock(clockIn(freshSetup()), clockDeps(shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'pending' }) }).phoneCall, { pollMaxMs: 20 }))).resolves.toMatchObject({ kind: 'unknown' }); expect(serverCalls).toEqual([]);
  });
  it('a send the shell never answers is «maybe»: it may have gone — followed over the road, NEVER posted', async () => {
    vi.useFakeTimers();
    try {
      reset(); const s = shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'done', code: 'ok' }, { 'direct.send': () => new Promise<PhoneAnswer>(() => {}) }) });
      const out = pressClock(clockIn(freshSetup()), clockDeps(s.phoneCall)); await vi.advanceTimersByTimeAsync(10_001);
      await expect(out).resolves.toEqual({ kind: 'done', result: 'ok' }); expect(serverCalls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it('[결과 확인] of a direct press asks the shell again and never posts; a flow that was left makes no further ask', async () => {
    reset(); const first = await pressClock(clockIn(freshSetup()), clockDeps(shell({ 'command.sign': SIGNED, ...direct({ id: 'r', ok: true, state: 'unknown' }) }).phoneCall));
    if (first.kind !== 'unknown') throw new Error('expected unknown');
    await expect(checkPress(first.pending, clockDeps(shell({ 'direct.result': { id: 'r', ok: true, state: 'done', code: 'already' } }).phoneCall))).resolves.toEqual({ kind: 'done', result: 'already' }); expect(serverCalls).toEqual([]);
    const flow = { stopped: false }; let asks = 0;
    const s = shell({ 'command.sign': SIGNED, ...direct(() => { asks += 1; flow.stopped = true; return { id: 'r', ok: true, state: 'pending' }; }) });
    await expect(pressClock(clockIn(freshSetup()), clockDeps(s.phoneCall, { flow: flow as PressDeps['flow'] }))).resolves.toEqual({ kind: 'stopped' }); expect(asks).toBe(1); expect(serverCalls).toEqual([]);
  });
});
