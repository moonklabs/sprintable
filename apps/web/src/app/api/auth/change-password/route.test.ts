// story #4630 (PO 10:18Z · option (b) after Kadir qa:changes) — a password change ends every session, this one too: the BFF sends
// no refresh token, never hands a new pair to the browser, and clears this browser's session cookies on success.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: vi.fn(async () => ({ id: 'me' })) }));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));

import { PATCH } from './route';

const req = () => new Request('http://localhost:3000/api/auth/change-password', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', cookie: 'sp_at=at-1; sp_rt=rt-this-browser' },
  body: JSON.stringify({ current_password: 'Old-pass-1', new_password: 'New-pass-1!' }),
});

beforeEach(() => { vi.unstubAllGlobals(); });

describe('[SID:4630] /api/auth/change-password', () => {
  it('sends the two passwords only — no refresh token (there is no session to keep)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { message: 'ok', sessions_ended: 2 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await PATCH(req());
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ current_password: 'Old-pass-1', new_password: 'New-pass-1!' });
  });

  it('changed: this browser\'s session cookies are cleared — signed out now, not at its next refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { message: 'ok', sessions_ended: 2 } }), { status: 200 })));
    const res = await PATCH(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { message: 'ok', sessions_ended: 2 } });
    expect(res.cookies.get('sp_at')?.value).toBe('');
    expect(res.cookies.get('sp_rt')?.value).toBe('');
    expect(res.cookies.get('sp_rt')?.maxAge).toBe(0);
  });

  it('a wrong current password passes through and keeps this browser signed in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'WRONG_PASSWORD', message: 'x' } }), { status: 400 })));
    const res = await PATCH(req());
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('WRONG_PASSWORD');
    expect(res.cookies.get('sp_at')).toBeUndefined();
  });
});
