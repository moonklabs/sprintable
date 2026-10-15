// [SID:4695] the BFF route of GET /remote-devices/pairing-target: only a setup id of the right shape goes on to the server (the server's own answer is the answer).
import { describe, expect, it, vi } from 'vitest';

const proxy = vi.fn(async (_r: Request, path: string) => Response.json({ via: path }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: (r: Request, p: string) => proxy(r, p) }));
import { GET } from './route';

const ID = '12345678-9abc-4def-8123-456789abcdef';

describe('GET /api/remote-devices/pairing-target', () => {
  it('a proper setup id → the server\'s route (the query goes along)', async () => {
    const r = await GET(new Request(`http://x/api/remote-devices/pairing-target?setup_id=${ID}`));
    expect(await r.json()).toEqual({ via: '/api/v2/remote-devices/pairing-target' });
    expect(proxy).toHaveBeenCalledTimes(1);
  });
  it('no id · a malformed id · another shape → 404 setup_not_found without asking the server', async () => {
    proxy.mockClear();
    for (const q of ['', '?setup_id=', '?setup_id=../x', '?setup_id=12345678-9abc-4def-8123-456789abcdeg', `?setup_id=${ID}x`]) {
      const r = await GET(new Request(`http://x/api/remote-devices/pairing-target${q}`));
      expect(r.status).toBe(404);
      expect((await r.json()).error.code).toBe('setup_not_found');
    }
    expect(proxy).not.toHaveBeenCalled();
  });
});
