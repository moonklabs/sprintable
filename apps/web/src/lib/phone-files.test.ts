// story 4983 (P5 · layer 5) — every way a folder-list ask from the phone app ends maps to one outcome; what the web hands the shell and the server is the four agreed things and nothing else
// (no path · no name beyond the folder's own single names); the shell's and the server's refusals each have ONE word; a body the computer sealed is drawn only if it has the contract's shape.
import { describe, expect, it, vi } from 'vitest';
import { FILE_REASONS, FILES_POLL_MAX_MS, READ_LIMITS, listFolder, openFile, parseList, parseRead, shellTakesFileRead, shellTakesFiles, type FilesDeps } from './phone-files';
import type { PhoneAnswer } from './phone-bridge';

let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));

const SETUP = '22222222-3333-4444-8555-666666666666';
const CMD = '44444444-5555-4666-8777-888888888888';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const LIST = { v: 1, kind: 'list', ok: true, entries: [{ n: 'a.txt', k: 'f', s: 3, t: 1795000000 }, { n: 'src', k: 'd', t: 1795000001 }, { n: 'ln', k: 'l' }], hidden: 2, more: false };
const SEALED: PhoneAnswer = { id: 'w1', ok: true, envelope: { v: 1, kind: 'file_list' }, phone_key_id: 'k-1', idempotency_key: 'press-key-0001' };
const ANSWER = { v: 1, kind: 'file_result' };

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
function deps(answers: Record<string, PhoneAnswer>, extra: Partial<FilesDeps> = {}) {
  const phoneCall = vi.fn(async (type: string) => answers[type] ?? { id: 'x', ok: false, code: 'failed' });
  return { phoneCall, newKey: () => 'press-key-0001', wait: async () => {}, ...extra } as FilesDeps & { phoneCall: typeof phoneCall };
}
const ask = { setupId: SETUP, projectId: 'proj-1', dir: ['src'] };

