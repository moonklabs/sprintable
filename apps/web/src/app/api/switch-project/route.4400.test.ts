// story #4400 — switching project revokes only this session's refresh token: the BFF sends its sp_rt to the backend.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getServerSessionMock } = vi.hoisted(() => ({ getServerSessionMock: vi.fn() }));
vi.mock('@/lib/db/server', () => ({
  getServerSession: getServerSessionMock,
  SP_AT_COOKIE: 'sp_at',
  SP_RT_COOKIE: 'sp_rt',
}));
const cookieJar = vi.hoisted(() => ({ rt: 'rt-this-session' as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'sp_rt' && cookieJar.rt ? { value: cookieJar.rt } : undefined) }),
}));

import { POST } from './route';

const switchRequest = () => new Request('http://localhost/api/switch-project', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ project_id: 'proj-2' }),
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.unstubAllGlobals();
  getServerSessionMock.mockResolvedValue({ access_token: 'token-1', org_id: 'org-1', project_id: 'proj-1' });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({
    data: { access_token: 'at-2', refresh_token: 'rt-2', token_type: 'bearer' },
  }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

const sentBody = () => JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

describe('[SID:4400] /api/switch-project', () => {
  it('sends this session\'s refresh token with the project', async () => {
    cookieJar.rt = 'rt-this-session';
    const res = await POST(switchRequest());
    expect(res.status).toBe(200);
    expect(sentBody()).toEqual({ project_id: 'proj-2', refresh_token: 'rt-this-session' });
  });

  it('leaves the field out without the cookie (the backend then refuses: 401 — story 4782 took the all-device fallback away)', async () => {
    cookieJar.rt = undefined;
    await POST(switchRequest());
    expect(sentBody()).toEqual({ project_id: 'proj-2' });
  });
});

describe('[SID:4782] /api/switch-project hands the backend\'s refusal of an ended session back as it is', () => {
  it.each(['TOKEN_REVOKED', 'TOKEN_SUPERSEDED'])('401 %s: same status and word, and no cookie is written or cleared here (the client\'s one flight decides: renew or sign out)', async (code) => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { code, message: 'x' } }), { status: 401 }));
    cookieJar.rt = 'rt-this-session';
    const res = await POST(switchRequest());
    expect(res.status).toBe(401);
    expect((await res.json() as { error: { code: string } }).error.code).toBe(code);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
