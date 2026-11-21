// story 4978 (C1b-phone) — the web's half of the record key handoff: it only CARRIES bytes. What the shell is promised and what it is told, which rows are acknowledged (exactly the ones the shell TOOK), the closed outcomes, and that nothing of an envelope is read here.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
import { HANDOFF_PAGE, sendHandoff, shellTakesHandoff, takeHandoffs } from './phone-handoff';

const SETUP = '11111111-2222-4333-8444-555555555555';
const PHONE = '33333333-4444-4555-8666-777777777777';
const rid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const row = (i: number, over: Record<string, unknown> = {}) => ({ id: rid(i), setup_id: SETUP, envelope: { v: 1, kind: 'record_handoff', ct: `SEALED-${i}` }, created_at: '2026-11-21T00:00:00Z', ...over });
/** a phone bridge: caps, key info and the two handoff calls */
const bridge = (over: Record<string, (args: Record<string, unknown>) => unknown> = {}) => {
  const calls: Array<{ type: string; args: Record<string, unknown> }> = [];
  const call = vi.fn(async (type: string, args: Record<string, unknown> = {}) => {
    calls.push({ type, args });
    if (over[type]) return over[type]!(args) as never;
    if (type === 'shell.caps') return { id: 'c', ok: true, caps: { record_handoff: 1 } };
    if (type === 'device.key.info') return { id: 'c', ok: true, key_number: '482 917', public_key: 'x' };
    return { id: 'c', ok: false, code: 'bad_request' };
  });
  return { call, calls };
};
const devices = () => json(200, { devices: [{ id: PHONE, confirm_number: '482 917' }, { id: 'not-a-uuid', confirm_number: '111 111' }] });

beforeEach(() => { fetchWithAuth.mockReset(); });

describe('shellTakesHandoff', () => {
  it('reads `record_handoff: 1` from shell.caps — never a version, never a guess', async () => {
    expect(await shellTakesHandoff(async () => ({ id: 'c', ok: true, caps: { record_handoff: 1 } }))).toBe(true);
    for (const a of [{ id: 'c', ok: true, caps: {} }, { id: 'c', ok: true, caps: { record_handoff: 2 } }, { id: 'c', ok: true, caps: { record_handoff: true } }, { id: 'c', ok: false, code: 'bad_request' }]) expect(await shellTakesHandoff(async () => a)).toBe(false);
    expect(await shellTakesHandoff(async () => { throw new Error('x'); })).toBe(false);
  });
});

