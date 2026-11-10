// story 4891 (codex round on PR «first-run follow-ups») — a public prefix names a page and what is under it, not every path that starts with those letters.
// A reserved workspace slug gets the suffix `-2` (an organization named «login» / «signup» becomes `login-2` / `signup-2`); with a plain `startsWith` its workspace pages were
// public and skipped the session check. Reverting `matchesPublicPrefix` to `startsWith` turns the «protected» cases red; the «public» cases pin that real public pages still pass.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { proxy as middleware, matchesPublicPrefix } from './proxy';

// the public prefix list as the source writes it (the proxy does not export it)
const PROXY_SRC = readFileSync(resolve(__dirname, 'proxy.ts'), 'utf8');
const PUBLIC_PREFIX_NAMES = [...PROXY_SRC.slice(PROXY_SRC.indexOf('const PUBLIC_PREFIX = ['), PROXY_SRC.indexOf('];', PROXY_SRC.indexOf('const PUBLIC_PREFIX = ['))).matchAll(/^\s*'(\/[^']*)',/gm)].map((m) => m[1]);

const req = (path: string) => new NextRequest(`https://app.example.com${path}`);

describe('public prefixes match whole path segments (story 4891)', () => {
  beforeEach(() => { process.env['JWT_SECRET'] = 'test-secret-for-proxy-tests'; process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000'; });
  afterEach(() => { delete process.env['JWT_SECRET']; });

  it('the helper: the page, what is under it, and a «/»-ending prefix by startsWith — never a neighbour that only shares letters', () => {
    expect(matchesPublicPrefix('/login', '/login')).toBe(true);
    expect(PUBLIC_PREFIX_NAMES).not.toContain('/signup'); // /signup is a redirect (next.config.ts) that runs before this proxy; it is not a public prefix
    expect(matchesPublicPrefix('/login/', '/login')).toBe(true);
    expect(matchesPublicPrefix('/invite/abc', '/invite')).toBe(true);
    expect(matchesPublicPrefix('/api/auth/login', '/api/auth/')).toBe(true);
    expect(matchesPublicPrefix('/.well-known/assetlinks.json', '/.well-known/')).toBe(true);
    for (const [path, prefix] of [['/login-2', '/login'], ['/signup-2/p/board', '/signup'], ['/loginx', '/login'], ['/register-2', '/register'], ['/termsx', '/terms']] as const) {
      expect(matchesPublicPrefix(path, prefix), `${path} vs ${prefix}`).toBe(false);
    }
  });

  it('real public pages still pass without a session', async () => {
    for (const path of ['/login', '/login/', '/register', '/forgot-password', '/invite/abc', '/terms', '/api/auth/session', '/.well-known/assetlinks.json']) {
      const response = await middleware(req(path));
      expect(response.status, path).not.toBe(307);
    }
  });

  it('⭐workspace pages of an organization whose slug got the `-2` suffix — or one that was already named `signup` — are NOT public: no session → sent to sign in', async () => {
    for (const path of ['/login-2/proj/board', '/signup-2/proj/board', '/signup/proj/board', '/register-2/proj/flow', '/invite-2/proj/flow', '/terms-2/proj/flow']) {
      const response = await middleware(req(path));
      expect(response.status, path).toBe(307);
      expect(response.headers.get('location') ?? '', path).toContain('/login');
    }
  });
});
