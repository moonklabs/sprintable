// story 4993 (file direct · the web's side) — a download goes on the DIRECT road first when the shell has one, and the server's road gives the same file otherwise or after a break:
//   · one confirmation for one download on the direct road; a SECOND only when a direct download broke and the file is asked for again from the start (no resume — the first request was spent on the computer)
//   · a request that was never put on the road (no road · a shell that does not ride a download) is posted to the server as it is: the same seal, no second confirmation
//   · a computer's refusal about the FILE ends the download as it is; a word that is the road's own goes on to the server's road
//   · the page never sees a byte and never calls the server for a direct download
import { describe, expect, it, vi } from 'vitest';
import { downloadFile, type DownloadDeps } from './phone-files';
import { directRow } from './phone-direct';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PhoneAnswer } from './phone-bridge';

let serverCalls: Array<{ method: string; url: string; body?: unknown }> = [];
let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('the server must not be called'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => { serverCalls.push({ method: init?.method ?? 'GET', url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) }); return currentFetch(url, init); } }));

const BRIDGE = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contracts/direct-bridge.json'), 'utf8')) as { version: number; calls: Record<string, { reply: Record<string, string> }> };
const SETUP = '22222222-3333-4444-8555-666666666666';
const CMD = '44444444-5555-4666-8777-888888888888';
const K1 = 'press-key-0001'; const K2 = 'press-key-0002';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const sealOf = (key: string): PhoneAnswer => ({ id: 'w', ok: true, envelope: { v: 1, kind: 'file_download', for: key }, phone_key_id: 'k-1', idempotency_key: key });
const input = { setupId: SETUP, projectId: 'proj-1', dir: ['out'], name: 'app.apk' };
const MORE = (got: number, of: number): PhoneAnswer => ({ id: 's', ok: true, state: 'more', got, of });
const SAVED_STEP: PhoneAnswer = { id: 's', ok: true, state: 'saved' };
const reset = () => { serverCalls = []; currentFetch = async () => { throw new Error('the server must not be called'); }; };

/** the server's road: the ask is answered and the chunks are `ready` */
function serverRoad() {
  currentFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST') return json(201, { command_id: CMD, expires_at: 'x' });
    if (method === 'DELETE') return json(200, { deleted: true });
    const m = /\/chunks\/(\d+)$/.exec(url); if (!m) throw new Error('unexpected GET ' + url);
    return json(200, { state: 'ready', code: null, envelope: { v: 1, kind: 'file_result', chunk: Number(m[1]) } });
  };
}

type Handler = PhoneAnswer | ((args: Record<string, unknown>) => PhoneAnswer | Promise<PhoneAnswer>);
interface Road { caps?: unknown; status?: string; send?: Handler; results?: PhoneAnswer[]; save?: Handler }
/** a shell with a road: every call is recorded; `files.seal` answers for whatever key it is asked with */
function shell(r: Road = {}, extra: Record<string, Handler> = {}) {
  const log: Array<{ type: string; args: Record<string, unknown> }> = [];
  const results = [...(r.results ?? [])];
  const answers: Record<string, Handler> = {
    'files.seal': (a) => sealOf(String(a.idempotency_key)),
    'shell.caps': { id: 'c', ok: true, caps: r.caps ?? { direct: 1, files: 1, file_download: 1 } },
    'direct.status': { id: 's', ok: true, state: r.status ?? 'ready' },
    'direct.send': r.send ?? { id: 'd', ok: true, sent: true },
    'direct.result': () => results.length > 1 ? results.shift()! : results[0] ?? { id: 'r', ok: true, state: 'pending' },
    'direct.download_save': r.save ?? { id: 'v', ok: true, state: 'saved' },
    'files.download_cancel': { id: 'x', ok: true },
    'files.download_step': (a) => ((a.envelope as { chunk: number }).chunk === 0 ? MORE(1, 2) : SAVED_STEP),
    ...extra,
  };
  let n = 0; const keys = [K1, K2, 'press-key-0003'];
  const phoneCall = vi.fn(async (type: string, args: Record<string, unknown> = {}) => { log.push({ type, args }); const a = answers[type]; return typeof a === 'function' ? a(args) : a ?? { id: 'x', ok: false, code: 'failed' }; });
  return { log, deps: { phoneCall, newKey: () => keys[n++]!, wait: async () => {} } as DownloadDeps, of: (t: string) => log.filter((l) => l.type === t).map((l) => l.args) };
}
const DONE: PhoneAnswer = { id: 'r', ok: true, state: 'done', code: 'ok', size: 100 };
const pending: PhoneAnswer = { id: 'r', ok: true, state: 'pending' };

