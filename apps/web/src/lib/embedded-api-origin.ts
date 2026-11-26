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
 * story 5022 (b) — the one other name this server answers to: the server host's public address (`SPRINTABLE_PUBLIC_ORIGIN`, `https://<dns name>[:port]`, set by the supervisor only while the host has an owner and sign-up is closed).
 * The SAME rules as `publicHostOf` in apps/web/embedded-host-guard.cjs (the door) and as the host command that wrote it (a test holds the three together): a lower-case DNS name with a dot, https only, no IP in any spelling (a last
 * part that is a number — decimal or `0x` hex —), no `localhost`, no path · query · credentials, no explicit `:443`. Returns the `Host` a browser sends for it (`name` or `name:port`) or null (then only the loopback is served).
 */
export function publicHostOf(env: NodeJS.ProcessEnv = process.env): string | null {
  const m = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/.exec(env['SPRINTABLE_PUBLIC_ORIGIN'] ?? '');
  if (!m) return null;
  const name = m[1] as string;
  const port = m[2];
  if (name.length > 253 || (port !== undefined && (Number(port) > 65535 || port === '443'))) return null;
  const last = name.slice(name.lastIndexOf('.') + 1);
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last) || name === 'localhost' || name.endsWith('.localhost')) return null;
  return port === undefined ? name : `${name}:${port}`;
}

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
  const host = request.headers.get('host') ?? '';
  if (LOOPBACK_HOST.test(host)) return null;
  const publicHost = publicHostOf(env);
  if (publicHost !== null && host.toLowerCase() === publicHost) return null; // story 5022 (b): the public name of a server host, and only that exact one
  return new NextResponse('Invalid host header', { status: 400 });
}

/**
 * story 5022 (b) — is this web process the SERVER HOST's (a headless Linux server with a public address) and not the desktop app's own server? True only when it is an embedded server (`SPRINTABLE_EMBEDDED=1`) AND the supervisor gave it a usable public
 * address (`SPRINTABLE_PUBLIC_ORIGIN` — which it does only while the host has an owner and sign-up is closed). The one name for «a server host» the web reads: a SERVER component or route handler asks it (a client component cannot read the environment: the server
 * component hands the answer down as a prop). The desktop app's server never has it (no public address), a hosted deployment is not embedded.
 */
export function isServerHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEmbeddedServer(env) && publicHostOf(env) !== null;
}

/**
 * story 5025 (found on the VM round) — LOCAL MODE: the desktop app's own loopback server — embedded, and no public address. A workspace SERVER HOST is embedded too, but it is the middle server
 * a phone relays through and it serves several people and computers: the screens that say «there is no phone relay / no remote control to switch / one computer only» are for local mode, never for it.
 * The ONE name for «embedded && !isServerHost()» (the sibling phone-relay pages spell it out; the authenticated layout hands this to every client component as `useEmbeddedServer()`).
 */
export function isLocalModeServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEmbeddedServer(env) && !isServerHost(env);
}

/**
 * story 5024 (AC4) — the server host's own public address as a person types it (`https://team.example.com` — the same rules as `publicHostOf`), or null when this is not a server host. A SERVER component asks (and hands the string down as a
 * prop): the screens that tell a person which address to give `sprintable-host pair --server` fill it in from here — never from the browser's location (a proxy or a rewrite could make that another name).
 */
export function serverHostOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isEmbeddedServer(env)) return null;
  const host = publicHostOf(env);
  return host === null ? null : `https://${host}`;
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