describe('[4983] listFolder — what the web asks and posts', () => {
  it('the shell gets the computer · the project · the NAMES · the press key (and a cursor only when asked); the server gets the envelope and the ids — no name, no path', async () => {
    const calls = server(json(201, { command_id: CMD, expires_at: 'x' }), [json(200, { state: 'delivered', code: null, envelope: null }), json(200, { state: 'done', code: null, envelope: ANSWER })]);
    const d = deps({ 'files.seal': SEALED, 'files.open': { id: 'w2', ok: true, body: LIST } });
    const out = await listFolder({ ...ask, cursor: 'a.txt' }, d);
    expect(out).toEqual({ kind: 'list', list: { entries: LIST.entries, hidden: 2, more: false } });
    expect(d.phoneCall).toHaveBeenNthCalledWith(1, 'files.seal', { setup_id: SETUP, project_id: 'proj-1', dir: ['src'], idempotency_key: 'press-key-0001', cursor: 'a.txt' });
    expect(d.phoneCall).toHaveBeenNthCalledWith(2, 'files.open', { setup_id: SETUP, project_id: 'proj-1', idempotency_key: 'press-key-0001', envelope: ANSWER });
    expect(calls[0]!.url).toBe(`/api/desktop/computers/${SETUP}/files`);
    const posted = JSON.parse(calls[0]!.init!.body as string);
    expect(posted).toEqual({ project_id: 'proj-1', idempotency_key: 'press-key-0001', phone_key_id: 'k-1', envelope: SEALED.envelope });
    expect(JSON.stringify(posted)).not.toContain('src');
    expect(calls[1]!.url).toBe(`/api/desktop/computers/${SETUP}/files/${CMD}`);
  });

  it('no cursor key reaches the shell when none is asked', async () => {
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', envelope: ANSWER })]);
    const d = deps({ 'files.seal': SEALED, 'files.open': { id: 'w2', ok: true, body: LIST } });
    await listFolder(ask, d);
    expect((d.phoneCall.mock.calls[0] as unknown[])[1]).not.toHaveProperty('cursor');
  });

  it('a refusal at the shell: each word has one outcome and NOTHING is posted', async () => {
    const table: Array<[string, unknown]> = [
      ['cancelled', { kind: 'cancelled' }], ['remote_control_off', { kind: 'remote_off' }], ['device_unreachable', { kind: 'unreachable' }], ['computer_not_found', { kind: 'not_paired' }],
      ['host_not_pinned', { kind: 'not_paired' }], ['host_not_sealing', { kind: 'not_paired' }], ['no_folder', { kind: 'no_folder' }], ['busy', { kind: 'busy' }], ['bad_request', { kind: 'unsupported' }],
      ['too_long', { kind: 'unsupported' }], ['biometric_required', { kind: 'key', code: 'biometric_required' }], ['no_screen_lock', { kind: 'key', code: 'no_screen_lock' }],
      ['key_invalidated', { kind: 'key', code: 'key_invalidated' }], ['no_key', { kind: 'key', code: 'no_key' }], ['not_registered', { kind: 'key', code: 'not_registered' }],
      ['vault_unavailable', { kind: 'failed' }], ['sign_failed', { kind: 'failed' }], ['something_new', { kind: 'failed' }], ['signed_out', { kind: 'failed' }],
    ];
    for (const [code, want] of table) {
      const calls = server(json(201, { command_id: CMD }));
      expect(await listFolder(ask, deps({ 'files.seal': { id: 'w', ok: false, code } })), code).toEqual(want);
      expect(calls).toEqual([]);
    }
  });

  it('a seal answer that is not the shape (no envelope · another press key) is a failure and posts nothing', async () => {
    for (const bad of [{ ...SEALED, envelope: undefined }, { ...SEALED, envelope: [1] }, { ...SEALED, phone_key_id: 5 }, { ...SEALED, idempotency_key: 'press-key-9999' }]) {
      const calls = server(json(201, { command_id: CMD }));
      expect(await listFolder(ask, deps({ 'files.seal': bad as PhoneAnswer }))).toEqual({ kind: 'failed' });
      expect(calls).toEqual([]);
    }
  });

  it('the server\'s refusals of the ask: each code has one outcome', async () => {
    const table: Array<[number, string, unknown]> = [
      [409, 'files_busy', { kind: 'busy' }], [429, 'files_too_fast', { kind: 'busy' }], [409, 'device_unreachable', { kind: 'unreachable' }], [409, 'remote_control_off', { kind: 'remote_off' }],
      [409, 'phone_not_paired', { kind: 'not_paired' }], [404, 'project_not_found', { kind: 'no_folder' }], [403, 'not_allowed_to_read_files', { kind: 'not_allowed' }], [403, '', { kind: 'not_allowed' }],
      [422, 'envelope_header_mismatch', { kind: 'failed' }], [413, 'files_request_too_large', { kind: 'failed' }], [400, '', { kind: 'failed' }],
    ];
    for (const [status, code, want] of table) {
      server(json(status, { error: { code } }));
      expect(await listFolder(ask, deps({ 'files.seal': SEALED })), `${status} ${code}`).toEqual(want);
    }
    server(json(403, { detail: { code: 'not_allowed_to_read_files' } }));
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'not_allowed' });
    server(json(409, { detail: { code: 'files_busy' } })); // the app's own 4xx envelope nests the code under `detail`
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'busy' });
  });

  it('«not known» is never said as «refused»: a post that threw · a 5xx · a made-command that cannot be read is `timeout`', async () => {
    currentFetch = async () => { throw new Error('offline'); };
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
    server(json(502, {}));
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
    server(new Response('not json', { status: 201 }));
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
    server(json(201, {}));
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
  });

  it('an answer the shell opens with a body that is not a list ends as a failure — and one the shell refuses to open is a failure too, never a list', async () => {
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', envelope: ANSWER })]);
    expect(await listFolder(ask, deps({ 'files.seal': SEALED, 'files.open': { id: 'w', ok: false, code: 'answer_stale', body: LIST } }))).toEqual({ kind: 'failed' });
  });

  it('the answer: a reason word of the computer is `reason`; an answer the shell cannot open is a failure; the polls go on past failed looks and stop at a row that is gone', async () => {
    server(json(201, { command_id: CMD }), [json(500, {}), json(429, { error: { code: 'files_polled_too_fast' } }), json(200, { state: 'done', envelope: ANSWER })]);
    expect(await listFolder(ask, deps({ 'files.seal': SEALED, 'files.open': { id: 'w', ok: true, body: { v: 1, kind: 'list', ok: false, reason: 'looks_secret' } } }))).toEqual({ kind: 'reason', reason: 'looks_secret' });
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', envelope: ANSWER })]);
    expect(await listFolder(ask, deps({ 'files.seal': SEALED, 'files.open': { id: 'w', ok: false, code: 'answer_unreadable' } }))).toEqual({ kind: 'failed' });
    server(json(201, { command_id: CMD }), [json(404, { error: { code: 'files_read_not_found' } })]);
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
  });

  it('the computer ended without an answer: its closed word is the end', async () => {
    server(json(201, { command_id: CMD }), [json(200, { state: 'rejected', code: 'expired', envelope: null })]);
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
    server(json(201, { command_id: CMD }), [json(200, { state: 'rejected', code: 'envelope_replay', envelope: null })]);
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'failed' });
    server(json(201, { command_id: CMD }), [json(200, { state: 'failed', code: 'x', envelope: null })]);
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'failed' });
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', code: null, envelope: null })]);
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'failed' });
  });

  it('an answer that never comes ends as `timeout` after the longest wait — on the wall clock, not on the number of looks', async () => {
    server(json(201, { command_id: CMD }), [json(200, { state: 'delivered', code: null, envelope: null })]);
    let t = 1_000_000;
    const out = await listFolder(ask, deps({ 'files.seal': SEALED }, { now: () => t, wait: async (ms) => { t += ms; }, pollMs: 7_000 }));
    expect(out).toEqual({ kind: 'timeout' });
    expect(t - 1_000_000).toBeGreaterThanOrEqual(FILES_POLL_MAX_MS);
  });

  it('a screen that is gone (or replaced) draws nothing more and asks nothing more', async () => {
    const calls = server(json(201, { command_id: CMD }), [json(200, { state: 'delivered', envelope: null })]);
    let gone = false;
    const d = deps({ 'files.seal': SEALED }, { stopped: () => gone, wait: async () => { gone = true; } });
    expect(await listFolder(ask, d)).toEqual({ kind: 'cancelled' });
    expect(calls.filter((c) => c.init?.method !== 'POST')).toEqual([]);
    gone = true;
    const calls2 = server(json(201, { command_id: CMD }));
    expect(await listFolder(ask, deps({ 'files.seal': SEALED }, { stopped: () => gone }))).toEqual({ kind: 'cancelled' });
    expect(calls2).toEqual([]);
  });
});