describe('takeHandoffs', () => {
  it('lists this phone\'s rows through the app\'s own route, hands the shell exactly {id, setup_id, envelope}, and tells the server ONLY the rows the shell took', async () => {
    const b = bridge({ 'handoff.take': () => ({ id: 'c', ok: true, taken: [rid(1), rid(3)], later: [rid(2)], rejected: 0 }) });
    fetchWithAuth.mockResolvedValueOnce(devices()).mockResolvedValueOnce(json(200, { items: [row(1), row(2), row(3)] })).mockResolvedValue(json(200, { deleted: true }));
    const out = await takeHandoffs({ phoneCall: b.call });
    expect(out).toEqual({ kind: 'done', seen: 3, taken: 2, later: 1, rejected: 0, acked: 2 });
    const urls = fetchWithAuth.mock.calls.map((c) => c[0] as string);
    expect(urls[1]).toBe(`/api/desktop/record-handoffs?phone_key_id=${PHONE}`);
    expect(urls.slice(2)).toEqual([`/api/desktop/record-handoffs/${rid(1)}/received?phone_key_id=${PHONE}`, `/api/desktop/record-handoffs/${rid(3)}/received?phone_key_id=${PHONE}`]); // row 2 was NOT taken: no received
    const take = b.calls.find((c) => c.type === 'handoff.take')!;
    expect(Object.keys(take.args)).toEqual(['items']);
    expect((take.args.items as Array<Record<string, unknown>>).map((i) => Object.keys(i).sort())).toEqual([['envelope', 'id', 'setup_id'], ['envelope', 'id', 'setup_id'], ['envelope', 'id', 'setup_id']]); // (created_at is not carried)
    expect((take.args.items as Array<{ envelope: unknown }>)[0]!.envelope).toEqual({ v: 1, kind: 'record_handoff', ct: 'SEALED-1' }); // the envelope untouched
  });
  it('a word of «taken» that is not a row of this page is not acknowledged; a repeated one once; a failed «received» is not an error (the next look asks again)', async () => {
    const b = bridge({ 'handoff.take': () => ({ id: 'c', ok: true, taken: [rid(1), rid(1), rid(99), 5, null], later: [], rejected: 0 }) });
    fetchWithAuth.mockResolvedValueOnce(devices()).mockResolvedValueOnce(json(200, { items: [row(1)] })).mockRejectedValueOnce(new Error('net'));
    const out = await takeHandoffs({ phoneCall: b.call });
    expect(out).toEqual({ kind: 'done', seen: 1, taken: 1, later: 0, rejected: 0, acked: 0 });
    expect(fetchWithAuth).toHaveBeenCalledTimes(3);
  });
  it('an empty list calls the shell\'s take for nothing and posts nothing', async () => {
    const b = bridge(); fetchWithAuth.mockResolvedValueOnce(devices()).mockResolvedValueOnce(json(200, { items: [] }));
    expect(await takeHandoffs({ phoneCall: b.call })).toEqual({ kind: 'done', seen: 0, taken: 0, later: 0, rejected: 0, acked: 0 });
    expect(b.calls.some((c) => c.type === 'handoff.take')).toBe(false);
  });
  it('the closed outcomes: an older shell · no phone key on the server · signed out · the server unreachable · a list that is not a list · a shell that refused the call', async () => {
    const old = bridge({ 'shell.caps': () => ({ id: 'c', ok: true, caps: {} }) }); expect(await takeHandoffs({ phoneCall: old.call })).toEqual({ kind: 'unsupported' });
    const b = bridge(); fetchWithAuth.mockResolvedValueOnce(json(200, { devices: [{ id: PHONE, confirm_number: '000 000' }] })); expect(await takeHandoffs({ phoneCall: b.call })).toEqual({ kind: 'no_phone' });
    fetchWithAuth.mockResolvedValueOnce(json(401)); expect(await takeHandoffs({ phoneCall: b.call })).toEqual({ kind: 'signed_out' });
    fetchWithAuth.mockResolvedValueOnce(devices()).mockResolvedValueOnce(json(503)); expect(await takeHandoffs({ phoneCall: b.call })).toEqual({ kind: 'unreachable' });
    fetchWithAuth.mockResolvedValueOnce(devices()).mockRejectedValueOnce(new Error('net')); expect(await takeHandoffs({ phoneCall: b.call })).toEqual({ kind: 'unreachable' });
    for (const bad of [{ items: 'x' }, { items: [5] }, { items: [row(1, { id: 'x' })] }, { items: [row(1, { setup_id: 'x' })] }, { items: [row(1, { envelope: 'x' })] }, { items: Array.from({ length: HANDOFF_PAGE + 1 }, (_, i) => row(i + 1)) }]) {
      fetchWithAuth.mockResolvedValueOnce(devices()).mockResolvedValueOnce(json(200, bad)); expect(await takeHandoffs({ phoneCall: b.call }), JSON.stringify(bad).slice(0, 40)).toEqual({ kind: 'failed' });
    }
    for (const [ans, want] of [[{ id: 'c', ok: false, code: 'record_keys_unavailable' }, { kind: 'shell', code: 'record_keys_unavailable' }], [{ id: 'c', ok: false, code: 'signed_out' }, { kind: 'signed_out' }], [{ id: 'c', ok: false, code: 'bad_request' }, { kind: 'unsupported' }], [{ id: 'c', ok: false }, { kind: 'failed' }]] as const) {
      const s = bridge({ 'handoff.take': () => ans }); fetchWithAuth.mockResolvedValueOnce(devices()).mockResolvedValueOnce(json(200, { items: [row(1)] }));
      expect(await takeHandoffs({ phoneCall: s.call })).toEqual(want); expect(fetchWithAuth).not.toHaveBeenCalledWith(expect.stringContaining('/received'), expect.anything()); // a refused call acknowledges nothing
    }
  });
});

