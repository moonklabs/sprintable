// story #4733 (S4b · Kadir's rule for every phone proxy) — the clock proxy: a non-UUID computer is a 404, the paths are exactly the contract's, only the closed
// body keys go on a POST, a GET carries one bare phone key id, and the caller's abort signal still reaches the upstream call.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import { DESKTOP_CLOCK_ACTIONS, DESKTOP_CLOCK_KEYS } from '@/lib/desktop-clock-keys';
import * as route from './route';
import { GET, POST } from './route';

const SETUP = '22222222-3333-4444-8555-666666666666';
const KEY = '99999999-9999-4999-8999-999999999999';
const url = (q = '') => `http://localhost:3000/api/desktop/setups/${SETUP}/clock${q}`;
const post = (body: unknown, q = '') => new Request(url(q), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const GOOD = { action: 'out_open', idempotency_key: 'i', signed: 'SIG', phone_key_id: KEY };

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{}', { status: 201 })); });

describe('POST /api/desktop/setups/[id]/clock', () => {
  it('exports only its HTTP handlers (a Next.js app route may export nothing else)', () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'POST']);
  });

  it('proxies to exactly /api/v2/desktop/setups/{id}/clock with the contract keys', async () => {
    const res = await POST(post(GOOD), params(SETUP));
    expect(res.status).toBe(201);
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/setups/${SETUP}/clock`);
    expect(req.method).toBe('POST');
    expect(await req.json()).toEqual(GOOD);
    expect([...DESKTOP_CLOCK_KEYS].sort()).toEqual(['action', 'agent_member_id', 'edit', 'idempotency_key', 'phone_key_id', 'signed']);
    expect([...DESKTOP_CLOCK_ACTIONS]).toEqual(['out_open', 'out_submit', 'out_cancel', 'in', 'out_edit']);
  });

  it('an edit (S5 · P2) carries the four keys of `edit` and nothing else in it; a caller\'s extra key inside the edit is dropped, and an edit that is not an object is a 422', async () => {
    const edit = { base_rev: 3, plan: '내일', done: 'd', blockers: '', session_key: 's', path: '/x', text: 't' };
    await POST(post({ ...GOOD, action: 'out_edit', agent_member_id: 'a-1', edit }), params(SETUP));
    const [req] = proxy.mock.calls[0] as [Request];
    expect(await req.json()).toEqual({ ...GOOD, action: 'out_edit', agent_member_id: 'a-1', edit: { base_rev: 3, plan: '내일', done: 'd', blockers: '' } });
    proxy.mockClear();
    for (const bad of [null, 'plan', ['plan'], 5]) expect((await POST(post({ ...GOOD, action: 'out_edit', agent_member_id: 'a-1', edit: bad }), params(SETUP))).status).toBe(422);
    expect(proxy).not.toHaveBeenCalled();
    // a press without an edit never gains one
    await POST(post(GOOD), params(SETUP));
    expect(await (proxy.mock.calls[0]![0] as Request).json()).toEqual(GOOD);
  });

  it('a press on one agent carries the agent id; nothing else rides on it (text · name · path · setup_id · kind · expiry sent by a caller is dropped here)', async () => {
    await POST(post({ ...GOOD, agent_member_id: 'a-1', text: 'x', name: 'n', path: '/x', cwd: '/x', setup_id: 'other', kind: 'clock', expires_at: 'x', session_key: 's', project_id: 'p' }), params(SETUP));
    const [req] = proxy.mock.calls[0] as [Request];
    expect(await req.json()).toEqual({ ...GOOD, agent_member_id: 'a-1' });
  });

  it('a non-UUID computer is a 404 and nothing is proxied; a body that is not an object is a 422', async () => {
    expect((await POST(post(GOOD), params('nope'))).status).toBe(404);
    for (const bad of ['null', '[]', '"x"', '5', 'not json']) expect((await POST(post(bad), params(SETUP))).status).toBe(422);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('no query string goes on a POST and the caller\'s abort signal still reaches the proxy', async () => {
    const ac = new AbortController();
    await POST(new Request(url(`?phone_key_id=${KEY}&path=/x`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(GOOD), signal: ac.signal }), params(SETUP));
    const [fwd] = proxy.mock.calls[0] as [Request];
    expect(new URL(fwd.url).search).toBe('');
    expect(fwd.signal.aborted).toBe(false);
    ac.abort();
    expect(fwd.signal.aborted).toBe(true);
  });
});

describe('GET /api/desktop/setups/[id]/clock', () => {
  it('proxies to /api/v2/desktop/setups/{id}/clock with one bare phone key id (any other query is dropped)', async () => {
    await GET(new Request(url(`?phone_key_id=${KEY}&path=/x&agent=a`)), params(SETUP));
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/setups/${SETUP}/clock`);
    expect(req.method).toBe('GET');
    expect(new URL(req.url).search).toBe(`?phone_key_id=${KEY}`);
  });

  it('a key id that is missing or not a UUID is a 422; a non-UUID computer a 404; nothing is proxied', async () => {
    expect((await GET(new Request(url()), params(SETUP))).status).toBe(422);
    expect((await GET(new Request(url('?phone_key_id=x')), params(SETUP))).status).toBe(422);
    expect((await GET(new Request(url(`?phone_key_id=${KEY}`)), params('nope'))).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
});
