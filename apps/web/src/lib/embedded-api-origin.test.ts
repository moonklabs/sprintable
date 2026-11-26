import { afterEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { carryOnToTarget, embeddedApiTarget, embeddedHostRefusal, isEmbeddedServer, isLocalModeServer, isServerHost, publicHostOf, serverHostOrigin } from './embedded-api-origin';

const ENV_KEYS = ['SPRINTABLE_EMBEDDED', 'NEXT_PUBLIC_FASTAPI_URL'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('story 4824 — the app\'s own server forwards /api/v2 at request time', () => {
  it('is off unless the app says so (SPRINTABLE_EMBEDDED=1) — every other server keeps the config rewrite', () => {
    delete process.env['SPRINTABLE_EMBEDDED'];
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://127.0.0.1:41234';
    expect(isEmbeddedServer()).toBe(false);
    expect(embeddedApiTarget('/api/v2/me', '')).toBeNull();
    process.env['SPRINTABLE_EMBEDDED'] = '0';
    expect(embeddedApiTarget('/api/v2/me', '')).toBeNull();
    process.env['SPRINTABLE_EMBEDDED'] = 'true';
    expect(isEmbeddedServer()).toBe(false); // exactly "1"
  });

  it('forwards /api/v2/* — path and query — to the address read AT REQUEST TIME (a different port on the next call, no rebuild)', () => {
    process.env['SPRINTABLE_EMBEDDED'] = '1';
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://127.0.0.1:41234';
    expect(embeddedApiTarget('/api/v2/stories', '?project_id=a&limit=5')?.toString()).toBe('http://127.0.0.1:41234/api/v2/stories?project_id=a&limit=5');
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://127.0.0.1:52999';
    expect(embeddedApiTarget('/api/v2/stories', '')?.toString()).toBe('http://127.0.0.1:52999/api/v2/stories');
  });

  it('any letter case of the prefix is the same route for Next — and the backend gets the canonical lower-case path', () => {
    process.env['SPRINTABLE_EMBEDDED'] = '1';
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://127.0.0.1:41234';
    for (const p of ['/API/V2/stories', '/Api/v2/stories', '/api/V2/stories', '/API/v2/stories']) {
      expect(embeddedApiTarget(p, '?a=1')?.toString(), p).toBe('http://127.0.0.1:41234/api/v2/stories?a=1');
    }
  });

  it('only /api/v2/* — the web\'s own /api/* routes and pages stay where they are', () => {
    process.env['SPRINTABLE_EMBEDDED'] = '1';
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://127.0.0.1:41234';
    for (const p of ['/api/auth/login', '/api/v2', '/api/v20/x', '/login', '/', '/_next/static/x.js', '/api/switch-org']) {
      expect(embeddedApiTarget(p, '')).toBeNull();
    }
  });

  it('an unusable backend address does not crash the proxy', () => {
    process.env['SPRINTABLE_EMBEDDED'] = '1';
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'not a url';
    expect(embeddedApiTarget('/api/v2/me', '')).toBeNull();
  });

  describe('carryOnToTarget', () => {
    const target = new URL('http://127.0.0.1:41234/api/v2/me');

    it('pins the two Next.js header names it relies on (an upgrade that renames them fails here, not silently in the app)', () => {
      expect(NextResponse.next().headers.get('x-middleware-next')).toBe('1');
      expect(NextResponse.rewrite(target).headers.get('x-middleware-rewrite')).toBe(target.toString());
    });

    it('«carry on» becomes «carry on to the backend»; the headers and every cookie the proxy set travel with it', () => {
      const next = NextResponse.next({ request: { headers: new Headers({ 'x-resolved-org-id': 'org-1' }) } });
      next.headers.append('set-cookie', 'sp_at=new; Path=/; HttpOnly');
      next.headers.append('set-cookie', 'sp_rt=newer; Path=/; HttpOnly');
      next.headers.set('x-custom', 'kept');
      const out = carryOnToTarget(next, target);
      expect(out.headers.get('x-middleware-rewrite')).toBe(target.toString());
      expect(out.headers.get('x-middleware-next')).toBeNull();
      expect(out.headers.get('x-custom')).toBe('kept');
      expect(out.headers.getSetCookie()).toEqual(['sp_at=new; Path=/; HttpOnly', 'sp_rt=newer; Path=/; HttpOnly']);
      expect(out.headers.get('x-middleware-override-headers')).toBe(next.headers.get('x-middleware-override-headers'));
      expect(out.headers.get('x-middleware-request-x-resolved-org-id')).toBe('org-1');
    });

    it('a redirect or an error answer is returned untouched', () => {
      const redirect = NextResponse.redirect('https://app.example.com/login');
      expect(carryOnToTarget(redirect, target)).toBe(redirect);
      const denied = new NextResponse('{}', { status: 403 });
      expect(carryOnToTarget(denied, target)).toBe(denied);
    });
  });
});


// ── story 5022 (b) — the public name of a server host ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('story 5022 (b) — embeddedHostRefusal knows the public name of a server host', () => {
  const req = (host: string) => new NextRequest('http://127.0.0.1:3000/x', { headers: { host } });
  const env = (o: Record<string, string>) => ({ ...o }) as NodeJS.ProcessEnv;
  it('loopback as before; the public Host (any letter case) when SPRINTABLE_PUBLIC_ORIGIN is usable; every other Host a 400; a server that is not the app\'s is untouched', () => {
    const e = env({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' });
    expect(embeddedHostRefusal(req('127.0.0.1:41000'), e)).toBeNull();
    expect(embeddedHostRefusal(req('team.example.com'), e)).toBeNull();
    expect(embeddedHostRefusal(req('Team.Example.COM'), e)).toBeNull();
    for (const h of ['evil.example.com', 'team.example.com:8443', 'team.example.com.', 'localhost:3000', '']) expect(embeddedHostRefusal(req(h), e)?.status, h).toBe(400);
    expect(embeddedHostRefusal(req('team.example.com'), env({ SPRINTABLE_EMBEDDED: '1' }))?.status).toBe(400);
    expect(embeddedHostRefusal(req('team.example.com'), env({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: 'http://team.example.com' }))?.status).toBe(400);
    expect(embeddedHostRefusal(req('anything.example'), env({ SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' }))).toBeNull(); // not embedded: no rule at all
  });
  it('the THREE readers of the public origin (the door, the relay, this file) answer every spelling alike', () => {
    const require_ = createRequire(import.meta.url);
    const door = require_('../../embedded-host-guard.cjs') as { publicHostOf: (e: Record<string, string | undefined>) => string | null };
    const relay = require_('../../embedded-api-relay.cjs') as { publicHostOf: (e: Record<string, string | undefined>) => string | null };
    const table = ['https://team.example.com', 'https://team.example.com:8443', 'https://team.example.com:443', 'https://Team.example.com', 'http://team.example.com', 'https://10.0.0.5', 'https://0x7f.1', 'https://127.1', 'https://localhost', 'https://a.localhost', 'https://team',
      'https://team.example.com/', 'https://u@team.example.com', 'https://team.example.com:65536', 'https://team.example.com:0', 'https://xn--hxajbheg2az3al.example', 'https://x0.example.com', 'https://a.0x', '', 'nonsense', `https://${'a'.repeat(64)}.example.com`];
    for (const v of table) {
      const e = { SPRINTABLE_PUBLIC_ORIGIN: v };
      expect(publicHostOf(e as unknown as NodeJS.ProcessEnv), JSON.stringify(v)).toBe(door.publicHostOf(e));
      expect(relay.publicHostOf(e), JSON.stringify(v)).toBe(door.publicHostOf(e));
    }
    expect(publicHostOf({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('story 5022 (b) — isServerHost: the one name for «this is the server host\'s web», read by 5024 and the 5023 screens', () => {
  const e = (o: Record<string, string>) => ({ ...o }) as NodeJS.ProcessEnv;
  it('embedded AND a usable public origin; the desktop app\'s server (no public address), a hosted deployment (not embedded) and an unusable value are not', () => {
    expect(isServerHost(e({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' }))).toBe(true);
    expect(isServerHost(e({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com:8443' }))).toBe(true);
    expect(isServerHost(e({ SPRINTABLE_EMBEDDED: '1' }))).toBe(false);
    expect(isServerHost(e({ SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' }))).toBe(false);
    expect(isServerHost(e({ SPRINTABLE_EMBEDDED: 'true', SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' }))).toBe(false);
    for (const bad of ['http://team.example.com', 'https://10.0.0.5', 'https://localhost', 'https://team', '']) expect(isServerHost(e({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: bad })), bad).toBe(false);
  });
});

describe('story 5024 (AC4) — serverHostOrigin: the address a person gives `sprintable-host pair --server`, from the server\'s own setting', () => {
  const e = (o: Record<string, string>) => ({ ...o }) as NodeJS.ProcessEnv;
  it('the https address of a server host — with its port when it has one, never an explicit :443 — and null for everything that is not a server host', () => {
    expect(serverHostOrigin(e({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' }))).toBe('https://team.example.com');
    expect(serverHostOrigin(e({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com:8443' }))).toBe('https://team.example.com:8443');
    expect(serverHostOrigin(e({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com:443' }))).toBeNull();
    expect(serverHostOrigin(e({ SPRINTABLE_EMBEDDED: '1' }))).toBeNull(); // the desktop app's own server: no public address
    expect(serverHostOrigin(e({ SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' }))).toBeNull(); // not embedded: a hosted deployment
    for (const bad of ['http://team.example.com', 'https://10.0.0.5', 'https://localhost', 'https://team', 'https://team.example.com/path', '']) {
      expect(serverHostOrigin(e({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: bad })), bad).toBeNull();
    }
  });
  it('is non-null exactly when isServerHost is true (one rule, two names)', () => {
    const envs: Array<Record<string, string>> = [{ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: 'https://a.example.com' }, { SPRINTABLE_EMBEDDED: '1' }, { SPRINTABLE_PUBLIC_ORIGIN: 'https://a.example.com' }, {}];
    for (const env of envs) {
      expect(serverHostOrigin(e(env)) !== null, JSON.stringify(env)).toBe(isServerHost(e(env)));
    }
  });
});

describe('story 5025 — LOCAL MODE is the app\'s own loopback server, not a workspace server host', () => {
  const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;
  it('embedded + no public address = local mode; embedded + a valid public address = a server host, NOT local mode', () => {
    expect(isLocalModeServer(env({ SPRINTABLE_EMBEDDED: '1' }))).toBe(true);
    expect(isLocalModeServer(env({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' }))).toBe(false);
  });
  it('an invalid public address does not make a server host (still local mode); not embedded is never local mode', () => {
    for (const origin of ['', 'http://team.example.com', 'https://localhost', 'https://team.example.com/path', 'team.example.com']) {
      expect(isLocalModeServer(env({ SPRINTABLE_EMBEDDED: '1', SPRINTABLE_PUBLIC_ORIGIN: origin })), origin).toBe(true);
    }
    expect(isLocalModeServer(env({}))).toBe(false);
    expect(isLocalModeServer(env({ SPRINTABLE_PUBLIC_ORIGIN: 'https://team.example.com' }))).toBe(false);
    expect(isLocalModeServer(env({ SPRINTABLE_EMBEDDED: '0' }))).toBe(false);
  });
  it('is exactly «embedded && !isServerHost» for every combination (the siblings spell it out; this is the one name)', () => {
    for (const e of [undefined, '0', '1']) for (const o of [undefined, 'https://team.example.com', 'http://x']) {
      const v = env({ SPRINTABLE_EMBEDDED: e, SPRINTABLE_PUBLIC_ORIGIN: o });
      expect(isLocalModeServer(v), `${String(e)} ${String(o)}`).toBe(isEmbeddedServer(v) && !isServerHost(v));
    }
  });
});
