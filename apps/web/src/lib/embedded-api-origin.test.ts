import { afterEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { carryOnToTarget, embeddedApiTarget, isEmbeddedServer } from './embedded-api-origin';

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
