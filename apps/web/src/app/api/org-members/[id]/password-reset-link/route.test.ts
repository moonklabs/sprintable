// [SID:5023] the BFF route of POST /org-members/{id}/password-reset-link: the member id goes into the server's path and the answer (a secret link) goes back as it is.
import { describe, expect, it, vi } from 'vitest';

const proxy = vi.fn(async (_r: Request, path: string, params: Record<string, string>) => Response.json({ via: path, params }, { status: 200 }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams: (r: Request, p: string, params: Record<string, string>) => proxy(r, p, params) }));
import { POST } from './route';

describe('POST /api/org-members/[id]/password-reset-link', () => {
  it("goes to the server's route with the member id, once, and returns the server's answer untouched", async () => {
    const req = new Request('http://x/api/org-members/abc/password-reset-link', { method: 'POST', headers: { Authorization: 'Bearer at' } });
    const r = await POST(req, { params: Promise.resolve({ id: 'abc' }) });
    expect(await r.json()).toEqual({ via: '/api/v2/org-members/[id]/password-reset-link', params: { id: 'abc' } });
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy.mock.calls[0][0]).toBe(req);
  });
  it('the answer is never cached — the proxy drops the server\'s own Cache-Control, so this route sets it (on a link and on a refusal)', async () => {
    for (const status of [200, 403, 409, 429]) {
      proxy.mockImplementationOnce(async () => Response.json({ x: 1 }, { status }));
      const r = await POST(new Request('http://x/api/org-members/abc/password-reset-link', { method: 'POST' }), { params: Promise.resolve({ id: 'abc' }) });
      expect(r.status).toBe(status); expect(r.headers.get('cache-control')).toBe('private, no-store');
    }
  });
});
