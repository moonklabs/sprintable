// story #4628 (AC2) — the whole way through one browser's cookie jar: a native sign-in start left unfinished, then a web
// sign-in start, then the provider's callback. Before: the callback found the abandoned start's native challenge and went the
// native way (a handoff code, no web session) and carried its `next` and invite token. Now the web start drops what it does not carry.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  })),
}));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));
vi.mock('@/services/app-url', () => ({ resolveAppUrl: () => 'http://localhost:3108' }));

const calls: { url: string; body: unknown }[] = [];
const mockFetch = vi.fn(async (...args: unknown[]) => {
  const url = String(args[0]);
  const init = args[1] as RequestInit | undefined;
  calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.includes('/authorize')) return { ok: true, json: async () => ({ data: { url: 'https://accounts.google.com/o/oauth2/auth', state: 'st' } }) };
  if (url.includes('/api/v2/auth/oauth/callback')) return { ok: true, json: async () => ({ data: { access_token: fakeJwt({ sub: 'user-b' }), refresh_token: 'rt-b' } }) };
  if (url.includes('/oauth-handoff/issue')) return { ok: true, json: async () => ({ code: 'handoff-code' }) };
  return { ok: false, json: async () => ({}) };
});
vi.stubGlobal('fetch', stubFetch(mockFetch));

import { GET as loginStart } from './route';
import { GET as callback } from '@/app/api/auth/callback/[provider]/route';
import { stubFetch } from '@/test-utils/as-fetch-response';

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}
const url = (path: string, q: Record<string, string>) => {
  const u = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return new Request(u.toString());
};

describe('[4628] an abandoned native start, then a web sign-in in the same browser', () => {
  beforeEach(() => { jar.clear(); calls.length = 0; });

  it('the web sign-in gets its web session — not the native handoff — and none of the old start\'s next or invite token', async () => {
    // A starts a native sign-in from an invite and never comes back (the cookies live 5 minutes)
    await loginStart(url('/auth/login', { provider: 'google', native: '1', code_challenge: 'a'.repeat(43), callback_mode: 'custom_scheme', next: '/old-place', invite_token: 'inv-a' }));
    expect(jar.get('oauth_native_challenge_google')).toBe('a'.repeat(43));
    // B, same browser, a plain web sign-in
    await loginStart(url('/auth/login', { provider: 'google' }));
    for (const n of ['oauth_native_challenge', 'oauth_native_callback_mode', 'oauth_next', 'oauth_invite_token', 'oauth_tos']) expect(jar.has(`${n}_google`), n).toBe(false);

    const res = await callback(url('/api/auth/callback/google', { code: 'c', state: 'st' }), { params: Promise.resolve({ provider: 'google' }) });
    expect(res.headers.get('location')).not.toContain('/native/oauth-return');
    expect(res.cookies.get('sp_at')?.value, 'the web session is set').toBeTruthy();
    expect(calls.some((c) => c.url.includes('/oauth-handoff/issue')), 'no native handoff').toBe(false);
    const be = calls.find((c) => c.url.includes('/api/v2/auth/oauth/callback'))!.body as { invite_token: unknown };
    expect(be.invite_token, 'A\'s invite token is not sent with B\'s sign-in').toBeNull();
    expect(new URL(res.headers.get('location')!).pathname).not.toBe('/old-place');
  });

  it('control: the native start itself, finished, still goes the native way (nothing of this change in its path)', async () => {
    await loginStart(url('/auth/login', { provider: 'google', native: '1', code_challenge: 'a'.repeat(43), callback_mode: 'custom_scheme' }));
    const res = await callback(url('/api/auth/callback/google', { code: 'c', state: 'st' }), { params: Promise.resolve({ provider: 'google' }) });
    expect(res.headers.get('location')).toContain('/native/oauth-return?code=handoff-code');
  });
});
