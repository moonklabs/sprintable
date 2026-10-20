// story 4734 — the three BFF proxies for the computer: the list, «모두 끊기», and the phone's [빼기] once for the computer. Each forwards to its backend path with the
// caller's request (auth rides along); ids that are not uuids never reach the backend.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxied = vi.hoisted(() => ({ calls: [] as Array<{ url: string; path: string; method: string }> }));
vi.mock('@/lib/fastapi-proxy', () => ({
  proxyToFastapi: vi.fn(async (request: Request, path: string) => { proxied.calls.push({ url: request.url, path, method: request.method }); return new Response('{}', { status: 200 }); }),
}));

import { GET } from './route';
import { DELETE as deleteComputer } from './[id]/route';
import { DELETE as removePhoneFromComputer } from '../../remote-devices/[id]/computers/[computerId]/route';

const ID = 'c1111111-1111-4111-8111-111111111111';
const PHONE = 'a2222222-2222-4222-8222-222222222222';
const req = (method: string) => new Request('http://localhost/x', { method, headers: { Authorization: 'Bearer at' } });

beforeEach(() => { proxied.calls.length = 0; });

describe('[4734] BFF routes for the computer', () => {
  it('GET /api/desktop/computers → /api/v2/desktop/computers', async () => {
    await GET(req('GET'));
    expect(proxied.calls).toEqual([{ url: 'http://localhost/x', path: '/api/v2/desktop/computers', method: 'GET' }]);
  });

  it('DELETE /api/desktop/computers/{id} → /api/v2/desktop/computers/{id}; an id that is not a uuid is 404 and never proxied', async () => {
    await deleteComputer(req('DELETE'), { params: Promise.resolve({ id: ID }) });
    expect(proxied.calls.map((c) => [c.method, c.path])).toEqual([['DELETE', `/api/v2/desktop/computers/${ID}`]]);
    proxied.calls.length = 0;
    const bad = await deleteComputer(req('DELETE'), { params: Promise.resolve({ id: '../setups/x' }) });
    expect(bad.status).toBe(404);
    expect(proxied.calls).toEqual([]);
  });

  it('DELETE /api/remote-devices/{id}/computers/{computerId} → the backend\'s phone ↔ computer route; either id not a uuid → 404, not proxied', async () => {
    await removePhoneFromComputer(req('DELETE'), { params: Promise.resolve({ id: PHONE, computerId: ID }) });
    expect(proxied.calls.map((c) => [c.method, c.path])).toEqual([['DELETE', `/api/v2/remote-devices/${PHONE}/computers/${ID}`]]);
    proxied.calls.length = 0;
    for (const params of [{ id: 'x', computerId: ID }, { id: PHONE, computerId: '1/2' }]) {
      expect((await removePhoneFromComputer(req('DELETE'), { params: Promise.resolve(params) })).status).toBe(404);
    }
    expect(proxied.calls).toEqual([]);
  });
});