describe('[4983] parseList — only the contract\'s shape is drawn', () => {
  it('a list and a refusal word', () => {
    expect(parseList(LIST)).toEqual({ kind: 'list', list: { entries: LIST.entries, hidden: 2, more: false } });
    expect(parseList({ ...LIST, more: true, cursor: 'a.txt' })).toEqual({ kind: 'list', list: { entries: LIST.entries, hidden: 2, more: true, cursor: 'a.txt' } });
    for (const reason of FILE_REASONS) expect(parseList({ v: 1, kind: 'list', ok: false, reason })).toEqual({ kind: 'reason', reason });
  });
  it('anything else is a failure: a word that is not on the list · a wrong kind of entry · a missing count · another version', () => {
    for (const bad of [null, [], 'x', { ...LIST, v: 2 }, { ...LIST, kind: 'read' }, { ...LIST, ok: 'yes' }, { v: 1, kind: 'list', ok: false, reason: 'weird' }, { ...LIST, entries: [{ n: 'a', k: 'x' }] },
      { ...LIST, entries: [{ k: 'f' }] }, { ...LIST, hidden: '2' }, { ...LIST, more: 1 }, { ...LIST, entries: 'a' }]) {
      expect(parseList(bad)).toEqual({ kind: 'failed' });
    }
  });
  it('unknown fields are dropped (only what the screen draws is kept)', () => {
    const r = parseList({ ...LIST, entries: [{ n: 'a', k: 'f', s: 1, t: 2, path: '/Users/x', extra: 1 }], path: '/x' });
    expect(r).toEqual({ kind: 'list', list: { entries: [{ n: 'a', k: 'f', s: 1, t: 2 }], hidden: 2, more: false } });
  });
});

