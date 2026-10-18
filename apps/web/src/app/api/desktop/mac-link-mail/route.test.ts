// story #4714 AC2 — the mail-me-a-Mac-link proxy: nothing from the caller goes on (no body · no query · no address), the path is exactly the
// server's, and where the Mac app is not offered the server is never asked (409 download_not_enabled).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import * as route from './route';
import { POST } from './route';

const post = (init: RequestInit = {}, qs = '') => new Request(`http://localhost:3000/api/desktop/mac-link-mail${qs}`, { method: 'POST', ...init });

beforeEach(() => {
  proxy.mockReset().mockImplementation(async () => new Response('{"delivered":true,"email":"own@example.test"}', { status: 200 }));
  vi.stubEnv('DESKTOP_DOWNLOAD_ENABLED', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/desktop/mac-link-mail', () => {
  it('exports only its HTTP handler (a Next.js app route may export nothing else — the build refuses a helper here)', () => {
    expect(Object.keys(route)).toEqual(['POST']);
  });

  it('proxies a POST to exactly /api/v2/desktop/mac-link-mail', async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(proxy).toHaveBeenCalledTimes(1);
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe('/api/v2/desktop/mac-link-mail');
    expect(req.method).toBe('POST');
  });

  it('nothing the caller sent goes on: the body (an address) and the query are dropped', async () => {
    await POST(post({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'victim@example.test', to: 'victim@example.test' }) }, '?email=victim@example.test&to=victim@example.test'));
    const [req] = proxy.mock.calls[0] as [Request];
    expect(new URL(req.url).search).toBe('');
    expect(await req.text()).toBe('');
    expect(req.headers.get('content-type')).toBeNull();
  });

  it('where the Mac app is not offered the server is not asked at all: 409 download_not_enabled', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
      vi.stubEnv('DESKTOP_DOWNLOAD_ENABLED', value as string);
      const res = await POST(post());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: 'download_not_enabled' } });
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('the caller\'s abort signal still reaches the proxy', async () => {
    const ac = new AbortController();
    await POST(post({ signal: ac.signal }));
    const [req] = proxy.mock.calls[0] as [Request];
    ac.abort();
    expect(req.signal.aborted).toBe(true);
  });
});