describe('[4993 file direct] the direct road is the first road', () => {
  it('ONE confirmation, the request goes on the road as a `file_download` row, the file is handed to the share sheet by the shell — nothing goes to the server, no byte is in the page', async () => {
    reset(); const s = shell({ results: [pending, pending, DONE] });
    expect(await downloadFile(input, s.deps)).toEqual({ kind: 'saved' });
    expect(s.of('files.seal')).toEqual([{ setup_id: SETUP, project_id: 'proj-1', dir: ['out'], name: 'app.apk', idempotency_key: K1, download: true }]);
    const [sent] = s.of('direct.send') as Array<{ setup_id: string; row: Record<string, unknown> }>;
    expect(sent!.setup_id).toBe(SETUP);
    expect(Object.keys(sent!.row)).toEqual(['command_id', 'kind', 'session_key', 'payload', 'created_at']);
    expect([sent!.row.command_id, sent!.row.kind, sent!.row.session_key]).toEqual([K1, 'file_download', null]);
    expect(sent!.row.payload).toEqual({ project_id: 'proj-1', envelope: sealOf(K1).envelope });
    expect(JSON.stringify(sent!.row)).not.toContain('app.apk'); // (the name is inside the shell's own sealed envelope: never in the row's plain keys)
    expect(s.of('direct.result').every((a) => a.setup_id === SETUP && a.command_id === K1)).toBe(true);
    expect(s.of('direct.download_save')).toEqual([{ setup_id: SETUP, idempotency_key: K1 }]);
    expect(serverCalls).toEqual([]); // nothing about the file was asked of the server
    expect(s.log.map((l) => l.type)).not.toContain('files.download_step');
    expect(s.log.map((l) => l.type)).not.toContain('files.download_cancel'); // (the shell took the whole file and handed it over: nothing is left in it to drop)
  });

  it('a road that is not ready, a shell without a road, a shell that does not ride a download: the server\'s road takes the SAME request — one seal, no second confirmation, nothing was put on the road', async () => {
    const cases: Array<[string, Road]> = [
      ['the road is idle', { status: 'idle' }],
      ['the road is being made', { status: 'connecting' }],
      ['the shell has no road', { caps: { direct: 0, files: 1, file_download: 1 } }],
      ['a shell that does not carry a download says not_allowed', { send: { id: 'd', ok: true, sent: false, why: 'not_allowed' } }],
      ['the road is busy with another download', { send: { id: 'd', ok: true, sent: false, why: 'busy' } }],
      ['the road is not open', { send: { id: 'd', ok: true, sent: false, why: 'not_open' } }],
    ];
    for (const [name, road] of cases) {
      reset(); serverRoad(); const s = shell(road);
      expect(await downloadFile(input, s.deps), name).toEqual({ kind: 'saved' });
      expect(s.of('files.seal').length, `${name}: one confirmation`).toBe(1);
      const post = serverCalls.find((c) => c.method === 'POST' && c.url.endsWith('/files'))!;
      expect(post.body, name).toEqual({ project_id: 'proj-1', idempotency_key: K1, phone_key_id: 'k-1', envelope: sealOf(K1).envelope });
      expect(s.of('direct.download_save'), name).toEqual([]);
    }
  });

  it('a download that BREAKS on the road (the shell has no word any more: the road ended) is asked from the start on the server\'s road — a NEW seal (the second confirmation), the first one dropped in the shell, no resume', async () => {
    reset(); serverRoad(); const s = shell({ results: [pending, { id: 'r', ok: true, state: 'unknown' }] });
    expect(await downloadFile(input, s.deps)).toEqual({ kind: 'saved' });
    expect(s.of('files.seal').map((a) => a.idempotency_key)).toEqual([K1, K2]);
    expect(s.log.findIndex((l) => l.type === 'files.download_cancel' && l.args.idempotency_key === K1)).toBeGreaterThan(-1);
    expect(s.log.findIndex((l) => l.type === 'files.download_cancel' && l.args.idempotency_key === K1)).toBeLessThan(s.log.findLastIndex((l) => l.type === 'files.seal'));
    const post = serverCalls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ project_id: 'proj-1', idempotency_key: K2, phone_key_id: 'k-1', envelope: sealOf(K2).envelope }); // (the NEW press, not the spent one)
    expect(serverCalls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([0, 1].map((i) => `/api/desktop/computers/${SETUP}/files/${CMD}/chunks/${i}`));
    expect(s.of('files.download_step').every((a) => a.idempotency_key === K2)).toBe(true);
  });

  it('the spent request is dropped in the shell BEFORE the second one is sealed, and a shell that never answers the drop holds the download for 3 seconds at most', async () => {
    reset(); serverRoad(); let dropped = false;
    let s = shell({ results: [{ id: 'r', ok: true, state: 'unknown' }] }, { 'files.download_cancel': async () => { await new Promise((r) => setTimeout(r, 30)); dropped = true; return { id: 'x', ok: true }; }, 'files.seal': (a) => { if (a.idempotency_key === K2 && !dropped) throw new Error('sealed before the drop was done'); return sealOf(String(a.idempotency_key)); } });
    expect(await downloadFile(input, s.deps)).toEqual({ kind: 'saved' }); expect(s.of('files.seal').length).toBe(2);
    reset(); serverRoad(); s = shell({ results: [{ id: 'r', ok: true, state: 'unknown' }] }, { 'files.download_cancel': () => new Promise<PhoneAnswer>(() => {}) });
    const t0 = Date.now(); expect(await downloadFile(input, s.deps)).toEqual({ kind: 'saved' }); expect(Date.now() - t0).toBeLessThan(6_000); expect(s.of('files.seal').length).toBe(2);
  }, 15_000);

  it('the road\'s OWN words (road full · closed · stopped · not supported · error · timeout · busy · bad file · incomplete · a word nobody knows) go on to the server\'s road from the start', async () => {
    for (const code of ['road_full', 'closed', 'stopped', 'not_supported', 'error', 'timeout', 'busy', 'bad_file', 'incomplete', 'schema_rejected', 'a_word_nobody_knows']) {
      reset(); serverRoad(); const s = shell({ results: [{ id: 'r', ok: true, state: 'failed', code }] });
      expect(await downloadFile(input, s.deps), code).toEqual({ kind: 'saved' });
      expect(s.of('files.seal').length, code).toBe(2);
    }
    reset(); serverRoad(); const s = shell({ results: [{ id: 'r', ok: true, state: 'rejected', code: 'schema_rejected' }] });
    expect(await downloadFile(input, s.deps)).toEqual({ kind: 'saved' }); expect(s.of('files.seal').length).toBe(2);
  });

  it('a computer\'s refusal about the FILE ends the download as it is (the server would say the same): no second confirmation, nothing to the server, and the shell drops the press', async () => {
    for (const reason of ['not_enabled', 'no_folder', 'not_found', 'is_link', 'hidden_name', 'looks_secret', 'too_big', 'not_text', 'not_plain', 'multi_linked', 'other_device', 'changed_while_reading', 'denied', 'unsupported']) {
      reset(); const s = shell({ results: [{ id: 'r', ok: true, state: 'failed', code: reason }] });
      expect(await downloadFile(input, s.deps), reason).toEqual({ kind: 'reason', reason });
      expect(s.of('files.seal').length, reason).toBe(1); expect(serverCalls, reason).toEqual([]);
      expect(s.of('files.download_cancel'), reason).toEqual([{ idempotency_key: K1 }]);
    }
  });

  it('the share sheet\'s words: «cancelled» and «save_failed» end it (the person was there); «incomplete» · «unknown_request» (the shell no longer has it) go to the server\'s road from the start', async () => {
    reset(); let s = shell({ results: [DONE], save: { id: 'v', ok: false, code: 'cancelled' } });
    expect(await downloadFile(input, s.deps)).toEqual({ kind: 'cancelled' }); expect(s.of('files.seal').length).toBe(1);
    reset(); s = shell({ results: [DONE], save: { id: 'v', ok: false, code: 'save_failed' } });
    expect(await downloadFile(input, s.deps)).toEqual({ kind: 'save_failed' }); expect(s.of('files.seal').length).toBe(1); expect(serverCalls).toEqual([]);
    for (const code of ['incomplete', 'unknown_request', 'busy', 'failed']) {
      reset(); serverRoad(); s = shell({ results: [DONE], save: { id: 'v', ok: false, code } });
      expect(await downloadFile(input, s.deps), code).toEqual({ kind: 'saved' }); expect(s.of('files.seal').length, code).toBe(2);
    }
  });

  it('the second confirmation that the person turns down (or a shell that cannot sign) ends the download with that word — the server is never asked', async () => {
    reset(); let n = 0; let s = shell({ results: [{ id: 'r', ok: true, state: 'failed', code: 'road_full' }] }, { 'files.seal': (a) => (++n === 1 ? sealOf(String(a.idempotency_key)) : { id: 'w', ok: false, code: 'cancelled' }) });
    expect(await downloadFile(input, s.deps)).toEqual({ kind: 'cancelled' }); expect(serverCalls).toEqual([]);
    reset(); n = 0; s = shell({ results: [{ id: 'r', ok: true, state: 'failed', code: 'road_full' }] }, { 'files.seal': (a) => (++n === 1 ? sealOf(String(a.idempotency_key)) : { id: 'w', ok: false, code: 'biometric_required' }) });
    expect(await downloadFile(input, s.deps)).toEqual({ kind: 'key', code: 'biometric_required' }); expect(serverCalls).toEqual([]);
  });

  it('«missed» (the frame may have reached the computer): the road is followed, never posted to the server with the same request', async () => {
    reset(); const s = shell({ send: { id: 'd', ok: true, sent: false, why: 'closed' }, results: [pending, DONE] });
    expect(await downloadFile(input, s.deps)).toEqual({ kind: 'saved' });
    expect(serverCalls).toEqual([]); expect(s.of('files.seal').length).toBe(1); expect(s.of('direct.result').length).toBeGreaterThan(0);
  });

  it('leaving the screen (stopped) while the road gives the file: no more asks, the shell drops it, nothing goes to the server, ends `cancelled`', async () => {
    reset(); let stop = false; const s = shell({ results: [pending] }, { 'direct.result': () => { stop = true; return pending; } });
    const out = await downloadFile(input, { ...s.deps, stopped: () => stop });
    expect(out).toEqual({ kind: 'cancelled' }); expect(serverCalls).toEqual([]);
    expect(s.of('files.download_cancel')).toEqual([{ idempotency_key: K1 }]);
    expect(s.of('direct.download_save')).toEqual([]);
  });

  it('the screen leaving ends the asks AT ONCE (one ask after it was left is the last), and a screen left while the road ends does not seal again', async () => {
    reset(); let stop = false; let s = shell({ results: [pending] }, { 'direct.result': () => { stop = true; return pending; } });
    expect(await downloadFile(input, { ...s.deps, stopped: () => stop })).toEqual({ kind: 'cancelled' }); expect(s.of('direct.result').length).toBe(1);
    reset(); stop = false; s = shell({}, { 'direct.result': () => { stop = true; return { id: 'r', ok: true, state: 'unknown' }; } });
    expect(await downloadFile(input, { ...s.deps, stopped: () => stop })).toEqual({ kind: 'cancelled' }); expect(s.of('files.seal').length).toBe(1); expect(serverCalls).toEqual([]);
  });

  it('a road that never says an end is given up at the five minutes (the clock is the page\'s): the server\'s road follows from the start', async () => {
    reset(); serverRoad(); let t = 1_000_000; let sealed = 0; const s = shell({ results: [pending] }, { 'files.seal': (a) => { sealed += 1; return sealOf(String(a.idempotency_key)); } });
    const out = await downloadFile(input, { ...s.deps, now: () => (sealed < 2 ? (t += 60_000) : t) }); // (the clock leaps while the direct road is followed and stands still once the server's road starts)
    expect(out).toEqual({ kind: 'saved' }); expect(s.of('files.seal').length).toBe(2); expect(s.of('direct.result').length).toBeLessThan(12);
  });

  it('a screen that was left before the request was put on the road puts nothing on it', async () => {
    reset(); let n = 0; const s = shell({}); const out = await downloadFile(input, { ...s.deps, stopped: () => ++n > 1 });
    expect(out).toEqual({ kind: 'cancelled' }); expect(s.of('direct.send')).toEqual([]); expect(serverCalls).toEqual([]);
  });

  it('a shell that cannot even answer `shell.caps` costs the download its one second at most and the server\'s road follows with the same request', async () => {
    reset(); serverRoad(); const s = shell({}, { 'shell.caps': () => new Promise<PhoneAnswer>(() => {}) });
    const out = await downloadFile(input, s.deps);
    expect(out).toEqual({ kind: 'saved' }); expect(s.of('files.seal').length).toBe(1);
  }, 10_000);
});