describe('[4983] shellTakesFiles', () => {
  it('only `files: 1` of `shell.caps` — read, never guessed; an older shell (a refusal · a throw) says no', async () => {
    const yes = vi.fn(async () => ({ id: 'a', ok: true, caps: { sealed_prompt: 1, files: 1 } }));
    expect(await shellTakesFiles(yes)).toBe(true);
    expect(yes).toHaveBeenCalledWith('shell.caps', {});
    expect(await shellTakesFiles(async () => ({ id: 'a', ok: false, caps: { files: 1 } } as never))).toBe(false); // a refusal that still carries a caps field is no capability
    for (const caps of [{ sealed_prompt: 1 }, { files: 0 }, { files: true }, { files: '1' }, null]) {
      expect(await shellTakesFiles(async () => ({ id: 'a', ok: true, caps }))).toBe(false);
    }
    expect(await shellTakesFiles(async () => ({ id: 'a', ok: false, code: 'bad_request' }))).toBe(false);
    expect(await shellTakesFiles(async () => { throw new Error('x'); })).toBe(false);
  });
});


// ── [P6] opening one file ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PNG = '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c636868680000030401814bd3d2100000000049454e44ae426082';
const PNG_B64 = Buffer.from(PNG, 'hex').toString('base64');
const TEXT = { v: 1, kind: 'read', ok: true, form: 'text', s: 14, masked: 1, text: 'hello\nAPI=••••' };
const IMAGE = { v: 1, kind: 'read', ok: true, form: 'image', s: PNG.length / 2, mime: 'image/png', w: 1, h: 1, data: PNG_B64 };
const OPEN = { setupId: SETUP, projectId: 'proj-1', dir: ['src'], name: 'a b.txt' };

describe('[4983 P6] shellTakesFileRead — the shell says it opens files in its own word', () => {
  const caps = (c: unknown) => async () => ({ id: 'x', ok: true, caps: c } as PhoneAnswer);
  it('only `files: 1` AND `file_read: 1` is a yes', async () => {
    expect(await shellTakesFileRead(caps({ files: 1, file_read: 1 }))).toBe(true);
    expect(await shellTakesFileRead(caps({ files: 1 }))).toBe(false);
    expect(await shellTakesFileRead(caps({ file_read: 1 }))).toBe(false);
    expect(await shellTakesFileRead(caps({ files: 1, file_read: 2 }))).toBe(false);
    expect(await shellTakesFileRead(caps({ files: 1, file_read: true }))).toBe(false);
    expect(await shellTakesFileRead(caps(null))).toBe(false);
    expect(await shellTakesFileRead(async () => ({ id: 'x', ok: false, code: 'bad_request' }) as PhoneAnswer)).toBe(false);
    expect(await shellTakesFileRead(async () => { throw new Error('bridge'); })).toBe(false);
  });
  it('a shell that only lists is still a list-taker', async () => {
    expect(await shellTakesFiles(caps({ files: 1 }))).toBe(true);
    expect(await shellTakesFiles(caps({ files: 1, file_read: 1 }))).toBe(true);
  });
});

