// story 4983 (P5) — the files proxies: a non-UUID is a 404 and calls nothing; the ask forwards exactly the four agreed fields (a path · a name · a text sent by a caller never reaches the server);
// the answer proxy carries only UUIDs; both answers are `no-store`.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import * as route from './route';
import { POST } from './route';
import * as answerRoute from './[commandId]/route';
import { GET } from './[commandId]/route';

const COMPUTER = '22222222-3333-4444-8555-666666666666';
const COMMAND = '33333333-4444-4555-8666-777777777777';
const post = (body: unknown, search = '') => { const text = JSON.stringify(body); return new Request(`http://localhost:3000/api/desktop/computers/${COMPUTER}/files${search}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(text).length) }, body: text }); };
const get = (search = '') => new Request(`http://localhost:3000/api/desktop/computers/${COMPUTER}/files/${COMMAND}${search}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const params2 = (id: string, commandId: string) => ({ params: Promise.resolve({ id, commandId }) });

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{}', { status: 201 })); });

describe('POST /api/desktop/computers/[id]/files', () => {
  it('exports only its HTTP handler (a Next.js app route may export nothing else)', () => {
    expect(Object.keys(route)).toEqual(['POST']);
    expect(Object.keys(answerRoute)).toEqual(['GET', 'DELETE']); // (story 4988: the person's «done / give up» of a download)
  });

  it('proxies to exactly /api/v2/desktop/computers/{id}/files with ONLY the four agreed fields', async () => {
    const body = { project_id: 'p', idempotency_key: 'k', phone_key_id: 'ph', envelope: { v: 1 } };
    const res = await POST(post({ ...body, path: '/Users/x', dir: ['a'], text: 'hi' }, '?x=1'), params(COMPUTER));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/computers/${COMPUTER}/files`);
    expect(await req.json()).toEqual(body);
    expect(new URL(req.url).search).toBe('');
  });

  it('a body over the size a request can have is 413 before it is parsed and calls nothing', async () => {
    const res = await POST(post({ envelope: { ct: 'x'.repeat(16 * 1024) } }), params(COMPUTER));
    expect(res.status).toBe(413);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('a body that is not an object is 422 and a non-UUID computer is 404 — neither calls the server', async () => {
    expect((await POST(post([1]), params(COMPUTER))).status).toBe(422);
    expect((await POST(new Request('http://localhost:3000/x', { method: 'POST', headers: { 'Content-Length': '8' }, body: 'not json' }), params(COMPUTER))).status).toBe(422);
    expect((await POST(new Request('http://localhost:3000/x', { method: 'POST', body: '{}' }), params(COMPUTER))).status).toBe(411);
    expect((await POST(post({}), params('../etc'))).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
});

describe('GET /api/desktop/computers/[id]/files/[commandId]', () => {
  it('proxies to exactly the answer path, no query, and says no-store again', async () => {
    proxy.mockImplementation(async () => new Response('{}', { status: 200, headers: { 'Cache-Control': 'max-age=60' } }));
    const res = await GET(get('?a=1'), params2(COMPUTER, COMMAND));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/computers/${COMPUTER}/files/${COMMAND}`);
    expect(new URL(req.url).search).toBe('');
  });

  it('a non-UUID in either place is 404 and calls nothing', async () => {
    expect((await GET(get(), params2('x', COMMAND))).status).toBe(404);
    expect((await GET(get(), params2(COMPUTER, '../x'))).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
});
