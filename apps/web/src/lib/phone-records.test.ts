// story 4977 (B3-2b) — the web's half of the phone history: the read through this app's own route, the hand-over to the shell, what is kept of the shell's answer (one closed state per row), the read to the end, the delete.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
import { deleteRoomRecords, readRecordsAll, readRecordsPage, RECORDS_OPEN_MAX_ROWS, RECORDS_PAGE, shellTakesRecords } from './phone-records';

const SETUP = '11111111-2222-4333-8444-555555555555';
const ROOM = '22222222-3333-4444-8555-666666666666';
const PHONE = '33333333-4444-4555-8666-777777777777';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const row = (seq: number) => ({ id: `r${seq}`, seq, record_id: `rec-${seq}`, kind: 'chat_line', rec_gen: 1, created_at: 'x', envelope: { v: 1, sealed: 'SEALED-WORDS' } });
const open = (seq: number, text: string, ts = 1000 + seq, over: Record<string, unknown> = {}) => ({ seq, record_id: `rec-${seq}`, kind: 'chat_line', rec_gen: 1, state: 'open', writer: 'phone', ts, frame: { conversation_id: ROOM, text, v: 1 }, ...over });
const closed = (seq: number, state: string) => ({ seq, record_id: `rec-${seq}`, kind: 'chat_line', rec_gen: 1, state });
const shell = (over: Record<string, unknown> = {}) => ({ id: 'c', ok: true, have_key: true, lines: [], next_after: 1, ...over }); // (next_after 1: the server's page in most cases below is row(1) with next_after 1 — the shell's cursor must equal it)
const args = { setupId: SETUP, conversationId: ROOM, phoneKeyId: PHONE };

beforeEach(() => { fetchWithAuth.mockReset(); });

describe('shellTakesRecords', () => {
  it('reads `records: 1` from shell.caps — never a version, never a guess', async () => {
    expect(await shellTakesRecords(async () => ({ id: 'c', ok: true, caps: { records: 1 } }))).toBe(true);
    for (const answer of [{ id: 'c', ok: true, caps: {} }, { id: 'c', ok: true, caps: { records: 2 } }, { id: 'c', ok: true, caps: { records: true } }, { id: 'c', ok: false, code: 'bad_request' }, { id: 'c', ok: true }]) {
      expect(await shellTakesRecords(async () => answer)).toBe(false);
    }
    expect(await shellTakesRecords(async () => { throw new Error('rejected'); })).toBe(false);
    expect(await shellTakesRecords(() => { throw new Error('thrown at once'); })).toBe(false);
    expect(await shellTakesRecords((() => undefined) as never)).toBe(false); // a bridge that answers nothing
  });
});