describe('[4993 file direct] the screen is the same on both roads: «n of m» from the shell\'s count', () => {
  const at = (got: unknown, of: unknown): PhoneAnswer => ({ id: 'r', ok: true, state: 'pending', got, of });
  it('every pending that carries pieces-taken of pieces-there-are is told to the screen, in order, and only those', async () => {
    reset(); const seen: Array<{ got: number; of: number }> = []; const s = shell({ results: [pending, at(1, 3), at(1, 3), at(2, 3), at(3, 3), DONE] });
    expect(await downloadFile(input, { ...s.deps, onProgress: (p) => seen.push(p) })).toEqual({ kind: 'saved' });
    expect(seen).toEqual([{ got: 1, of: 3 }, { got: 1, of: 3 }, { got: 2, of: 3 }, { got: 3, of: 3 }]); // (a plain pending — before the first piece — says nothing)
    expect(serverCalls).toEqual([]);
  });
  it('anything that is not a count (strings · fractions · zero · more taken than there are · negative · missing one) is not told', async () => {
    const bad: Array<[unknown, unknown]> = [['1', '3'], [1.5, 3], [0, 3], [4, 3], [-1, 3], [1, undefined], [undefined, 3], [null, null], [Number.NaN, 3], [Infinity, Infinity], [1, 0]];
    reset(); const seen: unknown[] = []; const s = shell({ results: [...bad.map(([g, o]) => at(g, o)), DONE] });
    expect(await downloadFile(input, { ...s.deps, onProgress: (p) => seen.push(p) })).toEqual({ kind: 'saved' });
    expect(seen).toEqual([]);
  });
  it('a count that arrives after the screen was left is not drawn', async () => {
    reset(); let stop = false; const seen: unknown[] = []; const s = shell({ results: [at(1, 3)] }, { 'direct.result': () => { stop = true; return at(2, 3); } });
    expect(await downloadFile(input, { ...s.deps, stopped: () => stop, onProgress: (p) => seen.push(p) })).toEqual({ kind: 'cancelled' });
    expect(seen).toEqual([]);
  });
  it('a screen whose drawing throws does not end the download', async () => {
    reset(); const s = shell({ results: [at(1, 2), DONE] });
    expect(await downloadFile(input, { ...s.deps, onProgress: () => { throw new Error('draw'); } })).toEqual({ kind: 'saved' });
  });
  it('the contract copy names the two numbers as additive fields of the pending word (the shell\'s side wrote them there first)', () => {
    expect(Object.keys(BRIDGE.calls['direct.result'].reply)).toEqual(['state', 'code', 'got', 'of']);
    expect(BRIDGE.calls['direct.result'].reply.got).toMatch(/only for a file download that is `pending`/); expect(BRIDGE.version).toBe(4);
  });
});

