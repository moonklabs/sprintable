// story 4825 AC6 — inside the app's own server there is no mail to send: the BFF takes the person's chosen password to the backend's
// `local-set-password` (a signed-in owner sets it on the spot, every session ends) and signs this browser out. Every other deployment keeps the mailed flow.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// whether this server is the app's own is the switch lib/embedded-api-origin.ts reads (its own test pins the exact-value rule); here it is a flag
const embedded = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/embedded-api-origin', () => ({ isEmbeddedServer: () => embedded.on }));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: vi.fn(async () => ({ id: 'me' })) }));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));

import { POST } from './route';

// the app window: same origin as the server it talks to, JSON body
const WINDOW = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' };
// a header given as `undefined` is not sent at all
const req = (headers: Record<string, string | undefined> = {}) => {
  const all: Record<string, string | undefined> = { 'Content-Type': 'application/json', cookie: 'sp_at=at-1; sp_rt=rt-this-browser', ...WINDOW, ...headers };
  return new Request('http://127.0.0.1:3000/api/auth/set-password/request', {
    method: 'POST',
    headers: Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined)),
    body: JSON.stringify({ new_password: 'Aa1!local-owner-pw' }),
  });
};

const urls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => String((c as unknown as [string])[0]));

beforeEach(() => { vi.unstubAllGlobals(); embedded.on = false; });

describe('[SID:4825] /api/auth/set-password/request', () => {
  describe('inside the app\'s own server', () => {
    beforeEach(() => { embedded.on = true; });

    it('goes to local-set-password (never the mailed request), with the session and only the new password', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { message: 'Password set — sign in again' } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await POST(req());
      expect(urls(fetchMock)).toHaveLength(1);
      expect(urls(fetchMock)[0]).toMatch(/\/api\/v2\/auth\/local-set-password$/);
      const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(JSON.parse(String(init.body))).toEqual({ new_password: 'Aa1!local-owner-pw' });
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer at-1');
    });

    it('set: answers {set: true} and signs this browser out (the backend ended every session)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { message: 'Password set — sign in again' } }), { status: 200 })));
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { set: true } });
      expect(res.cookies.get('sp_at')?.value).toBe('');
      expect(res.cookies.get('sp_rt')?.value).toBe('');
      expect(res.cookies.get('sp_rt')?.maxAge).toBe(0);
    });

    it('a refusal passes through with its code and keeps this browser signed in', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'ALREADY_HAS_PASSWORD', message: 'x' } }), { status: 400 })));
      const res = await POST(req());
      expect(res.status).toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('ALREADY_HAS_PASSWORD');
      expect(res.cookies.get('sp_at')).toBeUndefined();
      expect(res.cookies.get('sp_rt')).toBeUndefined();
    });
  });

  describe('who may ask, inside the app\'s own server (the window\'s cookies are shared by every port on 127.0.0.1)', () => {
    beforeEach(() => { embedded.on = true; });
    const okFetch = () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { message: 'ok' } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };

    it('a page served from another port on this machine is refused — the backend is never asked', async () => {
      const fetchMock = okFetch();
      const res = await POST(req({ origin: 'http://127.0.0.1:4000', 'sec-fetch-site': 'same-site', 'Content-Type': 'text/plain' }));
      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('another site is refused', async () => {
      const fetchMock = okFetch();
      const res = await POST(req({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }));
      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the Origin alone refuses (no Sec-Fetch-Site sent, JSON body): another port, another site, or the right port on another host name', async () => {
      const fetchMock = okFetch();
      for (const origin of ['http://127.0.0.1:4000', 'https://evil.example', 'http://localhost:3000']) {
        const res = await POST(req({ origin, 'sec-fetch-site': '' }));
        expect(res.status, origin).toBe(403);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no Origin sent: the Referer decides — a page from another port is refused', async () => {
      const fetchMock = okFetch();
      const res = await POST(req({ origin: undefined, 'sec-fetch-site': undefined, referer: 'http://127.0.0.1:4000/page' }));
      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a request that says it is not same-origin is refused even when its Origin looks right', async () => {
      const fetchMock = okFetch();
      const res = await POST(req({ 'sec-fetch-site': 'same-site' }));
      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a body that is not JSON (what a cross-origin form can send) is refused with 415', async () => {
      const fetchMock = okFetch();
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
        const res = await POST(req({ 'Content-Type': type }));
        expect(res.status, type).toBe(415);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the app window (same origin, JSON — with or without a charset) is served', async () => {
      const fetchMock = okFetch();
      expect((await POST(req())).status).toBe(200);
      expect((await POST(req({ 'Content-Type': 'application/json; charset=utf-8' }))).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('any other deployment', () => {
    it('is not judged by the embedded rules: a request the embedded branch would refuse goes on to the mailed flow as before', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { delivered: true } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const res = await POST(req({ 'sec-fetch-site': 'same-site', 'Content-Type': 'text/plain' }));
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the mailed flow: the request goes to set-password/request, the answer is the backend\'s, no cookie is touched', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { delivered: true } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const res = await POST(req());
      expect(urls(fetchMock)).toHaveLength(1);
      expect(urls(fetchMock)[0]).toMatch(/\/api\/v2\/auth\/set-password\/request$/);
      expect(await res.json()).toEqual({ data: { delivered: true } });
      expect(res.cookies.get('sp_at')).toBeUndefined();
    });
  });
});
