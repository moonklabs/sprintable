import { NextResponse, type NextRequest } from 'next/server';
import { fastapiBaseUrl } from '@/lib/fastapi-url';

/**
 * story 4824 — the desktop app carries the server and picks its ports at launch. `next.config.ts` `rewrites()` forwards `/api/v2/*` to the backend, but it
 * runs at BUILD time: the destination (and so the backend's port) would be baked into the web build. In the app's own server (`SPRINTABLE_EMBEDDED=1`, set by
 * the app) the forward is done here at request time instead, to the address the app put in `SPRINTABLE_API_ORIGIN` (see lib/fastapi-url.ts — a `NEXT_PUBLIC_*`
 * name would be replaced by its build-time value). Everything else in the proxy (session refresh, cookies, headers) has already run by then; this only changes WHERE the request goes.
 * Any other deployment (cloud, the plain dev server) has no such switch and keeps the config rewrite as before.
 */
export const EMBEDDED_API_PREFIX = '/api/v2/';

export function isEmbeddedServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SPRINTABLE_EMBEDDED'] === '1';
}

const LOOPBACK_HOST = /^127\.0\.0\.1(?::\d{1,5})?$/;

/**
 * story 4825 (lens AC5, DNS rebinding) — inside the app's own server a request that goes THROUGH THIS PROXY is served ONLY under the loopback host name: a page that
 * rebinds its own DNS name to 127.0.0.1 reaches the web port with `Host: its-name`, and the `/api/v2/*` forward below would then hand the request to the
 * backend with the backend's own Host (the forward re-addresses the request), so the backend's own host check would never see the foreign name. The browser sets
 * `Host` and a page cannot change it — unlike `X-Forwarded-Host`, which a page CAN send, so no forwarded header is looked at. A missing Host is refused too.
 * What this does NOT cover: Next answers some requests before the proxy ever runs (the middleware matcher leaves out static files and any path ending in a static-asset
 * extension, in whatever spelling; redirects and routing normalisation come first). The check at the web server's ENTRANCE, before any routing, is story 4824 AC7.
 * `null` = serve; otherwise the 400 to answer with. Any other deployment (no switch) is untouched.
 */
export function embeddedHostRefusal(request: NextRequest, env: NodeJS.ProcessEnv = process.env): NextResponse | null {
  if (!isEmbeddedServer(env)) return null;
  if (LOOPBACK_HOST.test(request.headers.get('host') ?? '')) return null;
  return new NextResponse('Invalid host header', { status: 400 });
}

/** where `/api/v2/...` goes at request time inside the app's own server — or null when this server is not that (or the path is not an API path) */
export function embeddedApiTarget(pathname: string, search: string, env: NodeJS.ProcessEnv = process.env): URL | null {
  if (!isEmbeddedServer(env) || !pathname.toLowerCase().startsWith(EMBEDDED_API_PREFIX)) return null; // any letter case: `/API/V2/…` is the same route for Next
  try {
    return new URL(`${EMBEDDED_API_PREFIX}${pathname.slice(EMBEDDED_API_PREFIX.length)}${search}`, fastapiBaseUrl()); // the backend sees the canonical lower-case prefix
  } catch {
    return null; // an unusable address is left to the config rewrite's own failure rather than a crash here
  }
}

/**
 * A proxy answer that means «carry on to the route» (`NextResponse.next(...)`) becomes «carry on to `target`» — the headers it set (cookies, the request-header
 * overrides the proxy computes) travel with it. Redirects, JSON errors and other answers are returned untouched.
 */
export function carryOnToTarget(response: NextResponse, target: URL): NextResponse {
  if (response.headers.get('x-middleware-next') !== '1') return response;
  const rewritten = NextResponse.rewrite(target);
  response.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === 'x-middleware-next' || name === 'set-cookie') return;
    rewritten.headers.set(key, value);
  });
  for (const cookie of response.headers.getSetCookie()) rewritten.headers.append('set-cookie', cookie);
  return rewritten;
}
