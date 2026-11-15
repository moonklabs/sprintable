// story #4951 (①c) — the ask proxy: a non-UUID agent is a 404, the path is exactly /api/v2/agents/{id}/desktop-changes, and ONLY `session_key` goes on (a folder · path ·
// signature · text sent by a caller never reaches the server); the list proxy takes only UUIDs and carries nothing else.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import * as route from './route';
import { POST } from './route';
import * as listRoute from './[commandId]/route';
import { GET } from './[commandId]/route';

const AGENT = '22222222-3333-4444-8555-666666666666';
const COMMAND = '33333333-4444-4555-8666-777777777777';
const post = (body: unknown, search = '') => new Request(`http://localhost:3000/api/agents/${AGENT}/desktop-changes${search}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{}', { status: 201 })); });

describe('POST /api/agents/[id]/desktop-changes', () => {
  it('exports only its HTTP handler (a Next.js app route may export nothing else)', () => {
    expect(Object.keys(route)).toEqual(['POST']);
    expect(Object.keys(listRoute)).toEqual(['GET']);
  });

  it('proxies to exactly /api/v2/agents/{id}/desktop-changes with ONLY session_key — a folder · path · signature · text is dropped', async () => {
    const res = await POST(post({ session_key: 's-1', path: '/Users/x', folder: '/', signed: 'SIG', text: 'hi' }, '?x=1'), params(AGENT));
    expect(res.status).toBe(201);
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/agents/${AGENT}/desktop-changes`);
    expect(await req.json()).toEqual({ session_key: 's-1' });
    expect(new URL(req.url).search).toBe('');
  });

  it('a body that is not an object is 422 and a non-UUID agent is 404 — neither calls the server', async () => {
    expect((await POST(post([1]), params(AGENT))).status).toBe(422);
    expect((await POST(new Request('http://localhost:3000/x', { method: 'POST', body: 'not json' }), params(AGENT))).status).toBe(422);
    expect((await POST(post({ session_key: 's-1' }), params('../etc'))).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('GET: only UUID agent + command reach the server, on exactly that path', async () => {
    const get = new Request(`http://localhost:3000/api/agents/${AGENT}/desktop-changes/${COMMAND}`);
    expect((await GET(get, { params: Promise.resolve({ id: AGENT, commandId: 'nope' }) })).status).toBe(404);
    expect((await GET(get, { params: Promise.resolve({ id: 'nope', commandId: COMMAND }) })).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
    await GET(get, { params: Promise.resolve({ id: AGENT, commandId: COMMAND }) });
    expect(proxy.mock.calls[0]![1]).toBe(`/api/v2/agents/${AGENT}/desktop-changes/${COMMAND}`);
  });

  it('GET carries NO query upstream (a caller\'s `?…` is dropped, like the ask), and both answers say `Cache-Control: no-store` — the shared proxy drops the server\'s header, so this route says it again (codex ①c r1 #1 · #4)', async () => {
    proxy.mockImplementation(async () => new Response('{"state":"done"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const get = new Request(`http://localhost:3000/api/agents/${AGENT}/desktop-changes/${COMMAND}?x=1&admin=true`);
    const res = await GET(get, { params: Promise.resolve({ id: AGENT, commandId: COMMAND }) });
    expect(new URL((proxy.mock.calls[0]![0] as Request).url).search).toBe('');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ state: 'done' });
    const asked = await POST(post({ session_key: 's-1' }), params(AGENT));
    expect(asked.headers.get('Cache-Control')).toBe('no-store');
  });
});
