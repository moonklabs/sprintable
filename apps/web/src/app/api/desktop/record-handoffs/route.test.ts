// story 4978 (C1b-phone) — the record handoff proxies: the phone's list (GET), «received» (POST) and the phone's put (PUT). Each closes its own words (nothing else goes on), refuses what is not a uuid / not one word / a body of another shape before
// calling the server, never carries a query it did not agree to, and answers `no-store` (the bodies hold sealed keys).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import * as listRoute from './route';
import { GET } from './route';
import * as receivedRoute from './[id]/received/route';
import { POST } from './[id]/received/route';
import * as putRoute from '../setups/[id]/record-handoffs/[phoneKeyId]/route';
import { PUT } from '../setups/[id]/record-handoffs/[phoneKeyId]/route';

const PHONE = '22222222-3333-4444-8555-666666666666';
const ROW = '33333333-4444-4555-8666-777777777777';
const SETUP = '44444444-5555-4666-8777-888888888888';
const list = (search: string) => new Request(`http://localhost:3000/api/desktop/record-handoffs${search}`);
const received = (search: string) => new Request(`http://localhost:3000/api/desktop/record-handoffs/${ROW}/received${search}`, { method: 'POST' });
const put = (body: unknown, extra: Record<string, string> = {}) => { const text = typeof body === 'string' ? body : JSON.stringify(body); return new Request(`http://localhost:3000/api/desktop/setups/${SETUP}/record-handoffs/${PHONE}?x=1`, { method: 'PUT', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...extra }, body: text }); };
const rowParams = (id: string) => ({ params: Promise.resolve({ id }) });
const putParams = (id: string, phoneKeyId: string) => ({ params: Promise.resolve({ id, phoneKeyId }) });

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{}', { status: 200 })); });

describe('the record handoff proxies', () => {
  it('each exports only its HTTP handler', () => {
    expect(Object.keys(listRoute)).toEqual(['GET']); expect(Object.keys(receivedRoute)).toEqual(['POST']); expect(Object.keys(putRoute)).toEqual(['PUT']);
  });

  it('GET: proxies to /api/v2/desktop/record-handoffs with the ONE agreed word; no-store', async () => {
    const res = await GET(list(`?phone_key_id=${PHONE}`));
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe('/api/v2/desktop/record-handoffs'); expect(new URL(req.url).search).toBe(`?phone_key_id=${PHONE}`); expect(req.method).toBe('GET');
  });
  it('GET: a missing / malformed / repeated / extra word is 422 and calls nothing', async () => {
    for (const s of ['', '?phone_key_id=x', `?phone_key_id=${PHONE}&phone_key_id=${PHONE}`, `?phone_key_id=${PHONE}&limit=5`, `?phone_key_id=${PHONE}&after=1`, '?other=1']) {
      const res = await GET(list(s)); expect(res.status, s).toBe(422);
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('POST received: proxies to /…/{id}/received with only the phone word; a non-uuid id is 404; a bad / repeated / extra word is 422; no body goes on', async () => {
    const res = await POST(received(`?phone_key_id=${PHONE}`), rowParams(ROW));
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/record-handoffs/${ROW}/received`); expect(new URL(req.url).search).toBe(`?phone_key_id=${PHONE}`); expect(req.method).toBe('POST'); expect(req.body).toBeNull();
    proxy.mockClear();
    expect((await POST(received(`?phone_key_id=${PHONE}`), rowParams('x'))).status).toBe(404);
    for (const s of ['', '?phone_key_id=x', `?phone_key_id=${PHONE}&phone_key_id=${PHONE}`, `?phone_key_id=${PHONE}&force=1`]) expect((await POST(received(s), rowParams(ROW))).status, s).toBe(422);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('PUT: forwards exactly {envelope} to /…/setups/{id}/record-handoffs/{phone}, with no query; no-store', async () => {
    const env = { v: 1, kind: 'record_handoff', ct: 'abc' };
    const res = await PUT(put({ envelope: env, history: 'open', extra: 1 }), putParams(SETUP, PHONE));
    expect(res.status).toBe(422); // (a field beyond the one agreed is refused — the shell's envelope is all that rides)
    const ok = await PUT(put({ envelope: env }), putParams(SETUP, PHONE));
    expect(ok.status).toBe(200); expect(ok.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/setups/${SETUP}/record-handoffs/${PHONE}`); expect(await req.json()).toEqual({ envelope: env }); expect(new URL(req.url).search).toBe(''); expect(req.method).toBe('PUT');
  });
  it('PUT: a non-uuid id is 404; no declared length 411; over the server\'s bound 413 (before the body is read); a body that is not {envelope: object} is 422 — none calls the server', async () => {
    expect((await PUT(put({ envelope: {} }), putParams('x', PHONE))).status).toBe(404); expect((await PUT(put({ envelope: {} }), putParams(SETUP, 'x'))).status).toBe(404);
    const noLen = new Request(`http://localhost:3000/x`, { method: 'PUT', body: JSON.stringify({ envelope: {} }) }); noLen.headers.delete('content-length');
    expect((await PUT(noLen, putParams(SETUP, PHONE))).status).toBe(411);
    expect((await PUT(put({ envelope: { ct: 'x'.repeat(33 * 1024) } }), putParams(SETUP, PHONE))).status).toBe(413);
    for (const bad of ['not json', '[]', '{}', '{"envelope":5}', '{"envelope":null}', '{"envelope":[]}', '{"envelope":{},"history":"open"}', '"x"']) expect((await PUT(put(bad), putParams(SETUP, PHONE))).status, bad).toBe(422);
    expect(proxy).not.toHaveBeenCalled();
  });
});
