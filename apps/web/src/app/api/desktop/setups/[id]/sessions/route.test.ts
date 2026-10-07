import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ proxy: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxy }));

import { GET } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('/api/desktop/setups/[id]/sessions (4543)', () => {
  beforeEach(() => { h.proxy.mockReset(); h.proxy.mockResolvedValue(new Response('{}', { status: 200 })); });

  it('GET proxies the device sessions read to the backend (the request itself — its ?limit= goes along)', async () => {
    const req = new Request(`http://x/api/desktop/setups/${ID}/sessions?limit=200`);
    await GET(req, params(ID));
    expect(h.proxy).toHaveBeenCalledWith(req, `/api/v2/desktop/setups/${ID}/sessions`);
  });

  it('a malformed id never reaches the backend', async () => {
    const res = await GET(new Request('http://x'), params('../orgs'));
    expect(res.status).toBe(404);
    expect(h.proxy).not.toHaveBeenCalled();
  });
});