describe('sendHandoff', () => {
  const made = { id: 'c', ok: true, sent: true, phone_key_id: PHONE, envelope: { v: 1, kind: 'record_handoff', ct: 'SEALED' } };
  it('asks the shell for the envelope of THIS setup (nothing else rides on the call) and puts exactly {envelope} under the phone\'s own key id', async () => {
    const b = bridge({ 'handoff.make': () => made }); fetchWithAuth.mockResolvedValueOnce(json(201, { id: rid(1), expires_at: 'x' }));
    expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP })).toEqual({ kind: 'sent' });
    expect(b.calls.find((c) => c.type === 'handoff.make')!.args).toEqual({ setup_id: SETUP });
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/desktop/setups/${SETUP}/record-handoffs/${PHONE}`); expect(init.method).toBe('PUT'); expect(JSON.parse(init.body as string)).toEqual({ envelope: made.envelope });
  });
  it('the shell\'s «nothing to put» (the person\'s choice · no key) puts nothing', async () => {
    for (const [reason, want] of [['new_only', 'new_only'], ['no_keys', 'no_keys'], ['whatever', 'no_keys']] as const) {
      const b = bridge({ 'handoff.make': () => ({ id: 'c', ok: true, sent: false, reason }) });
      expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP })).toEqual({ kind: 'not_sent', reason: want });
    }
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
  it('the closed outcomes: no press · cancelled prompt · signed out · an older shell · the shell\'s own word · the server\'s word on the put', async () => {
    for (const [ans, want] of [[{ id: 'c', ok: false, code: 'no_plan' }, { kind: 'no_plan' }], [{ id: 'c', ok: false, code: 'cancelled' }, { kind: 'cancelled' }], [{ id: 'c', ok: false, code: 'signed_out' }, { kind: 'signed_out' }], [{ id: 'c', ok: false, code: 'bad_request' }, { kind: 'unsupported' }], [{ id: 'c', ok: false, code: 'host_not_pinned' }, { kind: 'shell', code: 'host_not_pinned' }], [{ id: 'c', ok: false }, { kind: 'failed' }]] as const) {
      expect(await sendHandoff({ phoneCall: bridge({ 'handoff.make': () => ans }).call, setupId: SETUP }), JSON.stringify(ans)).toEqual(want);
    }
    expect(fetchWithAuth).not.toHaveBeenCalled();
    const b = bridge({ 'handoff.make': () => made }); const noWait = { retryWaitsMs: [] as number[] };
    fetchWithAuth.mockResolvedValueOnce(json(401)); expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP, ...noWait })).toEqual({ kind: 'signed_out' });
    fetchWithAuth.mockResolvedValueOnce(json(502)); expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP, ...noWait })).toEqual({ kind: 'unreachable' });
    fetchWithAuth.mockRejectedValueOnce(new Error('net')); expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP, ...noWait })).toEqual({ kind: 'unreachable' });
    fetchWithAuth.mockResolvedValueOnce(json(409, { error: { code: 'phone_not_paired' } })); expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP, ...noWait })).toEqual({ kind: 'refused', code: 'phone_not_paired' });
    fetchWithAuth.mockResolvedValueOnce(json(422)); expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP, ...noWait })).toEqual({ kind: 'refused', code: 'http_422' });
  });
  it('a put that did not get through is repeated with the SAME envelope (the shell sealed once: one OS prompt) — a network drop, a 5xx, a 429; a refusal of the server (4xx) is not repeated; after the last wait it is «unreachable»', async () => {
    const b = bridge({ 'handoff.make': () => made }); const waits = { retryWaitsMs: [0, 0, 0] };
    fetchWithAuth.mockRejectedValueOnce(new Error('net')).mockResolvedValueOnce(json(503)).mockResolvedValueOnce(json(429)).mockResolvedValueOnce(json(201, { id: rid(1) }));
    expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP, ...waits })).toEqual({ kind: 'sent' });
    expect(fetchWithAuth).toHaveBeenCalledTimes(4); expect(b.calls.filter((c) => c.type === 'handoff.make')).toHaveLength(1); // sealed once
    const bodies = new Set(fetchWithAuth.mock.calls.map((c) => (c[1] as RequestInit).body)); expect(bodies.size).toBe(1); // the same bytes every time
    fetchWithAuth.mockReset().mockResolvedValue(json(502));
    expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP, ...waits })).toEqual({ kind: 'unreachable' }); expect(fetchWithAuth).toHaveBeenCalledTimes(4); // 1 + 3 waits
    fetchWithAuth.mockReset().mockResolvedValue(json(409, { error: { code: 'phone_not_paired' } }));
    expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP, ...waits })).toEqual({ kind: 'refused', code: 'phone_not_paired' }); expect(fetchWithAuth).toHaveBeenCalledTimes(1); // not repeated
    fetchWithAuth.mockReset().mockResolvedValueOnce(json(401)); expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP, ...waits })).toEqual({ kind: 'signed_out' });
  });
  it('a shell.caps call that FAILS (a timeout · a rejection · another refusal) is not «an older shell»: take and send answer `failed`, the watch tries again — only the shell\'s own «no» / bad_request is `unsupported`', async () => {
    for (const caps of [() => { throw new Error('timeout'); }, () => ({ id: 'c', ok: false, code: 'timeout' }), () => ({ id: 'c', ok: false, code: 'page_hidden' }), () => null]) {
      const b = bridge({ 'shell.caps': caps as never });
      expect(await takeHandoffs({ phoneCall: b.call })).toEqual({ kind: 'failed' });
      expect(await sendHandoff({ phoneCall: b.call, setupId: SETUP })).toEqual({ kind: 'failed' });
    }
    expect(await takeHandoffs({ phoneCall: bridge({ 'shell.caps': () => ({ id: 'c', ok: false, code: 'bad_request' }) }).call })).toEqual({ kind: 'unsupported' });
  });
  it('a cache given by a watch spares the capability and the key id from the second look on', async () => {
    const b = bridge(); const cache = {};
    fetchWithAuth.mockResolvedValueOnce(devices()).mockResolvedValue(json(200, { items: [] }));
    await takeHandoffs({ phoneCall: b.call, cache }); await takeHandoffs({ phoneCall: b.call, cache }); await takeHandoffs({ phoneCall: b.call, cache });
    expect(b.calls.filter((c) => c.type === 'shell.caps')).toHaveLength(1); expect(b.calls.filter((c) => c.type === 'device.key.info')).toHaveLength(1);
    expect(fetchWithAuth.mock.calls.filter((c) => String(c[0]).startsWith('/api/remote-devices'))).toHaveLength(1); // the device list once; the handoff list every look
    expect(fetchWithAuth.mock.calls.filter((c) => String(c[0]).startsWith('/api/desktop/record-handoffs'))).toHaveLength(3);
  });
  it('a shell answer that is not an envelope with a phone key id is a failure (nothing is put); a setup that is not a uuid never reaches the shell', async () => {
    for (const bad of [{ id: 'c', ok: true, sent: true, envelope: { v: 1 } }, { id: 'c', ok: true, sent: true, phone_key_id: 'x', envelope: { v: 1 } }, { id: 'c', ok: true, sent: true, phone_key_id: PHONE, envelope: 'x' }, { id: 'c', ok: true, sent: true, phone_key_id: PHONE }]) {
      expect(await sendHandoff({ phoneCall: bridge({ 'handoff.make': () => bad }).call, setupId: SETUP })).toEqual({ kind: 'failed' });
    }
    const b = bridge(); expect(await sendHandoff({ phoneCall: b.call, setupId: 'x' })).toEqual({ kind: 'failed' }); expect(b.calls).toEqual([]);
    expect(await sendHandoff({ phoneCall: bridge({ 'shell.caps': () => ({ id: 'c', ok: true, caps: {} }) }).call, setupId: SETUP })).toEqual({ kind: 'unsupported' });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
