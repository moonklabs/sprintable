// story 4972 — the new pairing's BFF routes: each proxies to its own backend path, and only ids of the right shape get past (the server never sees a malformed id)
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxied = vi.hoisted(() => ({ calls: [] as Array<{ url: string; path: string }> }));
vi.mock('@/lib/fastapi-proxy', () => ({
  proxyToFastapi: vi.fn(async (request: Request, path: string) => { proxied.calls.push({ url: request.url, path }); return new Response('{}', { status: 200 }); }),
}));

import { GET } from './route';
import { POST as commit } from './commit/route';
import { POST as reveal } from './reveal/route';
import { POST as close } from './close/route';

const OFFER = '0f3c2a1e-1111-4222-8333-944455556666';
const SETUP = '12345678-9abc-4def-8123-456789abcdef';
const params = (offerId: string) => ({ params: Promise.resolve({ offerId }) });
beforeEach(() => { proxied.calls.length = 0; });

describe('[4972] pairing-sessions BFF routes', () => {
  it('GET state → /api/v2/remote-devices/pairing-sessions/{offer}', async () => {
    const r = await GET(new Request(`http://localhost/x?setup_id=${SETUP}`), params(OFFER));
    expect(r.status).toBe(200);
    expect(proxied.calls.at(-1)!.path).toBe(`/api/v2/remote-devices/pairing-sessions/${OFFER}`);
  });
  it('GET with a malformed offer or setup id → 404 offer_not_found (nothing proxied)', async () => {
    for (const [offer, setup] of [['nope', SETUP], [OFFER, 'nope'], [OFFER, '']] as const) {
      const r = await GET(new Request(`http://localhost/x?setup_id=${setup}`), params(offer));
      expect(r.status).toBe(404);
      expect((await r.json()).error.code).toBe('offer_not_found');
    }
    expect(proxied.calls).toEqual([]);
  });
  it.each([[commit, 'commit'], [reveal, 'reveal'], [close, 'close']] as const)('POST %# → /{offer}/%s, and a malformed id is a 404 that proxies nothing', async (handler, step) => {
    const ok = await handler(new Request('http://localhost/x', { method: 'POST', body: '{}' }), params(OFFER));
    expect(ok.status).toBe(200);
    expect(proxied.calls.at(-1)!.path).toBe(`/api/v2/remote-devices/pairing-sessions/${OFFER}/${step}`);
    const before = proxied.calls.length;
    const bad = await handler(new Request('http://localhost/x', { method: 'POST', body: '{}' }), params('../etc/passwd'));
    expect(bad.status).toBe(404);
    expect(proxied.calls.length).toBe(before);
  });
});
