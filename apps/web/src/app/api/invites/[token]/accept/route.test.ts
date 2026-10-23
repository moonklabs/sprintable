import { beforeEach, describe, expect, it, vi } from 'vitest';

// story 4722 — a token-proven accept rotates the session in the same response, so the person's next page sees the organization just joined
const h = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  proxy: vi.fn(),
  backend: vi.fn(),
  csrf: vi.fn(),
}));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: h.csrf }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: h.cookieGet })) }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxy }));
vi.mock('@/lib/backend-fetch', () => ({ backendFetch: h.backend }));

import { POST } from './route';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const call = () => POST(new Request('http://localhost/api/invites/tok/accept', { method: 'POST' }), { params: Promise.resolve({ token: 'tok' }) });

describe('POST /api/invites/[token]/accept', () => {
  beforeEach(() => {
    h.csrf.mockReset().mockReturnValue(null);
    h.cookieGet.mockReset().mockImplementation((n: string) => (n === 'sp_rt' ? { value: 'old-rt' } : undefined));
    h.proxy.mockReset().mockImplementation(async () => ok({ ok: true, org_id: 'o1', role: 'member' }));
    h.backend.mockReset().mockImplementation(async () => ok({ data: { access_token: 'new-at', refresh_token: 'new-rt' } }));
  });

  it('accepted → the session is rotated: new sp_at / sp_rt on the same response, the refresh token sent is the cookie one', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_at=new-at');
    expect(setCookie).toContain('sp_rt=new-rt');
    expect(h.backend).toHaveBeenCalledTimes(1);
    const [url, init] = h.backend.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/api/v2/auth/refresh');
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'old-rt' });
  });

  it('a refused accept → no refresh at all, the refusal passes through unchanged', async () => {
    h.proxy.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'EXPIRED' } }), { status: 410 }));
    const res = await call();
    expect(res.status).toBe(410);
    expect(h.backend).not.toHaveBeenCalled();
  });

  it('the refresh fails (or throws) → the accept still succeeds, no cookie is touched', async () => {
    h.backend.mockImplementation(async () => new Response('{}', { status: 401 }));
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('sp_at=');
    h.backend.mockRejectedValue(new Error('down'));
    const res2 = await call();
    expect(res2.status).toBe(200);
    expect(res2.headers.get('set-cookie') ?? '').not.toContain('sp_at=');
  });

  it('a request from another origin is refused before the accept or any rotation (same check as /api/auth/refresh)', async () => {
    h.csrf.mockReturnValue(new Response(JSON.stringify({ error: { code: 'CSRF_FORBIDDEN' } }), { status: 403 }));
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.proxy).not.toHaveBeenCalled();
    expect(h.backend).not.toHaveBeenCalled();
  });

  it('a dead refresh token (401) leaves the cookies alone — the ordinary refresh path clears it, the accept stays a success', async () => {
    h.backend.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'TOKEN_REVOKED' } }), { status: 401 }));
    const res = await call();
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('sp_at');
    expect(setCookie).not.toContain('sp_rt');
  });

  it('no refresh cookie → nothing to rotate, the accept still succeeds', async () => {
    h.cookieGet.mockReturnValue(undefined);
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.backend).not.toHaveBeenCalled();
  });
});
