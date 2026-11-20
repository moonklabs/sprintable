// story 4988 (P8 · the web side of a DOWNLOAD) — what the web hands the shell and the server is the agreed things and nothing else (no window; no name beyond the shell's own sealed request); the chunks are fetched IN ORDER and each one
// goes to the shell (`files.download_step`), which answers progress and never a byte; every way the road ends has ONE outcome; whatever ends it (or the screen leaving) the shell drops what it held and the server deletes what it holds.
import { describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_CHUNK_WAIT_MS, DOWNLOAD_MAX_MS, FILE_REASONS, downloadFile, shellTakesFileDownload, type DownloadDeps } from './phone-files';
import type { PhoneAnswer } from './phone-bridge';

let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));

const SETUP = '22222222-3333-4444-8555-666666666666';
const CMD = '44444444-5555-4666-8777-888888888888';
const KEY = 'press-key-0001';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const SEALED: PhoneAnswer = { id: 'w1', ok: true, envelope: { v: 1, kind: 'file_download' }, phone_key_id: 'k-1', idempotency_key: KEY };
const input = { setupId: SETUP, projectId: 'proj-1', dir: ['src', 'out'], name: 'app.apk' };
const chunkEnv = (i: number) => ({ v: 1, kind: 'file_result', chunk: i });
const MORE = (got: number, of: number): PhoneAnswer => ({ id: 's', ok: true, state: 'more', got, of });
const SAVED: PhoneAnswer = { id: 's', ok: true, state: 'saved' };

/** a server that answers the ask, the chunk reads (`chunk(i, n)`: the n-th look at chunk i) and the DELETE; every call is recorded */
function server(over: { ask?: Response; chunk?: (i: number, look: number) => Response | Promise<Response>; del?: Response } = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown; signal?: boolean }> = [];
  const looks = new Map<number, number>();
  currentFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), ...(init?.signal ? { signal: true } : {}) });
    if (method === 'POST') return over.ask ?? json(201, { command_id: CMD, expires_at: 'x' });
    if (method === 'DELETE') return over.del ?? json(200, { deleted: true });
    const m = /\/chunks\/(\d+)$/.exec(url);
    if (!m) throw new Error('unexpected GET ' + url);
    const i = Number(m[1]); const look = (looks.get(i) ?? 0) + 1; looks.set(i, look);
    return (over.chunk ?? ((k) => json(200, { state: 'ready', code: null, envelope: chunkEnv(k) })))(i, look);
  };
  return calls;
}
function deps(answers: Record<string, PhoneAnswer | ((args: Record<string, unknown>) => PhoneAnswer)>, extra: Partial<DownloadDeps> = {}) {
  const phoneCall = vi.fn(async (type: string, args: Record<string, unknown> = {}) => { const a = answers[type]; return typeof a === 'function' ? a(args) : a ?? { id: 'x', ok: false, code: 'failed' }; });
  return { phoneCall, newKey: () => KEY, wait: async () => {}, ...extra } as DownloadDeps & { phoneCall: typeof phoneCall };
}
const stepsOf = (d: ReturnType<typeof deps>) => d.phoneCall.mock.calls.filter((c) => c[0] === 'files.download_step').map((c) => c[1] as Record<string, unknown>);
const types = (d: ReturnType<typeof deps>) => d.phoneCall.mock.calls.map((c) => c[0]);

describe('[4988] shellTakesFileDownload', () => {
  it('only a shell that says `file_download: 1` beside `files: 1` takes a download', async () => {
    const caps = (c: unknown) => vi.fn(async () => ({ id: 'c', ok: true, caps: c }) as PhoneAnswer);
    expect(await shellTakesFileDownload(caps({ files: 1, file_read: 1, file_download: 1 }))).toBe(true);
    expect(await shellTakesFileDownload(caps({ files: 1, file_read: 1 }))).toBe(false);
    expect(await shellTakesFileDownload(caps({ file_download: 1 }))).toBe(false);
    expect(await shellTakesFileDownload(caps({ files: 1, file_download: true }))).toBe(false);
    expect(await shellTakesFileDownload(vi.fn(async () => ({ id: 'c', ok: false, code: 'bad_request' }) as PhoneAnswer))).toBe(false);
    expect(await shellTakesFileDownload(vi.fn(async () => { throw new Error('x'); }))).toBe(false);
  });
  it('the closed list of reasons has the one new word', () => { expect(FILE_REASONS).toContain('incomplete'); });
});

