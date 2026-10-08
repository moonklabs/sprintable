// story #4630 — a password change ends every other session and keeps this one: the BFF sends this browser's refresh token,
// and the new pair the backend hands back goes into this browser's cookies — never into the page.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: vi.fn(async () => ({ id: 'me' })) }));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));
const cookieJar = vi.hoisted(() => ({ rt: 'rt-this-browser' as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'sp_rt' && cookieJar.rt ? { value: cookieJar.rt } : undefined) }),
}));

import { PATCH } from './route';

const req = () => new Request('http://localhost:3000/api/auth/change-password', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', cookie: 'sp_at=at-1; sp_rt=rt-this-browser' },
  body: JSON.stringify({ current_password: 'Old-pass-1', new_password: 'New-pass-1!' }),
});

beforeEach(() => {
  vi.unstubAllGlobals();
  cookieJar.rt = 'rt-this-browser';
});

describe('[SID:4630] /api/auth/change-password', () => {
  it('sends this browser\'s refresh token along with the passwords', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { sessions_ended: 1, kept_this: false } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await PATCH(req());
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ current_password: 'Old-pass-1', new_password: 'New-pass-1!', refresh_token: 'rt-this-browser' });
  });

  it('this session kept: the new pair is set as cookies and left out of the answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { message: 'Password changed successfully', sessions_ended: 2, kept_this: true, access_token: 'at-new', refresh_token: 'rt-new', token_type: 'bearer' },
    }), { status: 200 })));
    const res = await PATCH(req());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toEqual({ message: 'Password changed successfully', sessions_ended: 2, kept_this: true, token_type: 'bearer' });
    expect(res.cookies.get('sp_at')?.value).toBe('at-new');
    expect(res.cookies.get('sp_rt')?.value).toBe('rt-new');
  });

  it('this session not kept: no cookie is touched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { message: 'ok', sessions_ended: 3, kept_this: false } }), { status: 200 })));
    const res = await PATCH(req());
    expect(res.cookies.get('sp_at')).toBeUndefined();
    expect(res.cookies.get('sp_rt')).toBeUndefined();
  });

  it('a wrong current password passes through as the backend said', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'WRONG_PASSWORD', message: 'x' } }), { status: 400 })));
    const res = await PATCH(req());
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('WRONG_PASSWORD');
  });
});
