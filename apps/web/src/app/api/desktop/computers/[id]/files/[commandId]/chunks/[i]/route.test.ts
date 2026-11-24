// story 4988 (P8) — the download chunk proxy: a non-UUID or a place that is not plain digits is a 404 and calls nothing; the chunk is asked of exactly /api/v2/desktop/computers/{id}/files/{command}/chunks/{i}, no query goes on, and the answer
// is `no-store`. And the DELETE of the request (the person is done / gives up): the same ids, the same no-store.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import * as chunkRoute from './route';
import { GET } from './route';
import { DELETE } from '../../route';

const COMPUTER = '22222222-3333-4444-8555-666666666666';
const COMMAND = '33333333-4444-4555-8666-777777777777';
const get = (i: string, search = '') => new Request(`http://localhost:3000/api/desktop/computers/${COMPUTER}/files/${COMMAND}/chunks/${i}${search}`);
const del = (search = '') => new Request(`http://localhost:3000/api/desktop/computers/${COMPUTER}/files/${COMMAND}${search}`, { method: 'DELETE' });
const params = (id: string, commandId: string, i: string) => ({ params: Promise.resolve({ id, commandId, i }) });
const params2 = (id: string, commandId: string) => ({ params: Promise.resolve({ id, commandId }) });

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{}', { status: 200 })); });

describe('GET /api/desktop/computers/[id]/files/[commandId]/chunks/[i]', () => {
  it('exports only its HTTP handler (a Next.js app route may export nothing else)', () => {
    expect(Object.keys(chunkRoute)).toEqual(['GET']);
  });

  it('proxies to exactly the chunk of the server, with no query, and says no-store', async () => {
    const res = await GET(get('3', '?x=1&path=/etc'), params(COMPUTER, COMMAND, '3'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/computers/${COMPUTER}/files/${COMMAND}/chunks/3`);
    expect(new URL(req.url).search).toBe('');
    expect(req.method).toBe('GET');
  });

  it('the places of a download (0 … 56) go; the next ones · a signed · padded · fractional · long · empty place is a 404 and calls nothing', async () => {
    for (const ok of ['0', '9', '10', '49', '50', '56']) expect((await GET(get(ok), params(COMPUTER, COMMAND, ok))).status, ok).toBe(200);
    proxy.mockClear();
    for (const bad of ['57', '60', '99', '-1', '01', '1.5', '100', '', '1e2', ' 1', '0x1', 'a']) expect((await GET(get(bad), params(COMPUTER, COMMAND, bad))).status, bad).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('a non-UUID computer or command is a 404 and calls nothing', async () => {
    expect((await GET(get('0'), params('not-a-uuid', COMMAND, '0'))).status).toBe(404);
    expect((await GET(get('0'), params(COMPUTER, '../x', '0'))).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('what the server says (a 404 for every reason · a 409 for a place out of order · a 429) goes through as it is, still no-store', async () => {
    for (const status of [404, 409, 429]) {
      proxy.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'x' } }), { status }));
      const res = await GET(get('1'), params(COMPUTER, COMMAND, '1'));
      expect(res.status).toBe(status);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('DELETE /api/desktop/computers/[id]/files/[commandId]', () => {
  it('proxies a DELETE to exactly the request of the server, with no query, and says no-store', async () => {
    const res = await DELETE(del('?x=1'), params2(COMPUTER, COMMAND));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/computers/${COMPUTER}/files/${COMMAND}`);
    expect(req.method).toBe('DELETE');
    expect(new URL(req.url).search).toBe('');
  });

  it('a non-UUID is a 404 and calls nothing', async () => {
    expect((await DELETE(del(), params2('x', COMMAND))).status).toBe(404);
    expect((await DELETE(del(), params2(COMPUTER, 'x'))).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
});