describe('readRecordsPage', () => {
  it('asks this app\'s own route with the agreed words only, hands the server\'s rows to the shell untouched and draws what the shell answers', async () => {
    const rows = [row(4), row(5), row(9)];
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: rows, next_after: 9 }));
    const phoneCall = vi.fn(async () => shell({ lines: [open(9, 'second', 1000), open(4, 'first', 2000), { ...open(5, 'asked', 1500), kind: 'approval_record', frame: { conversation_id: ROOM, decision: 'deny', request_id: ROOM, summary: 'rm -rf build', tool: 'Bash', v: 1 } }], next_after: 9 }));
    const out = await readRecordsPage({ phoneCall, ...args, after: 3, limit: 50 });
    const [url] = fetchWithAuth.mock.calls[0] as [string];
    expect(url.startsWith(`/api/desktop/computers/${SETUP}/records?`)).toBe(true);
    const q = new URL(url, 'http://x').searchParams;
    expect([...q.keys()].sort()).toEqual(['after', 'conversation_id', 'limit', 'phone_key_id']);
    expect([q.get('phone_key_id'), q.get('conversation_id'), q.get('after'), q.get('limit')]).toEqual([PHONE, ROOM, '3', '50']);
    expect(phoneCall).toHaveBeenCalledWith('records.open', { setup_id: SETUP, conversation_id: ROOM, rows, after: 3 }); // the very rows, nothing added or taken
    expect(out.kind).toBe('page');
    if (out.kind !== 'page') return;
    expect(out.lines.map((l) => l.seq)).toEqual([9, 5, 4]); // the writers' own times, oldest first — NOT the server's order (seq 4 came before seq 9, but was written after it)
    expect(out.lines[1]).toEqual({ seq: 5, recordId: 'rec-5', kind: 'approval_record', writer: 'phone', ts: 1500, decision: 'deny', tool: 'Bash', summary: 'rm -rf build' });
    expect(out).toMatchObject({ haveKey: true, nextAfter: 9, more: false, closed: { noKey: 0, unverified: 0, unreadable: 0 } });
  });

  it('no cursor when there is none (after 0 or absent) and the default page is the server\'s largest', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { records: [], next_after: 0 }));
    await readRecordsPage({ phoneCall: vi.fn(), ...args });
    await readRecordsPage({ phoneCall: vi.fn(), ...args, after: 0 });
    for (const call of fetchWithAuth.mock.calls) {
      const q = new URL(call[0] as string, 'http://x').searchParams;
      expect([...q.keys()].sort()).toEqual(['conversation_id', 'limit', 'phone_key_id']);
      expect(q.get('limit')).toBe(String(RECORDS_PAGE));
    }
  });

  it('an empty page asks the shell nothing and says «nothing was kept», not «no key»', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [], next_after: 0 }));
    const phoneCall = vi.fn();
    expect(await readRecordsPage({ phoneCall, ...args })).toEqual({ kind: 'page', lines: [], closed: { noKey: 0, unverified: 0, unreadable: 0 }, haveKey: true, nextAfter: 0, more: false });
    expect(phoneCall).not.toHaveBeenCalled();
  });

  it('the rows that could not be opened are only COUNTED, by the shell\'s closed word; an older version is shown and counted nowhere', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1), row(2), row(3), row(4), row(5), row(6)], next_after: 6 }));
    const lines = [closed(1, 'no_key'), closed(2, 'no_key'), closed(3, 'unverified'), closed(4, 'unreadable'), closed(5, 'stale'), open(6, 'visible')];
    const out = await readRecordsPage({ phoneCall: async () => shell({ lines, have_key: false, next_after: 6 }), ...args });
    expect(out).toMatchObject({ kind: 'page', haveKey: false, closed: { noKey: 2, unverified: 1, unreadable: 1 } });
    if (out.kind === 'page') expect(out.lines.map((l) => l.recordId)).toEqual(['rec-6']);
    expect(JSON.stringify(out)).not.toContain('SEALED-WORDS'); // no envelope ever reaches the draw
  });

  it('the shell can answer only for the rows the server gave: a line of another row, two lines of one row, more lines than rows, a longer page than asked — nothing is drawn', async () => {
    const rows = [row(1), row(2)];
    const answers: unknown[] = [
      shell({ lines: [open(1, 'a'), open(7, 'made up')], next_after: 2 }), // a row the server never gave
      shell({ lines: [open(1, 'a'), open(1, 'a again')], next_after: 2 }), // one row twice
      shell({ lines: [open(1, 'a'), open(2, 'b'), open(3, 'c')], next_after: 2 }), // more lines than rows
      shell({ lines: [{ ...open(1, 'a'), record_id: 'rec-other' }], next_after: 2 }), // the id is not that row's
    ];
    for (const a of answers) {
      fetchWithAuth.mockResolvedValueOnce(json(200, { records: rows, next_after: 2 }));
      expect((await readRecordsPage({ phoneCall: async () => a as never, ...args })).kind).toBe('failed');
    }
    // the control: the same page with honest lines is drawn
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: rows, next_after: 2 }));
    expect((await readRecordsPage({ phoneCall: async () => shell({ lines: [open(1, 'a'), open(2, 'b')], next_after: 2 }), ...args })).kind).toBe('page');
    // a page longer than the one asked for: refused although the shell would answer it
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1), row(2), row(3)], next_after: 3 }));
    expect((await readRecordsPage({ phoneCall: async () => shell({ lines: [open(1, 'a')], next_after: 3 }), ...args, limit: 2 })).kind).toBe('failed');
    // the same row twice from the server: refused although the shell would answer it
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1), row(1)], next_after: 1 }));
    expect((await readRecordsPage({ phoneCall: async () => shell({ lines: [open(1, 'a')], next_after: 1 }), ...args })).kind).toBe('failed');
    for (const bad of [[{ seq: 'x', record_id: 'r' }], [{ seq: 1 }], [null], [1]]) {
      fetchWithAuth.mockResolvedValueOnce(json(200, { records: bad, next_after: 1 }));
      expect((await readRecordsPage({ phoneCall: async () => shell({ lines: [open(1, 'a')], next_after: 1 }), ...args })).kind).toBe('failed'); // a row that has no seq / record id to answer for
    }
  });

  it('the server lists the rows AFTER the cursor: a row at or before it is a repeat — nothing is drawn', async () => {
    for (const seq of [5, 4, 1]) {
      fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(seq)], next_after: 9 }));
      expect((await readRecordsPage({ phoneCall: vi.fn(), ...args, after: 5 })).kind, `seq ${seq}`).toBe('failed');
    }
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(6)], next_after: 6 }));
    expect((await readRecordsPage({ phoneCall: async () => shell({ lines: [open(6, 'x')], next_after: 6 }), ...args, after: 5 })).kind).toBe('page');
  });

  it('a later page that repeats an earlier page\'s row ends the read in `failed` (the lines are never merged twice)', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(json(200, { records: Array.from({ length: RECORDS_PAGE }, (_, i) => row(i + 1)), next_after: 100 }))
      .mockResolvedValueOnce(json(200, { records: [row(100)], next_after: 100 })); // seq 100 again
    const out = await readRecordsAll({ phoneCall: async () => shell({ lines: [open(100, 'x')], next_after: 100 }), ...args });
    expect(out.kind).toBe('failed');
  });

  it('a line longer than the frames allow is not one the shell could have made', async () => {
    const rows = [row(1)];
    const tooLong: unknown[] = [
      open(1, 'x'.repeat(8001)),
      { ...open(1, 'x'), kind: 'approval_record', frame: { decision: 'allow', tool: 'Bash', summary: 's'.repeat(201) } },
      { ...open(1, 'x'), kind: 'approval_record', frame: { decision: 'allow', tool: 't'.repeat(65), summary: 's' } },
    ];
    for (const l of tooLong) {
      fetchWithAuth.mockResolvedValueOnce(json(200, { records: rows, next_after: 1 }));
      expect((await readRecordsPage({ phoneCall: async () => shell({ lines: [l] }), ...args })).kind).toBe('failed');
    }
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: rows, next_after: 1 }));
    expect((await readRecordsPage({ phoneCall: async () => shell({ lines: [open(1, 'x'.repeat(8000))], next_after: 1 }), ...args })).kind).toBe('page'); // the limit itself is fine
  });

  it('a full page says there is probably more', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(i + 1));
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: rows, next_after: 3 }));
    expect(await readRecordsPage({ phoneCall: async () => shell({ next_after: 3 }), ...args, limit: 3 })).toMatchObject({ more: true });
  });

  it('the server\'s refusals are closed words; a network end the web cannot see is never «refused»', async () => {
    const cases: Array<[Response | Error, string]> = [
      [json(409, { error: { code: 'phone_not_paired' } }), 'not_paired'], [json(404, { error: { code: 'record_conversation_not_found' } }), 'room_not_found'], [json(403, { error: { code: 'not_allowed_to_use_records' } }), 'not_allowed'],
      [json(401, {}), 'signed_out'], [json(500, {}), 'unreachable'], [json(502, {}), 'unreachable'], [json(422, { error: { code: 'bad_request' } }), 'failed'], [json(409, { error: { code: 'something_else' } }), 'failed'], [new Error('network'), 'unreachable'],
    ];
    for (const [r, kind] of cases) {
      if (r instanceof Error) fetchWithAuth.mockRejectedValueOnce(r); else fetchWithAuth.mockResolvedValueOnce(r);
      const phoneCall = vi.fn();
      expect((await readRecordsPage({ phoneCall, ...args })).kind, kind).toBe(kind);
      expect(phoneCall).not.toHaveBeenCalled(); // a refused read hands the shell nothing
    }
  });

  it('a server answer that is not the agreed shape is `failed`', async () => {
    for (const body of [null, [], {}, { records: 'x', next_after: 1 }, { records: [], next_after: 'x' }, { records: [], next_after: 1.5 }, { records: [] }]) {
      fetchWithAuth.mockResolvedValueOnce(json(200, body));
      expect((await readRecordsPage({ phoneCall: vi.fn(), ...args })).kind).toBe('failed');
    }
    fetchWithAuth.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect((await readRecordsPage({ phoneCall: vi.fn(), ...args })).kind).toBe('failed');
  });

  it('the shell\'s refusal words map to closed outcomes; an unknown word is `failed`', async () => {
    const cases: Array<[string, string]> = [['signed_out', 'signed_out'], ['bad_request', 'unsupported'], ['host_not_pinned', 'not_paired'], ['no_key', 'key'], ['not_registered', 'key'], ['vault_unavailable', 'failed'], ['record_keys_unavailable', 'failed'], ['failed', 'failed'], ['whatever', 'failed']];
    for (const [code, kind] of cases) {
      fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1)], next_after: 1 }));
      const out = await readRecordsPage({ phoneCall: async () => ({ id: 'c', ok: false, code }), ...args });
      expect(out.kind, code).toBe(kind);
    }
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1)], next_after: 1 }));
    expect((await readRecordsPage({ phoneCall: async () => { throw new Error('rejected'); }, ...args })).kind).toBe('failed');
  });

  it('a shell answer that is not the agreed shape draws NOTHING of the page', async () => {
    const bad: unknown[] = [shell({ lines: 'x' }), shell({ have_key: 'yes' }), shell({ next_after: 'x' }), shell({ next_after: 1.5 }),
      shell({ lines: [null] }), shell({ lines: [{ state: 'open' }] }), shell({ lines: [{ ...open(1, 'x'), writer: 'server' }] }), shell({ lines: [{ ...open(1, 'x'), ts: 'now' }] }), shell({ lines: [{ ...open(1, 'x'), ts: Infinity }] }),
      shell({ lines: [{ ...open(1, 'x'), frame: null }] }), shell({ lines: [{ ...open(1, 'x'), frame: { text: 5 } }] }), shell({ lines: [{ ...open(1, 'x'), kind: 'approval_record', frame: { decision: 'maybe', tool: 'Bash', summary: 's' } }] }),
      shell({ lines: [{ ...open(1, 'x'), kind: 'approval_record', frame: { decision: 'allow', tool: 5, summary: 's' } }] }), shell({ lines: [{ ...open(1, 'x'), kind: 'send_prompt' }] }), shell({ lines: [{ ...closed(1, 'weird') }] }),
      shell({ lines: [open(1, 'fine'), { ...closed(2, 'no_key'), seq: 'x' }] })];
    for (const answer of bad) {
      fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1)], next_after: 1 }));
      expect((await readRecordsPage({ phoneCall: async () => answer as never, ...args })).kind).toBe('failed');
    }
  });
});