describe('[4993 file direct] the row of a download', () => {
  const ENV = { v: 1, kind: 'file_download' };
  const row = (over: Record<string, unknown> = {}, key = 'press-key-0001') => directRow({ verb: 'download', key, body: { project_id: 'proj-1', envelope: ENV, ...over } }, Date.UTC(2026, 10, 23, 9, 0, 0));
  it('is a `file_download` with exactly the project and the sealed envelope, no session, the press key as the command id — never a path, a name or the phone key id', () => {
    const r = row()!;
    expect(Object.keys(r)).toEqual(['command_id', 'kind', 'session_key', 'payload', 'created_at']);
    expect([r.command_id, r.kind, r.session_key, r.created_at]).toEqual(['press-key-0001', 'file_download', null, '2026-11-23T09:00:00.000Z']);
    expect(Object.keys(r.payload as object)).toEqual(['project_id', 'envelope']);
    expect(JSON.stringify(row({ phone_key_id: 'k-1', name: 'app.apk', dir: ['out'] }))).not.toMatch(/phone_key_id|app\.apk|dir/);
  });
  it('is refused (no row, so nothing rides) when the project is not a text or the envelope is not an object, and for a key the shell would not take', () => {
    for (const bad of [{ project_id: '' }, { project_id: 5 }, { project_id: undefined }, { envelope: 'x' }, { envelope: [] }, { envelope: null }, { envelope: undefined }]) expect(row(bad), JSON.stringify(bad)).toBeNull();
    for (const key of ['short', 'has space 0001', 'x'.repeat(101), '']) expect(row({}, key), key).toBeNull();
  });
});