describe('[4988] downloadFile — the road', () => {
  it('seals a download (the names · the press key · `download: true` and NO window), posts the envelope and the ids, fetches chunk 0,1,2 in order, gives each to the shell, tells the progress, ends `saved` and deletes the request', async () => {
    const calls = server();
    const progress: Array<{ got: number; of: number }> = [];
    const d = deps({ 'files.seal': SEALED, 'files.download_step': (a) => ((a.envelope as { chunk: number }).chunk === 0 ? MORE(1, 3) : (a.envelope as { chunk: number }).chunk === 1 ? MORE(2, 3) : SAVED) }, { onProgress: (p) => progress.push(p) });
    expect(await downloadFile(input, d)).toEqual({ kind: 'saved' });
    expect(d.phoneCall).toHaveBeenNthCalledWith(1, 'files.seal', { setup_id: SETUP, project_id: 'proj-1', dir: ['src', 'out'], name: 'app.apk', idempotency_key: KEY, download: true });
    expect(d.phoneCall.mock.calls[0]![1]).not.toHaveProperty('window');
    const posted = calls.find((c) => c.method === 'POST')!;
    expect(posted.url).toBe(`/api/desktop/computers/${SETUP}/files`);
    expect(posted.body).toEqual({ project_id: 'proj-1', idempotency_key: KEY, phone_key_id: 'k-1', envelope: SEALED.envelope });
    expect(JSON.stringify(posted.body)).not.toContain('app.apk');
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([0, 1, 2].map((i) => `/api/desktop/computers/${SETUP}/files/${CMD}/chunks/${i}`));
    expect(stepsOf(d)).toEqual([0, 1, 2].map((i) => ({ setup_id: SETUP, project_id: 'proj-1', idempotency_key: KEY, envelope: chunkEnv(i) })));
    expect(progress).toEqual([{ got: 1, of: 3 }, { got: 2, of: 3 }]);
    expect(calls.at(-1)).toEqual({ method: 'DELETE', url: `/api/desktop/computers/${SETUP}/files/${CMD}` });
    expect(types(d)).not.toContain('files.download_cancel'); // (the shell took the whole file: nothing is left in it to drop)
  });

  it('a one-chunk file is one fetch and one step', async () => {
    const calls = server();
    const d = deps({ 'files.seal': SEALED, 'files.download_step': SAVED });
    expect(await downloadFile(input, d)).toEqual({ kind: 'saved' });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('a chunk that is not there yet is asked again (the computer is behind), a paused look too — the same place, never the next', async () => {
    const calls = server({ chunk: (i, look) => (look === 1 ? json(200, { state: 'acked', code: null, envelope: null }) : look === 2 ? json(429, { error: { code: 'files_polled_too_fast' } }) : look === 3 ? json(500) : json(200, { state: 'ready', code: null, envelope: chunkEnv(i) })) });
    const d = deps({ 'files.seal': SEALED, 'files.download_step': SAVED });
    expect(await downloadFile(input, d)).toEqual({ kind: 'saved' });
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual(Array(4).fill(`/api/desktop/computers/${SETUP}/files/${CMD}/chunks/0`));
  });
});

describe('[4988] downloadFile — every end has one outcome', () => {
  it('the computer\'s refusal (a closed word) comes through the shell as `reason` — a word that is not on the list is `failed` — and nothing is left to cancel', async () => {
    for (const reason of FILE_REASONS) {
      server();
      const d = deps({ 'files.seal': SEALED, 'files.download_step': { id: 's', ok: true, state: 'refused', reason } });
      expect(await downloadFile(input, d), reason).toEqual({ kind: 'reason', reason });
      expect(types(d)).not.toContain('files.download_cancel');
    }
    server();
    const d = deps({ 'files.seal': SEALED, 'files.download_step': { id: 's', ok: true, state: 'refused', reason: 'made_up' } });
    expect(await downloadFile(input, d)).toEqual({ kind: 'failed' });
  });

  it('the shell\'s words at a step: incomplete · cancelled · save_failed each have their own outcome, any other word is `failed`', async () => {
    for (const [code, want] of [['incomplete', { kind: 'incomplete' }], ['cancelled', { kind: 'cancelled' }], ['save_failed', { kind: 'save_failed' }], ['answer_unreadable', { kind: 'failed' }], ['unknown_request', { kind: 'failed' }], ['vault_unavailable', { kind: 'failed' }]] as const) {
      server();
      const d = deps({ 'files.seal': SEALED, 'files.download_step': { id: 's', ok: false, code } });
      expect(await downloadFile(input, d), code).toEqual(want);
    }
    server();
    expect(await downloadFile(input, deps({ 'files.seal': SEALED, 'files.download_step': { id: 's', ok: true, state: 'strange' } }))).toEqual({ kind: 'failed' });
  });

  it('a refusal at the shell (before anything is asked): each word has one outcome and NOTHING is posted or fetched', async () => {
    const table: Array<[string, unknown]> = [['cancelled', { kind: 'cancelled' }], ['remote_control_off', { kind: 'remote_off' }], ['device_unreachable', { kind: 'unreachable' }], ['computer_not_found', { kind: 'not_paired' }], ['host_not_pinned', { kind: 'not_paired' }], ['no_folder', { kind: 'no_folder' }], ['busy', { kind: 'busy' }], ['bad_request', { kind: 'unsupported' }], ['too_long', { kind: 'unsupported' }], ['biometric_required', { kind: 'key', code: 'biometric_required' }], ['sign_failed', { kind: 'failed' }]];
    for (const [code, want] of table) {
      const calls = server();
      const d = deps({ 'files.seal': { id: 'w', ok: false, code } });
      expect(await downloadFile(input, d), code).toEqual(want);
      expect(calls).toEqual([]);
    }
  });

  it('a seal that comes back without the envelope, the phone key or this press\'s key is `failed` and nothing is posted', async () => {
    for (const sealed of [{ id: 'w', ok: true }, { ...SEALED, phone_key_id: 7 }, { ...SEALED, idempotency_key: 'another-key-0002' }, { ...SEALED, envelope: 'x' }] as PhoneAnswer[]) {
      const calls = server();
      expect(await downloadFile(input, deps({ 'files.seal': sealed }))).toEqual({ kind: 'failed' });
      expect(calls).toEqual([]);
    }
  });

  it('the server\'s refusal of the ask: 5xx and a lost ask are `timeout` (never «refused»); the others have their word', async () => {
    for (const [status, code, want] of [[500, '', { kind: 'timeout' }], [409, 'files_busy', { kind: 'busy' }], [429, 'files_too_fast', { kind: 'busy' }], [409, 'device_unreachable', { kind: 'unreachable' }], [409, 'remote_control_off', { kind: 'remote_off' }], [409, 'phone_not_paired', { kind: 'not_paired' }], [404, 'project_not_found', { kind: 'no_folder' }], [403, 'not_allowed_to_read_files', { kind: 'not_allowed' }], [422, 'x', { kind: 'failed' }]] as const) {
      const calls = server({ ask: json(status, { error: { code } }) });
      const d = deps({ 'files.seal': SEALED });
      expect(await downloadFile(input, d), `${status} ${code}`).toEqual(want);
      expect(calls.filter((c) => c.method === 'GET')).toEqual([]);
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false); // (no request was made: nothing to delete)
      expect(types(d)).toContain('files.download_cancel'); // (the shell holds the sealed request's pending entry: it is dropped)
    }
    currentFetch = async () => { throw new Error('offline'); };
    expect(await downloadFile(input, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
    server({ ask: json(201, { nope: 1 }) });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
  });

  it('a chunk that never comes: 404 at chunk 0 is `timeout`, at a later chunk it is `incomplete`; a place out of order (409) is `incomplete`', async () => {
    server({ chunk: () => json(404, { error: { code: 'files_read_not_found' } }) });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
    server({ chunk: (i) => (i === 0 ? json(200, { state: 'ready', envelope: chunkEnv(0) }) : json(404, {})) });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED, 'files.download_step': MORE(1, 3) }))).toEqual({ kind: 'incomplete' });
    server({ chunk: () => json(409, { error: { code: 'files_chunk_out_of_order' } }) });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'incomplete' });
  });

  it('the computer ended without the chunk: its closed word is the end — an older app that does not know a download is `needs_update`, an expired request `timeout`, done-without-chunk `incomplete`', async () => {
    const ended = (state: string, code: string | null) => ({ chunk: (i: number) => (i === 0 ? json(200, { state: 'ready', envelope: chunkEnv(0) }) : json(200, { state, code, envelope: null })) });
    const more = { 'files.seal': SEALED, 'files.download_step': MORE(1, 3) };
    server({ chunk: () => json(200, { state: 'rejected', code: 'not_allowed', envelope: null }) });
    expect(await downloadFile(input, deps(more))).toEqual({ kind: 'needs_update' });
    server({ chunk: () => json(200, { state: 'rejected', code: 'expired', envelope: null }) });
    expect(await downloadFile(input, deps(more))).toEqual({ kind: 'timeout' });
    server({ chunk: () => json(200, { state: 'failed', code: 'x', envelope: null }) });
    expect(await downloadFile(input, deps(more))).toEqual({ kind: 'failed' });
    server(ended('failed', 'upload_failed'));
    expect(await downloadFile(input, deps(more))).toEqual({ kind: 'incomplete' });
    server(ended('done', null));
    expect(await downloadFile(input, deps(more))).toEqual({ kind: 'incomplete' });
  });

  it('looks that FAIL (401 · 429 · 5xx · a body that is no JSON · a look that throws) are retried only within the time: past the chunk\'s limit (the first chunk: `timeout`, a later one: `incomplete`) and past the whole download\'s limit, the download ends', async () => {
    const kinds: Array<() => Response> = [() => json(401), () => json(429, {}), () => json(500), () => new Response('not json', { status: 200 })];
    for (const make of kinds) {
      let t = 0; const calls = server({ chunk: () => make() });
      const d = deps({ 'files.seal': SEALED }, { now: () => t, wait: async () => { t += 20_000; } });
      expect(await downloadFile(input, d)).toEqual({ kind: 'timeout' });
      expect(calls.filter((c) => c.method === 'GET').length).toBeLessThanOrEqual(5);
    }
    let t = 0; server({ chunk: () => { throw new Error('offline'); } });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED }, { now: () => t, wait: async () => { t += 20_000; } }))).toEqual({ kind: 'timeout' });
    t = 0; server({ chunk: (i) => (i === 0 ? json(200, { state: 'ready', envelope: chunkEnv(0) }) : json(500)) });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED, 'files.download_step': MORE(1, 3) }, { now: () => t, wait: async () => { t += 20_000; } }))).toEqual({ kind: 'incomplete' });
    // the whole download's limit, with looks that keep failing between chunks that each arrive in time
    t = 0; let toggle = 0;
    server({ chunk: (i) => (toggle++ % 2 === 0 ? json(500) : json(200, { state: 'ready', envelope: chunkEnv(i) })) });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED, 'files.download_step': MORE(1, 57) }, { now: () => t, wait: async () => { t += 15_000; } }))).toEqual({ kind: 'incomplete' });
  });

  it('time: a chunk waited for past its limit is `timeout` (the first) or `incomplete` (a later one), and a whole download past its limit is `incomplete`', async () => {
    let t = 0;
    server({ chunk: () => json(200, { state: 'acked', code: null, envelope: null }) });
    const lookCalls = server({ chunk: () => json(200, { state: 'acked', code: null, envelope: null }) });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED }, { now: () => t, wait: async () => { t += 20_000; } }))).toEqual({ kind: 'timeout' });
    expect(lookCalls.filter((c) => c.method === 'GET').length, 'a chunk is waited for at most its own limit (60 s), not the whole download\'s').toBeLessThanOrEqual(5);
    t = 0;
    server({ chunk: (i) => (i === 0 ? json(200, { state: 'ready', envelope: chunkEnv(0) }) : json(200, { state: 'acked', code: null, envelope: null })) });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED, 'files.download_step': MORE(1, 3) }, { now: () => t, wait: async () => { t += 20_000; } }))).toEqual({ kind: 'incomplete' });
    t = 0;
    server({ chunk: (i) => json(200, { state: 'ready', code: null, envelope: chunkEnv(i) }) });
    expect(await downloadFile(input, deps({ 'files.seal': SEALED, 'files.download_step': MORE(1, 57) }, { now: () => t, wait: async () => { t += 20_000; } }))).toEqual({ kind: 'incomplete' }); // (each chunk comes within its own 60 s; the whole passes 5 minutes)
    // a look that comes back after the chunk's time was over is no answer: the chunk it holds is not taken
    t = 0; const late = deps({ 'files.seal': SEALED, 'files.download_step': SAVED }, { now: () => t, wait: async () => { t += 61_000; } });
    server({ chunk: (i) => json(200, { state: 'ready', code: null, envelope: chunkEnv(i) }) });
    expect(await downloadFile(input, late)).toEqual({ kind: 'timeout' });
    expect(stepsOf(late)).toEqual([]);
    expect(DOWNLOAD_CHUNK_WAIT_MS).toBeLessThan(DOWNLOAD_MAX_MS);
  });
});

