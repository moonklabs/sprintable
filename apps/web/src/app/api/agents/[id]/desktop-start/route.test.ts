// story #4714 (Kadir 5140 lens · 2 · 3) — the start proxy: a non-UUID agent is a 404, the path is exactly /api/v2/agents/{id}/desktop-start, and only the
// five contract keys go on (a path · cwd · mode · args · runtime sent by a caller never reaches the server).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import { DESKTOP_START_KEYS } from '@/lib/desktop-start-keys';
import * as route from './route';
import { POST } from './route';

const AGENT = '22222222-3333-4444-8555-666666666666';
const post = (body: unknown) => new Request(`http://localhost:3000/api/agents/${AGENT}/desktop-start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const GOOD = { setup_id: 's', project_id: 'p', signed: 'SIG', phone_key_id: 'k', idempotency_key: 'i' };

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{}', { status: 201 })); });

describe('POST /api/agents/[id]/desktop-start', () => {
  it('exports only its HTTP handler (a Next.js app route may export nothing else — the build refuses a helper here)', () => {
    expect(Object.keys(route)).toEqual(['POST']);
  });

  it('proxies to exactly /api/v2/agents/{id}/desktop-start with the five contract keys', async () => {
    const res = await POST(post(GOOD), params(AGENT));
    expect(res.status).toBe(201);
    expect(proxy).toHaveBeenCalledTimes(1);
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/agents/${AGENT}/desktop-start`);
    expect(req.method).toBe('POST');
    expect(await req.json()).toEqual(GOOD);
    expect([...DESKTOP_START_KEYS].sort()).toEqual(['idempotency_key', 'phone_key_id', 'project_id', 'setup_id', 'signed']);
  });

  it('only those five keys go on — whatever else a caller sent (path · cwd · folder · mode · args · runtime · text) is dropped here', async () => {
    await POST(post({ ...GOOD, path: '/Users/x', cwd: '/x', folder: 'f', mode: 'bypass', args: ['--x'], runtime: 'claude', text: 'hi', agent_member_id: 'a' }), params(AGENT));
    const [req] = proxy.mock.calls[0] as [Request];
    expect(Object.keys(await req.json()).sort()).toEqual(['idempotency_key', 'phone_key_id', 'project_id', 'setup_id', 'signed']);
  });

  it('no query string goes on (the contract has none) and the caller\'s abort signal still reaches the proxy', async () => {
    const ac = new AbortController();
    const req = new Request(`http://localhost:3000/api/agents/${AGENT}/desktop-start?phone_key_id=other&path=/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(GOOD), signal: ac.signal });
    await POST(req, params(AGENT));
    const [fwd] = proxy.mock.calls[0] as [Request];
    expect(new URL(fwd.url).search).toBe('');
    expect(fwd.signal.aborted).toBe(false);
    ac.abort();
    expect(fwd.signal.aborted).toBe(true);
  });

  it('a key that was not sent is not invented (the server refuses the missing one)', async () => {
    await POST(post({ setup_id: 's', signed: 'SIG' }), params(AGENT));
    const [req] = proxy.mock.calls[0] as [Request];
    expect(await req.json()).toEqual({ setup_id: 's', signed: 'SIG' });
  });

  it.each(['not-a-uuid', '../x', `${AGENT}/extra`, AGENT.slice(1), '', `${AGENT}\n`, `${AGENT}\r\n`, ` ${AGENT}`])('an agent id of %j is a 404 and nothing is proxied', async (id) => {
    const res = await POST(post(GOOD), params(id));
    expect(res.status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });

  it.each(['not json', 'null', '[]', '7', '"x"'])('a body of %j is a 422 and nothing is proxied', async (body) => {
    const res = await POST(post(body), params(AGENT));
    expect(res.status).toBe(422);
    expect(proxy).not.toHaveBeenCalled();
  });
});