describe('[4983 P6] openFile — what the web asks and posts', () => {
  it('the shell gets the computer · the project · the folder NAMES · the file\'s NAME · the press key (no cursor); the server gets the envelope and the ids only', async () => {
    const calls = server(json(201, { command_id: CMD }), [json(200, { state: 'done', code: null, envelope: ANSWER })]);
    const d = deps({ 'files.seal': SEALED, 'files.open': { id: 'w2', ok: true, body: TEXT } });
    const out = await openFile(OPEN, d);
    expect(out).toEqual({ kind: 'text', text: TEXT.text, masked: 1, size: 14 });
    expect(d.phoneCall).toHaveBeenNthCalledWith(1, 'files.seal', { setup_id: SETUP, project_id: 'proj-1', dir: ['src'], name: 'a b.txt', idempotency_key: 'press-key-0001' });
    expect((d.phoneCall.mock.calls[0] as unknown[])[1]).not.toHaveProperty('cursor');
    expect(d.phoneCall).toHaveBeenNthCalledWith(2, 'files.open', { setup_id: SETUP, project_id: 'proj-1', idempotency_key: 'press-key-0001', envelope: ANSWER });
    const posted = JSON.parse(calls[0]!.init!.body as string);
    expect(posted).toEqual({ project_id: 'proj-1', idempotency_key: 'press-key-0001', phone_key_id: 'k-1', envelope: SEALED.envelope });
    expect(JSON.stringify(posted)).not.toContain('a b.txt');
    expect(JSON.stringify(posted)).not.toContain('src');
  });

  it('a picture, a refusal word and a body that is not a read answer', async () => {
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', envelope: ANSWER })]);
    expect(await openFile(OPEN, deps({ 'files.seal': SEALED, 'files.open': { id: 'w2', ok: true, body: IMAGE } }))).toEqual({ kind: 'image', mime: 'image/png', w: 1, h: 1, data: PNG_B64, size: PNG.length / 2 });
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', envelope: ANSWER })]);
    expect(await openFile(OPEN, deps({ 'files.seal': SEALED, 'files.open': { id: 'w2', ok: true, body: { v: 1, kind: 'read', ok: false, reason: 'too_big' } } }))).toEqual({ kind: 'reason', reason: 'too_big' });
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', envelope: ANSWER })]);
    expect(await openFile(OPEN, deps({ 'files.seal': SEALED, 'files.open': { id: 'w2', ok: true, body: LIST } }))).toEqual({ kind: 'failed' }); // a folder list answering an open
  });

  it('the same refusals as a list: the shell\'s words, the server\'s, a vanished row, a timeout — and a list still draws a list', async () => {
    const calls = server(json(201, { command_id: CMD }));
    expect(await openFile(OPEN, deps({ 'files.seal': { id: 'w', ok: false, code: 'cancelled' } }))).toEqual({ kind: 'cancelled' });
    expect(await openFile(OPEN, deps({ 'files.seal': { id: 'w', ok: false, code: 'bad_request' } }))).toEqual({ kind: 'unsupported' });
    expect(await openFile(OPEN, deps({ 'files.seal': { id: 'w', ok: false, code: 'no_screen_lock' } }))).toEqual({ kind: 'key', code: 'no_screen_lock' });
    expect(calls.length).toBe(0);
    server(json(409, { error: { code: 'files_busy' } }));
    expect(await openFile(OPEN, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'busy' });
    server(json(201, { command_id: CMD }), [json(404)]);
    expect(await openFile(OPEN, deps({ 'files.seal': SEALED }))).toEqual({ kind: 'timeout' });
    server(json(201, { command_id: CMD }), [json(200, { state: 'done', envelope: ANSWER })]);
    expect(await listFolder(ask, deps({ 'files.seal': SEALED, 'files.open': { id: 'w2', ok: true, body: LIST } }))).toMatchObject({ kind: 'list' });
  });
});

