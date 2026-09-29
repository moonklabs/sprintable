import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ proxy: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxy }));

import { DELETE, GET } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('/api/desktop/setups/[id] (4424)', () => {
  beforeEach(() => { h.proxy.mockReset(); h.proxy.mockResolvedValue(new Response('{}', { status: 200 })); });

  it('DELETE proxies the disconnect to the backend', async () => {
    const req = new Request(`http://x/api/desktop/setups/${ID}`, { method: 'DELETE' });
    await DELETE(req, params(ID));
    expect(h.proxy).toHaveBeenCalledWith(req, `/api/v2/desktop/setups/${ID}`);
  });

  it('DELETE with a malformed id never reaches the backend', async () => {
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params('../orgs'));
    expect(res.status).toBe(404);
    expect(h.proxy).not.toHaveBeenCalled();
  });

  it('GET is unchanged', async () => {
    const req = new Request(`http://x/api/desktop/setups/${ID}`);
    await GET(req, params(ID));
    expect(h.proxy).toHaveBeenCalledWith(req, `/api/v2/desktop/setups/${ID}`);
  });
});