describe('[4988] downloadFile — what is dropped, whatever ends it', () => {
  it('an end that is not the shell\'s own tells the shell to drop the train (`files.download_cancel` with this press key) and the server to delete the request', async () => {
    const calls = server({ chunk: () => json(404, {}) });
    const d = deps({ 'files.seal': SEALED });
    await downloadFile(input, d);
    expect(d.phoneCall).toHaveBeenCalledWith('files.download_cancel', { idempotency_key: KEY });
    expect(calls.at(-1)).toEqual({ method: 'DELETE', url: `/api/desktop/computers/${SETUP}/files/${CMD}` });
  });

  it('a screen that left: before the seal nothing is asked; after the seal the shell drops it and nothing is posted; after the post the request is deleted; between chunks nothing more is fetched', async () => {
    let calls = server();
    let d = deps({ 'files.seal': SEALED });
    const early = deps({ 'files.seal': SEALED }, { stopped: () => true });
    expect(await downloadFile(input, early)).toEqual({ kind: 'cancelled' });
    expect(calls).toEqual([]);
    expect(early.phoneCall).not.toHaveBeenCalled(); // (a screen that left before anything was asked: the shell is not asked either — not even to drop)
    let stop = false; calls = server(); d = deps({ 'files.seal': async () => { stop = true; return SEALED; } } as never, { stopped: () => stop });
    expect(await downloadFile(input, d)).toEqual({ kind: 'cancelled' });
    expect(calls).toEqual([]); expect(types(d)).toContain('files.download_cancel');
    stop = false; calls = server();
    const late: unknown[] = [];
    d = deps({ 'files.seal': SEALED, 'files.download_step': () => { stop = true; return MORE(1, 3); } }, { stopped: () => stop, onProgress: (p) => late.push(p) });
    expect(await downloadFile(input, d)).toEqual({ kind: 'cancelled' });
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1); // chunk 0 only
    expect(late).toEqual([]); // (the chunk the shell took after the screen left tells no progress to a screen that is gone)
    expect(calls.at(-1)?.method).toBe('DELETE'); expect(types(d)).toContain('files.download_cancel');
    // while waiting for a chunk
    stop = false; calls = server({ chunk: () => json(200, { state: 'acked', envelope: null }) });
    d = deps({ 'files.seal': SEALED }, { stopped: () => stop, wait: async () => { stop = true; } });
    expect(await downloadFile(input, d)).toEqual({ kind: 'cancelled' });
    expect(calls.at(-1)?.method).toBe('DELETE');
  });

  it('the screen can end it NOW: `onCleanup` hands over a function that drops the shell\'s train and deletes the request at once — even while a step is still in flight — and each is done once however often it is called', async () => {
    const calls = server();
    let cleanup: (() => Promise<void>) | null = null; let stop = false; // (the page ends the ask at once as well: `stopped` turns true with the cleanup)
    const release: { go: (a: PhoneAnswer) => void } = { go: () => {} };
    const d = deps({ 'files.seal': SEALED, 'files.download_step': (() => new Promise<PhoneAnswer>((r) => { release.go = r; })) as never }, { onCleanup: (c) => { cleanup = c; }, stopped: () => stop });
    const done = downloadFile(input, d);
    for (let i = 0; i < 20 && stepsOf(d).length === 0; i++) await new Promise((r) => setTimeout(r, 0)); // (until the first step is in flight)
    expect(stepsOf(d)).toHaveLength(1);
    expect(cleanup).not.toBeNull();
    stop = true; await cleanup!(); await cleanup!();
    expect(d.phoneCall.mock.calls.filter((c) => c[0] === 'files.download_cancel')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    release.go(MORE(1, 3)); // the late answer of the step that was in flight
    expect(await Promise.race([done, new Promise((r) => setTimeout(() => r('hung'), 200))])).not.toBe('hung');
    expect(d.phoneCall.mock.calls.filter((c) => c[0] === 'files.download_cancel')).toHaveLength(1); // not again when the road ends
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('the shell and the server are dropped TOGETHER: a bridge that never answers `files.download_cancel` does not hold the server\'s DELETE (nor the end of the download)', async () => {
    const calls = server({ chunk: () => json(404, {}) });
    const phoneCall = vi.fn(async (type: string) => { if (type === 'files.seal') return SEALED; return new Promise<PhoneAnswer>(() => {}); }); // every other call hangs
    const out = await Promise.race([downloadFile(input, { phoneCall, newKey: () => KEY, wait: async () => {} } as DownloadDeps), new Promise((r) => setTimeout(() => r('hung'), 500))]);
    expect(out).toEqual({ kind: 'timeout' });
    expect(phoneCall).toHaveBeenCalledWith('files.download_cancel', { idempotency_key: KEY });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('a step word that is not one with which the shell dropped the train (a vault away · an unreadable chunk · busy) leaves the train there: the cleanup tells the shell to drop it — the words of its own drop do not', async () => {
    for (const code of ['vault_unavailable', 'answer_unreadable', 'busy', 'something_new']) {
      server();
      const d = deps({ 'files.seal': SEALED, 'files.download_step': { id: 's', ok: false, code } });
      expect(await downloadFile(input, d), code).toEqual({ kind: 'failed' });
      expect(d.phoneCall, code).toHaveBeenCalledWith('files.download_cancel', { idempotency_key: KEY });
    }
    for (const code of ['incomplete', 'cancelled', 'save_failed']) {
      server();
      const d = deps({ 'files.seal': SEALED, 'files.download_step': { id: 's', ok: false, code } });
      await downloadFile(input, d);
      expect(types(d), code).not.toContain('files.download_cancel');
    }
  });

  it('a chunk look is bounded by the time that is left: it carries an abort signal', async () => {
    const calls = server();
    await downloadFile(input, deps({ 'files.seal': SEALED, 'files.download_step': SAVED }));
    expect(calls.filter((c) => c.method === 'GET').every((c) => c.signal === true)).toBe(true);
  });

  it('a bridge call that is REFUSED (rejects instead of answering a word) ends the download as `failed` at the seal, at a step and at the cleanup — never an exception out of it', async () => {
    for (const bad of ['files.seal', 'files.download_step']) {
      server();
      const phoneCall = vi.fn(async (type: string) => { if (type === bad) throw new Error('bridge gone'); if (type === 'files.seal') return SEALED; return { id: 'x', ok: true, state: 'saved' } as PhoneAnswer; });
      expect(await downloadFile(input, { phoneCall, newKey: () => KEY, wait: async () => {} } as DownloadDeps), bad).toEqual({ kind: 'failed' });
    }
  });

  it('the whole download\'s limit (5 minutes) is judged at BOTH places — before a look that follows failing looks, and after a look that took the time over: no chunk is taken past it, no look is made past it', async () => {
    // (a) looks that take 20 s each; the first fourteen answer, then they fail: the download ends at the first moment past the limit — not at the chunk's own (later) limit
    let t = 0;
    const calls = server({ chunk: (i) => { const ok = t < DOWNLOAD_MAX_MS - 20_000; t += 20_000; return ok ? json(200, { state: 'ready', envelope: chunkEnv(i) }) : json(500); } });
    const d = deps({ 'files.seal': SEALED, 'files.download_step': MORE(1, 57) }, { now: () => t });
    expect(await downloadFile(input, d)).toEqual({ kind: 'incomplete' });
    expect(calls.filter((c) => c.method === 'GET').length, 'no look is made once the whole limit is over').toBe(DOWNLOAD_MAX_MS / 20_000);
    // (b) a look that ANSWERS, but only after the whole limit has passed (the chunk's own limit has not): the chunk it holds is not taken
    t = 0;
    server({ chunk: (i) => { t += 30_000; return json(200, { state: 'ready', envelope: chunkEnv(i) }); } });
    const d2 = deps({ 'files.seal': SEALED, 'files.download_step': MORE(1, 57) }, { now: () => t });
    expect(await downloadFile(input, d2)).toEqual({ kind: 'incomplete' });
    expect(stepsOf(d2).length, 'the chunk that came back past the limit was not given to the shell').toBe(DOWNLOAD_MAX_MS / 30_000 - 1);
  });

  it('the cleanup never throws: a DELETE that fails or a shell that does not answer changes nothing of the outcome', async () => {
    currentFetch = async (url, init) => { if (init?.method === 'DELETE') throw new Error('offline'); if (init?.method === 'POST') return json(201, { command_id: CMD }); return json(404, {}); };
    const phoneCall = vi.fn(async (type: string) => { if (type === 'files.seal') return SEALED; throw new Error('bridge gone'); });
    expect(await downloadFile(input, { phoneCall, newKey: () => KEY, wait: async () => {} } as DownloadDeps)).toEqual({ kind: 'timeout' });
  });
});
