// story #4714 (Kadir 5140 lens · 2) — the startable proxy: exactly /api/v2/desktop/startable, a bare UUID key id only (any other query is dropped,
// a key id that is not a UUID is refused here).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import * as route from './route';
import { GET } from './route';

const KEY = '99999999-9999-4999-8999-999999999999';
const get = (qs: string) => new Request(`http://localhost:3000/api/desktop/startable${qs}`, { method: 'GET' });

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{"remote_control":true,"computers":[]}', { status: 200 })); });

it('exports only its HTTP handler (a Next.js app route may export nothing else — the build refuses a helper here)', () => {
  expect(Object.keys(route)).toEqual(['GET']);
});

describe('GET /api/desktop/startable', () => {
  it('proxies to exactly /api/v2/desktop/startable with the key id', async () => {
    const res = await GET(get(`?phone_key_id=${KEY}`));
    expect(res.status).toBe(200);
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe('/api/v2/desktop/startable');
    expect(req.method).toBe('GET');
    expect(new URL(req.url).search).toBe(`?phone_key_id=${KEY}`);
  });

  it('any other query is dropped (a path · a project · another key riding on it never goes on)', async () => {
    await GET(get(`?phone_key_id=${KEY}&path=/Users/x&project_id=p&phone_key_id=${KEY.replace('9', '1')}`));
    const [req] = proxy.mock.calls[0] as [Request];
    expect(new URL(req.url).search).toBe(`?phone_key_id=${KEY}`);
  });

  it('the caller\'s abort signal still reaches the proxy', async () => {
    const ac = new AbortController();
    await GET(new Request(`http://localhost:3000/api/desktop/startable?phone_key_id=${KEY}`, { method: 'GET', signal: ac.signal }));
    const [fwd] = proxy.mock.calls[0] as [Request];
    expect(fwd.signal.aborted).toBe(false);
    ac.abort();
    expect(fwd.signal.aborted).toBe(true);
  });

  it.each(['', '?phone_key_id=', '?phone_key_id=x', `?phone_key_id=${KEY}x`, `?phone_key_id=../${KEY}`, '?other=1', `?phone_key_id=${KEY}%0A`, `?phone_key_id=${KEY}%0D%0A`, `?phone_key_id=%20${KEY}`])('a request of %j is a 422 and nothing is proxied', async (qs) => {
    const res = await GET(get(qs));
    expect(res.status).toBe(422);
    expect(proxy).not.toHaveBeenCalled();
  });
});