describe('[4983 P6] parseRead — a body is drawn only if it has the contract\'s shape', () => {
  const img = (over: Record<string, unknown> = {}) => ({ ...IMAGE, ...over });
  const txt = (over: Record<string, unknown> = {}) => ({ ...TEXT, ...over });
  it('the valid ones', () => {
    expect(parseRead(TEXT)).toEqual({ kind: 'text', text: TEXT.text, masked: 1, size: 14 });
    expect(parseRead(txt({ text: '', s: 0, masked: 0 }))).toEqual({ kind: 'text', text: '', masked: 0, size: 0 });
    expect(parseRead(txt({ text: 'a\ufffdb\n\t한글 😀' }))).toMatchObject({ kind: 'text' });
    expect(parseRead(IMAGE)).toMatchObject({ kind: 'image', mime: 'image/png', w: 1, h: 1 });
    for (const word of FILE_REASONS) expect(parseRead({ v: 1, kind: 'read', ok: false, reason: word })).toEqual({ kind: 'reason', reason: word });
    const pngOf = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n - 8, 1)]).toString('base64');
    expect(parseRead(img({ w: 4000, h: 4000, s: 12, data: pngOf(12) }))).toMatchObject({ kind: 'image' });
    for (const n of [12, 13, 14, 15]) expect(parseRead(img({ data: pngOf(n), s: n }))).toMatchObject({ kind: 'image', size: n });
  });
  it('every one that is not', () => {
    const failed = { kind: 'failed' };
    for (const body of [
      null, [], 'x', { v: 1, kind: 'list', ok: true, entries: [], hidden: 0, more: false }, { ...TEXT, v: 2 }, { ...TEXT, kind: 'list' }, { ...TEXT, ok: 'yes' },
      { v: 1, kind: 'read', ok: false, reason: 'weird' }, { v: 1, kind: 'read', ok: false, reason: 'too_big', path: '/x' },
      txt({ form: 'pdf' }), { ...TEXT, form: undefined }, txt({ extra: 1 }), txt({ s: -1 }), txt({ s: 1.5 }), txt({ masked: -1 }), txt({ masked: 'a' }), txt({ text: 7 }), txt({ mime: 'image/png' }),
      ...['\u0000', '\r', '\u0085', '\u007f', '\u2028', '\u200b', '\u202e', '\u2060', '\u2800', '\u3164', '\ufeff', '\u0001', '\u001b'].map((bad) => txt({ text: `a${bad}b` })),
      txt({ s: READ_LIMITS.textBytesMax + 1 }), txt({ text: 'a'.repeat(READ_LIMITS.textShownBytesMax + 1) }), txt({ text: '\n'.repeat(READ_LIMITS.textShownBytesMax) }),
      img({ mime: 'image/svg+xml' }), img({ mime: 'IMAGE/PNG' }), img({ mime: 5 }), img({ w: 0 }), img({ h: 1.5 }), img({ w: 2 ** 31 }), img({ w: 4000, h: 4001 }),
      img({ data: 'a b c' }), img({ data: `data:image/png;base64,${PNG_B64}` }), img({ data: 'AAA!', s: 3 }), img({ data: 5 }), img({ s: 999 }), img({ extra: 1 }), img({ name: 'a.png' }),
      img({ s: READ_LIMITS.imageBytesMax + 3, data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(READ_LIMITS.imageBytesMax - 5, 1)]).toString('base64') }),
      img({ s: 0, data: '' }), img({ s: 3, data: 'AAAA' }), img({ mime: 'image/jpeg' }),
      img({ s: 11, data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3, 1)]).toString('base64') }),
      txt({ text: 'x'.repeat(2001) }), txt({ text: 'a\ud800b' }), txt({ text: 'a\udc00b' }),
    ]) expect(parseRead(body)).toEqual(failed);
  });
  it('every type must start like itself, a line may be 2000 characters and no more, a pair of surrogates is fine', () => {
    const tagged = (mime: string, bytes: number[]) => { const data = Buffer.concat([Buffer.from(bytes), Buffer.alloc(16, 0)]).toString('base64'); return parseRead(img({ mime, s: Buffer.from(data, 'base64').length, data })).kind; };
    expect(tagged('image/gif', [...Buffer.from('GIF87a')])).toBe('image'); expect(tagged('image/gif', [...Buffer.from('GIF88a')])).toBe('failed'); expect(tagged('image/gif', [...Buffer.from('GIFxyz')])).toBe('failed');
    expect(tagged('image/jpeg', [0xff, 0xd8, 0xff, 0xe0])).toBe('image'); expect(tagged('image/jpeg', [0xff, 0xd8, 0x00])).toBe('failed'); expect(tagged('image/jpeg', [0xff, 0x00, 0x00])).toBe('failed');
    expect(tagged('image/webp', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')])).toBe('image'); expect(tagged('image/webp', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')])).toBe('failed');
    expect(tagged('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0a, 0x0a, 0x1a, 0x0a])).toBe('failed');
    expect(parseRead(txt({ text: 'x'.repeat(2000) })).kind).toBe('text'); expect(parseRead(txt({ text: 'a\ud83d\ude00b' })).kind).toBe('text');
  });
  it('the largest picture is drawn, and the answer\'s room is the contract\'s', () => {
    const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(READ_LIMITS.imageBytesMax - 8, 1)]).toString('base64');
    expect(parseRead(img({ s: READ_LIMITS.imageBytesMax, data }))).toMatchObject({ kind: 'image' });
    expect(READ_LIMITS).toEqual({ textBytesMax: 65536, lineCharsMax: 2000, textShownBytesMax: 131072, imageBytesMax: 153600, imagePixelsMax: 16000000, resultBytesMax: 220000 });
  });
});
