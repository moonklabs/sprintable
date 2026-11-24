// story 4977 (B3-2b) — the records proxies: a non-UUID computer is a 404 and calls nothing; the query is closed to the agreed words in their shapes; both answers are `no-store`.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import * as route from './route';
import { GET } from './route';
import * as deleteRoute from '../../../records/route';
import { DELETE } from '../../../records/route';

const COMPUTER = '22222222-3333-4444-8555-666666666666';
const PHONE = '33333333-4444-4555-8666-777777777777';
const ROOM = '44444444-5555-4666-8777-888888888888';
const get = (search: string) => new Request(`http://localhost:3000/api/desktop/computers/${COMPUTER}/records${search}`);
const del = (search: string) => new Request(`http://localhost:3000/api/desktop/records${search}`, { method: 'DELETE' });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{"records":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } })); });

describe('GET /api/desktop/computers/[id]/records', () => {
  it('exports only its HTTP handler (a Next.js app route may export nothing else)', () => {
    expect(Object.keys(route)).toEqual(['GET']);
    expect(Object.keys(deleteRoute)).toEqual(['DELETE']);
  });

  it('proxies to exactly /api/v2/desktop/computers/{id}/records with ONLY the four agreed words, and says no-store', async () => {
    const res = await GET(get(`?phone_key_id=${PHONE}&conversation_id=${ROOM}&after=41&limit=50&x=1&path=/etc`), params(COMPUTER));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ records: [] });
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/computers/${COMPUTER}/records`);
    const q = new URL(req.url).searchParams;
    expect([...q.keys()].sort()).toEqual(['after', 'conversation_id', 'limit', 'phone_key_id']);
    expect(q.get('after')).toBe('41'); expect(q.get('limit')).toBe('50'); expect(q.get('phone_key_id')).toBe(PHONE); expect(q.get('conversation_id')).toBe(ROOM);
    expect(req.method).toBe('GET');
  });

  it('after and limit are optional; the two ids are not', async () => {
    expect((await GET(get(`?phone_key_id=${PHONE}&conversation_id=${ROOM}`), params(COMPUTER))).status).toBe(200);
    expect([...new URL((proxy.mock.calls[0] as [Request, string])[0].url).searchParams.keys()].sort()).toEqual(['conversation_id', 'phone_key_id']);
    for (const bad of ['', `?conversation_id=${ROOM}`, `?phone_key_id=${PHONE}`, `?phone_key_id=nope&conversation_id=${ROOM}`, `?phone_key_id=${PHONE}&conversation_id=nope`, `?phone_key_id=${PHONE}&conversation_id=${ROOM}&after=-1`, `?phone_key_id=${PHONE}&conversation_id=${ROOM}&after=1.5`, `?phone_key_id=${PHONE}&conversation_id=${ROOM}&after=${'9'.repeat(16)}`,
      `?phone_key_id=${PHONE}&conversation_id=${ROOM}&limit=0`, `?phone_key_id=${PHONE}&conversation_id=${ROOM}&limit=101`, `?phone_key_id=${PHONE}&conversation_id=${ROOM}&limit=x`]) {
      proxy.mockClear();
      const res = await GET(get(bad), params(COMPUTER));
      expect(res.status, bad).toBe(422);
      expect(proxy, bad).not.toHaveBeenCalled();
    }
  });

  it('a word given twice is an ambiguous ask: 422, nothing is called (never the first quietly)', async () => {
    const other = '55555555-6666-4777-8888-999999999999';
    for (const dup of [`&conversation_id=${other}`, `&phone_key_id=${other}`, '&after=1&after=2', '&limit=5&limit=6']) {
      proxy.mockClear();
      const res = await GET(get(`?phone_key_id=${PHONE}&conversation_id=${ROOM}${dup}`), params(COMPUTER));
      expect(res.status, dup).toBe(422);
      expect(proxy, dup).not.toHaveBeenCalled();
    }
  });

  it('a computer id that is not a UUID is 404 and calls nothing', async () => {
    expect((await GET(get(`?phone_key_id=${PHONE}&conversation_id=${ROOM}`), params('../etc'))).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('the server\'s refusal passes through unchanged (and is not cached either)', async () => {
    proxy.mockImplementation(async () => new Response('{"error":{"code":"phone_not_paired"}}', { status: 409 }));
    const res = await GET(get(`?phone_key_id=${PHONE}&conversation_id=${ROOM}`), params(COMPUTER));
    expect(res.status).toBe(409); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: { code: 'phone_not_paired' } });
  });
});

describe('DELETE /api/desktop/records', () => {
  it('proxies to /api/v2/desktop/records with only the two agreed words, and says no-store', async () => {
    proxy.mockImplementation(async () => new Response('{"deleted":2}', { status: 200 }));
    const res = await DELETE(del(`?conversation_id=${ROOM}&record_id=abc_DEF-1&x=1`));
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe('/api/v2/desktop/records'); expect(req.method).toBe('DELETE');
    expect([...new URL(req.url).searchParams.keys()].sort()).toEqual(['conversation_id', 'record_id']);
  });

  it('a word given twice is 422 and calls nothing', async () => {
    for (const dup of [`?conversation_id=${ROOM}&conversation_id=${ROOM}`, `?conversation_id=${ROOM}&record_id=a&record_id=b`]) {
      proxy.mockClear();
      expect((await DELETE(del(dup))).status, dup).toBe(422);
      expect(proxy, dup).not.toHaveBeenCalled();
    }
  });

  it('the record id is optional (all of the room); anything malformed is 422 and calls nothing', async () => {
    expect((await DELETE(del(`?conversation_id=${ROOM}`))).status).toBe(200);
    expect([...new URL((proxy.mock.calls[0] as [Request, string])[0].url).searchParams.keys()]).toEqual(['conversation_id']);
    for (const bad of ['', '?conversation_id=nope', `?conversation_id=${ROOM}&record_id=`, `?conversation_id=${ROOM}&record_id=a%20b`, `?conversation_id=${ROOM}&record_id=a%0Ab`, `?conversation_id=${ROOM}&record_id=${'a'.repeat(129)}`, `?conversation_id=${ROOM}&record_id=../x`]) {
      proxy.mockClear();
      const res = await DELETE(del(bad));
      expect(res.status, bad).toBe(422);
      expect(proxy, bad).not.toHaveBeenCalled();
    }
  });
});
