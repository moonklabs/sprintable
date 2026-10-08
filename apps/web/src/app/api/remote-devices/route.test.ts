// story #4629 (PO 09:02Z: A2) — the phone's registration carries this session's refresh token from the cookie (the switch-org way),
// so removing the key can end that phone's login later. The phone never names a session: a body value is replaced or dropped.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/server', () => ({ SP_RT_COOKIE: 'sp_rt' }));
const jar = vi.hoisted(() => ({ rt: 'rt-this-session' as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'sp_rt' && jar.rt ? { value: jar.rt } : undefined) }),
}));
const proxied = vi.hoisted(() => ({ requests: [] as Request[] }));
vi.mock('@/lib/fastapi-proxy', () => ({
  proxyToFastapi: vi.fn(async (request: Request) => { proxied.requests.push(request); return new Response('{}', { status: 201 }); }),
}));

import { POST } from './route';

const post = (body: unknown) => new Request('http://localhost/api/remote-devices', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer at' }, body: JSON.stringify(body),
});
const forwardedBody = async () => JSON.parse(await proxied.requests.at(-1)!.text()) as Record<string, unknown>;

beforeEach(() => { proxied.requests.length = 0; jar.rt = 'rt-this-session'; });

describe('[4629] POST /api/remote-devices — this session\'s refresh token rides along', () => {
  it('adds the cookie\'s refresh token to the phone\'s {label, public_key} · the headers go on (auth)', async () => {
    await POST(post({ label: '폰', public_key: 'pk' }));
    expect(await forwardedBody()).toEqual({ label: '폰', public_key: 'pk', refresh_token: 'rt-this-session' });
    expect(proxied.requests.at(-1)!.headers.get('authorization')).toBe('Bearer at');
  });

  it('a refresh_token in the body is never the caller\'s: replaced by the cookie\'s, or dropped when there is none', async () => {
    await POST(post({ label: '폰', public_key: 'pk', refresh_token: 'someone-elses' }));
    expect((await forwardedBody()).refresh_token).toBe('rt-this-session');
    jar.rt = undefined;
    await POST(post({ label: '폰', public_key: 'pk', refresh_token: 'someone-elses' }));
    expect(await forwardedBody()).toEqual({ label: '폰', public_key: 'pk' });
  });

  it('no session cookie: the body as it came (the backend records no session — removing the key later ends none)', async () => {
    jar.rt = undefined;
    await POST(post({ label: '폰', public_key: 'pk' }));
    expect(await forwardedBody()).toEqual({ label: '폰', public_key: 'pk' });
  });
});
