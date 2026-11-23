// story 4993 (4c-2) — the direct-door proxies: a non-UUID is a 404 and calls nothing; the ask forwards exactly the three agreed fields (an address · a ticket · a text sent by a caller never reaches the server);
// the answer proxy carries only UUIDs; every answer is `no-store`.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import * as route from './route';
import { POST } from './route';
import * as answerRoute from './[commandId]/route';
import { DELETE, GET } from './[commandId]/route';

const COMPUTER = '22222222-3333-4444-8555-666666666666';
const COMMAND = '33333333-4444-4555-8666-777777777777';
const post = (body: unknown, search = '') => { const text = JSON.stringify(body); return new Request(`http://localhost:3000/api/desktop/computers/${COMPUTER}/direct${search}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(text).length) }, body: text }); };
const get = (search = '') => new Request(`http://localhost:3000/api/desktop/computers/${COMPUTER}/direct/${COMMAND}${search}`);
const del = (search = '') => new Request(`http://localhost:3000/api/desktop/computers/${COMPUTER}/direct/${COMMAND}${search}`, { method: 'DELETE' });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const params2 = (id: string, commandId: string) => ({ params: Promise.resolve({ id, commandId }) });

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{}', { status: 201 })); });

describe('POST /api/desktop/computers/[id]/direct', () => {
  it('exports only its HTTP handlers (a Next.js app route may export nothing else)', () => {
    expect(Object.keys(route)).toEqual(['POST']);
    expect(Object.keys(answerRoute).sort()).toEqual(['DELETE', 'GET']);
  });

  it('proxies to exactly /api/v2/desktop/computers/{id}/direct with ONLY the three agreed fields', async () => {
    const body = { idempotency_key: 'k-press-0001', phone_key_id: 'ph', envelope: { v: 1 } };
    const res = await POST(post({ ...body, host: '192.168.1.5', port: 4000, ticket: 'x', project_id: 'p', text: 'hi' }, '?x=1'), params(COMPUTER));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/computers/${COMPUTER}/direct`);
    expect(await req.json()).toEqual(body);
    expect(new URL(req.url).search).toBe('');
  });

  it('a body over what an ask can be (8 KiB, the server\'s own limit) is 413 before it is parsed and calls nothing', async () => {
    expect((await POST(post({ envelope: { ct: 'x'.repeat(9 * 1024) } }), params(COMPUTER))).status).toBe(413);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('a body that is not an object is 422 · no length is 411 · a non-UUID computer is 404 — none calls the server', async () => {
    expect((await POST(post([1]), params(COMPUTER))).status).toBe(422);
    expect((await POST(new Request('http://localhost:3000/x', { method: 'POST', headers: { 'Content-Length': '8' }, body: 'not json' }), params(COMPUTER))).status).toBe(422);
    expect((await POST(new Request('http://localhost:3000/x', { method: 'POST', body: '{}' }), params(COMPUTER))).status).toBe(411);
    expect((await POST(post({}), params('../etc'))).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
});

describe('GET · DELETE /api/desktop/computers/[id]/direct/[commandId]', () => {
  it('GET proxies to exactly the answer path, no query, and says no-store again', async () => {
    proxy.mockImplementation(async () => new Response('{}', { status: 200, headers: { 'Cache-Control': 'max-age=60' } }));
    const res = await GET(get('?a=1'), params2(COMPUTER, COMMAND));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/computers/${COMPUTER}/direct/${COMMAND}`); expect(req.method).toBe('GET'); expect(new URL(req.url).search).toBe('');
  });

  it('DELETE proxies to the same path with its own method and says no-store', async () => {
    proxy.mockImplementation(async () => new Response('{"deleted":true}', { status: 200 }));
    const res = await DELETE(del('?a=1'), params2(COMPUTER, COMMAND));
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/computers/${COMPUTER}/direct/${COMMAND}`); expect(req.method).toBe('DELETE'); expect(new URL(req.url).search).toBe('');
  });

  it('a non-UUID computer or command is 404 and calls nothing — for both methods', async () => {
    for (const fn of [GET, DELETE]) { for (const [a, b] of [['../x', COMMAND], [COMPUTER, '../x'], [COMPUTER, '1']] as const) expect((await fn(get(), params2(a, b))).status).toBe(404); }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('the server\'s refusal passes through unchanged (404 `direct_ask_not_found` · 429 `direct_polled_too_fast`)', async () => {
    proxy.mockImplementation(async () => new Response('{"error":{"code":"direct_polled_too_fast"}}', { status: 429 }));
    const res = await GET(get(), params2(COMPUTER, COMMAND)); expect(res.status).toBe(429); expect(await res.text()).toContain('direct_polled_too_fast');
  });
});
