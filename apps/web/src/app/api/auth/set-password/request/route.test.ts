// story 4825 AC6 — inside the app's own server there is no mail to send: the BFF takes the person's chosen password to the backend's
// `local-set-password` (a signed-in owner sets it on the spot, every session ends) and signs this browser out. Every other deployment keeps the mailed flow.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// whether this server is the app's own is the switch lib/embedded-api-origin.ts reads (its own test pins the exact-value rule); here it is a flag
const embedded = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/embedded-api-origin', () => ({ isEmbeddedServer: () => embedded.on }));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: vi.fn(async () => ({ id: 'me' })) }));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));

import { POST } from './route';

const req = () => new Request('http://127.0.0.1:3000/api/auth/set-password/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie: 'sp_at=at-1; sp_rt=rt-this-browser' },
  body: JSON.stringify({ new_password: 'Aa1!local-owner-pw' }),
});

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

  describe('any other deployment', () => {
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