describe('readRecordsAll', () => {
  const pageOf = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(from + i));
  it('reads page after page to the END (the server lists oldest first) and adds up what each page said', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(json(200, { records: pageOf(1, RECORDS_PAGE), next_after: 100 }))
      .mockResolvedValueOnce(json(200, { records: pageOf(101, 3), next_after: 103 }));
    const answers = [shell({ lines: [open(1, 'old'), closed(2, 'no_key')], next_after: 100, have_key: true }), shell({ lines: [open(103, 'newest'), closed(102, 'unverified')], next_after: 103, have_key: true })];
    const phoneCall = vi.fn(async () => answers.shift()!);
    const out = await readRecordsAll({ phoneCall, ...args });
    expect(out).toMatchObject({ kind: 'page', nextAfter: 103, more: false, haveKey: true, closed: { noKey: 1, unverified: 1, unreadable: 0 } });
    if (out.kind === 'page') expect(out.lines.map((l) => l.seq)).toEqual([1, 103]);
    expect(new URL(fetchWithAuth.mock.calls[1]![0] as string, 'http://x').searchParams.get('after')).toBe('100'); // the second page goes on from the shell's cursor
    expect(phoneCall).toHaveBeenNthCalledWith(2, 'records.open', expect.objectContaining({ after: 100 }));
  });

  it('stops at the limit of one opening and says there is more, with the cursor to go on from', async () => {
    const pages = RECORDS_OPEN_MAX_ROWS / RECORDS_PAGE;
    for (let i = 0; i < pages + 2; i++) fetchWithAuth.mockResolvedValueOnce(json(200, { records: pageOf(i * 100 + 1, RECORDS_PAGE), next_after: (i + 1) * 100 }));
    let n = 0;
    const out = await readRecordsAll({ phoneCall: async () => shell({ next_after: ++n * 100 }), ...args });
    expect(fetchWithAuth).toHaveBeenCalledTimes(pages);
    expect(out).toMatchObject({ kind: 'page', more: true, nextAfter: pages * 100 });
  });

  it('the first page that cannot be read ends the read with its own outcome (nothing half drawn)', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: pageOf(1, RECORDS_PAGE), next_after: 100 })).mockResolvedValueOnce(json(409, { error: { code: 'phone_not_paired' } }));
    expect((await readRecordsAll({ phoneCall: async () => shell({ lines: [open(1, 'x')], next_after: 100 }), ...args })).kind).toBe('not_paired');
  });

  it('a full page that does not move the cursor ends in `failed` — never an endless loop', async () => {
    fetchWithAuth.mockImplementation(async () => json(200, { records: pageOf(101, RECORDS_PAGE), next_after: 200 }));
    let calls = 0;
    const out = await readRecordsAll({ phoneCall: async () => { calls++; return shell({ lines: [open(101, 'x')], next_after: 100 }); }, ...args, after: 100 }); // the shell's cursor stays at 100
    expect(out.kind).toBe('failed');
    expect(calls).toBe(1);
  });

  it('one page that says the phone has a key makes it true', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(json(200, { records: pageOf(1, RECORDS_PAGE), next_after: 100 }))
      .mockResolvedValueOnce(json(200, { records: pageOf(101, 2), next_after: 102 }));
    const answers = [shell({ lines: [open(1, 'a')], next_after: 100, have_key: true }), shell({ lines: [open(101, 'b')], next_after: 102, have_key: false })];
    const out = await readRecordsAll({ phoneCall: async () => answers.shift()!, ...args });
    expect(out).toMatchObject({ kind: 'page', nextAfter: 102, haveKey: true });
  });

  it('the cursor the shell gives back must be the server\'s last row — a cursor that stops short (or runs ahead) would make the next page overlap or skip', async () => {
    for (const cursor of [4, 8, 10, 0]) {
      fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(5), row(9)], next_after: 9 }));
      expect((await readRecordsPage({ phoneCall: async () => shell({ lines: [open(5, 'a'), open(9, 'b')], next_after: cursor }), ...args })).kind, `cursor ${cursor}`).toBe('failed');
    }
  });

  it('a shell that answers nothing, or something that is not an answer, is `failed` — never a throw', async () => {
    for (const a of [null, undefined, 'x', 7, [], true, shell({ ok: 'yes', lines: [open(1, 'x')] }), shell({ ok: 1, lines: [open(1, 'x')] }), shell({ ok: undefined, lines: [open(1, 'x')] })]) {
      fetchWithAuth.mockResolvedValueOnce(json(200, { records: [row(1)], next_after: 1 }));
      expect((await readRecordsPage({ phoneCall: async () => a as never, ...args })).kind).toBe('failed');
    }
  });

  it('no key on any page: `haveKey` is false; one page that says otherwise makes it true', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { records: pageOf(1, 2), next_after: 2 }));
    expect(await readRecordsAll({ phoneCall: async () => shell({ lines: [closed(1, 'no_key'), closed(2, 'no_key')], have_key: false, next_after: 2 }), ...args })).toMatchObject({ haveKey: false, closed: { noKey: 2 } });
  });
});

describe('deleteRoomRecords', () => {
  it('asks this app\'s own route with the room only, and says how many went', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { deleted: 3 }));
    expect(await deleteRoomRecords(ROOM)).toEqual({ kind: 'deleted', count: 3 });
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/desktop/records?conversation_id=${ROOM}`);
    expect(init.method).toBe('DELETE');
  });
  it('every other end is one closed word', async () => {
    const cases: Array<[Response | Error, string]> = [[json(404, { error: { code: 'record_conversation_not_found' } }), 'room_not_found'], [json(401, {}), 'signed_out'], [json(500, {}), 'unreachable'], [json(400, {}), 'failed'], [json(200, { deleted: 'x' }), 'failed'], [json(200, { deleted: -1 }), 'failed'], [json(200, {}), 'failed'], [new Error('net'), 'unreachable']];
    for (const [r, kind] of cases) {
      if (r instanceof Error) fetchWithAuth.mockRejectedValueOnce(r); else fetchWithAuth.mockResolvedValueOnce(r);
      expect((await deleteRoomRecords(ROOM)).kind, kind).toBe(kind);
    }
  });
});
