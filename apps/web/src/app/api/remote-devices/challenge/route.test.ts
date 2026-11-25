// [SID:5027] the BFF route of POST /remote-devices/challenge: it goes straight to the server's route (the server's own answer is the answer) and never to another path.
import { describe, expect, it, vi } from 'vitest';

const proxy = vi.fn(async (_r: Request, path: string) => Response.json({ via: path }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: (r: Request, p: string) => proxy(r, p) }));
import { POST } from './route';
import { POST as registerPost } from '../route';

describe('POST /api/remote-devices/challenge', () => {
  it("goes to the server's challenge route, once", async () => {
    const req = new Request('http://x/api/remote-devices/challenge', { method: 'POST', headers: { Authorization: 'Bearer at' } });
    const r = await POST(req);
    expect(await r.json()).toEqual({ via: '/api/v2/remote-devices/challenge' });
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy.mock.calls[0][0]).toBe(req); // the request itself (its auth headers) goes on, nothing is rebuilt
  });
  it('the registration route is a different route (the challenge is not a registration)', () => {
    expect(POST).not.toBe(registerPost);
  });
});
