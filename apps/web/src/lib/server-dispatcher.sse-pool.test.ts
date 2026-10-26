// story 4786 — the browser event stream must not share the backend origin's h2 connection with the BFF's POSTs.
// Why: with REALTIME_URL empty (dev 10-26) `/api/event-stream` streams from the backend origin itself. A never-ending response on an h2 connection
// makes undici's h2 `busy()` refuse every non-idempotent request (POST · PUT · PATCH · DELETE) on that connection: login · refresh · send-message
// went to a 30 s 503 while GETs stayed fast. Real local TLS h2 server + the real global fetch, as server-dispatcher.test.ts does.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http2 from 'node:http2';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

import { fileURLToPath } from 'node:url';

import { BACKEND_EVENT_STREAM_PATH, createBffDispatcher, isEventStreamToBackend, isH1OnlyToBackend, isNonIdempotentMethod } from './server-dispatcher';

let cert: Buffer;
let key: Buffer;
let tmp = '';
let srv: { url: string; versions: Map<string, string[]>; open: () => number; close: () => Promise<void> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-sse-pool-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  key = fs.readFileSync(path.join(tmp, 'key.pem'));
  cert = fs.readFileSync(path.join(tmp, 'cert.pem'));
  // like the backend behind Cloud Run: h2 (ALPN) and h1 both answered
  const server = http2.createSecureServer({ key, cert, allowHTTP1: true });
  const versions = new Map<string, string[]>(); // route -> HTTP versions that reached it
  const seen = (route: string, v: string) => versions.set(route, [...(versions.get(route) ?? []), v]);
  const sockets = new Set<{ destroy: () => void }>();
  server.on('secureConnection', (s: { destroy: () => void; once: (e: string, f: () => void) => void }) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  server.on('request', (req, res) => {
    const route = String(req.url).split('?')[0];
    seen(route, req.httpVersion);
    if (route === BACKEND_EVENT_STREAM_PATH || route === '/other-endless') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': hello\n\n');
      const t = setInterval(() => res.write(': heartbeat\n\n'), 100);
      res.on('close', () => clearInterval(t));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(Buffer.from(c)));
    // `/slow` takes 4 s to answer (a slow upstream call); everything else answers at once
    req.on('end', () => {
      const t = setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, bytes: Buffer.concat(chunks).length })); }, route === '/slow' ? 4000 : 10);
      res.on('close', () => clearTimeout(t));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  srv = {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    versions,
    open: () => sockets.size, // server-side sockets still open (the client's sockets, seen from the server)
    close: () => new Promise<void>((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); }),
  };
});
afterAll(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let prev: Dispatcher | null = null;
const made: Dispatcher[] = [];
const aborts: AbortController[] = [];
afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  if (prev) setGlobalDispatcher(prev);
  prev = null;
  await Promise.all(made.splice(0).map((d) => d.destroy().catch(() => {})));
  srv.versions.clear();
});
function install(): Dispatcher {
  prev = prev ?? getGlobalDispatcher();
  const agent = createBffDispatcher(srv.url, { connect: { ca: cert } });
  made.push(agent);
  setGlobalDispatcher(agent);
  return agent;
}
/** opens a stream like the BFF route does and reads its first chunk (so the response is really live and open) */
async function openStream(pathAndQuery: string): Promise<void> {
  const ac = new AbortController();
  aborts.push(ac);
  const res = await fetch(`${srv.url}${pathAndQuery}`, { headers: { Authorization: 'Bearer x' }, signal: ac.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  void (async () => { for (;;) { const { done } = await reader.read().catch(() => ({ done: true })); if (done) break; } })();
}
async function withinMs<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: still waiting after ${ms} ms`); })]);
}
/** polls until `ok()` holds (the server learns of a client-side close a moment later) */
async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`${what}: not true after ${ms} ms`);
    await sleep(25);
  }
}
const post = () => fetch(`${srv.url}/api/v2/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.c', password: 'x' }) }).then(async (r) => ({ status: r.status, body: await r.text() }));

describe('the browser event stream does not hold up the BFF\'s POSTs', () => {
  it('one open stream on the backend origin · a POST still goes through at once (and a GET)', async () => {
    install();
    await openStream(`${BACKEND_EVENT_STREAM_PATH}?member_id=m1`);
    const r = await withinMs(3000, post(), 'POST behind an open event stream');
    expect(r.status).toBe(200);
    const g = await withinMs(3000, fetch(`${srv.url}/api/v2/auth/me`).then((x) => x.status), 'GET behind an open event stream');
    expect(g).toBe(200);
  });

  it('many open streams · concurrent POSTs · PUT · PATCH · a DELETE with a body all go through', async () => {
    install();
    for (let i = 0; i < 8; i++) await openStream(`${BACKEND_EVENT_STREAM_PATH}?member_id=m${i}`);
    const send = (method: string) => fetch(`${srv.url}/api/v2/things`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 1 }) }).then((r) => r.status);
    const all = await withinMs(5000, Promise.all([post(), post(), post(), send('PUT'), send('PATCH'), send('DELETE')]), 'writes behind eight open event streams');
    expect(all.map((x) => (typeof x === 'number' ? x : x.status))).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it('one slow POST in progress · another POST (and a PUT · DELETE) goes through at once (prod had this path too: one slow POST held up the rest)', async () => {
    install();
    const slow = fetch(`${srv.url}/slow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status);
    await sleep(150); // the slow one is on the wire
    const t0 = performance.now();
    const quick = await withinMs(1500, Promise.all([
      post(),
      fetch(`${srv.url}/api/v2/things`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status),
      fetch(`${srv.url}/api/v2/things`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status),
    ]), 'writes while one slow POST is in progress');
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(quick.map((x) => (typeof x === 'number' ? x : x.status))).toEqual([200, 200, 200]);
    expect(await slow).toBe(200); // the slow one still finishes by itself
  }, 15000);

  it('the stream and every non-idempotent request ride h1 on their own connections; GET stays h2 (also beside an open stream)', async () => {
    install();
    await openStream(`${BACKEND_EVENT_STREAM_PATH}?member_id=m1`);
    await post();
    await fetch(`${srv.url}/api/v2/things`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.text());
    await fetch(`${srv.url}/api/v2/auth/me`).then((r) => r.text());
    await Promise.all(Array.from({ length: 8 }, (_, i) => fetch(`${srv.url}/api/v2/list/${i}`).then((r) => r.text())));
    expect(srv.versions.get(BACKEND_EVENT_STREAM_PATH)).toEqual(['1.1']);
    expect(srv.versions.get('/api/v2/auth/token')).toEqual(['1.1']);
    expect(srv.versions.get('/api/v2/things')).toEqual(['1.1']);
    expect(srv.versions.get('/api/v2/auth/me')).toEqual(['2.0']);
    for (let i = 0; i < 8; i++) expect(srv.versions.get(`/api/v2/list/${i}`)).toEqual(['2.0']);
  });

  it('only the event stream PATH is special: an endless GET anywhere else stays on h2 (a stream elsewhere is not guessed), and a GET still goes through beside it', async () => {
    install();
    await openStream('/other-endless');
    expect(srv.versions.get('/other-endless')).toEqual(['2.0']);
    const g = await withinMs(3000, fetch(`${srv.url}/api/v2/auth/me`).then((x) => x.status), 'GET beside an endless GET');
    expect(g).toBe(200);
  });
});

describe('the stream path is the one the BFF route really calls', () => {
  it('BACKEND_EVENT_STREAM_PATH is the literal path in apps/web/src/app/api/event-stream/route.ts (a constant checked only against itself would drift)', () => {
    expect(BACKEND_EVENT_STREAM_PATH).toBe('/api/v2/events/stream');
    const route = fs.readFileSync(fileURLToPath(new URL('../app/api/event-stream/route.ts', import.meta.url)), 'utf8');
    expect(route).toContain(`/api/v2/events/stream\``); // `${EVENT_STREAM_UPSTREAM_URL()}/api/v2/events/stream`
  });
});

describe('isNonIdempotentMethod · isH1OnlyToBackend', () => {
  const backend = 'https://backend.example';
  const o = (method: string, over: Partial<Dispatcher.DispatchOptions> = {}): Dispatcher.DispatchOptions =>
    ({ origin: backend, method, path: '/api/v2/x', ...over }) as Dispatcher.DispatchOptions;
  it('GET · HEAD are idempotent (any case); POST · PUT · PATCH · DELETE · OPTIONS are not', () => {
    for (const m of ['GET', 'get', 'HEAD', 'head']) expect(isNonIdempotentMethod(m), m).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post']) expect(isNonIdempotentMethod(m), m).toBe(true);
  });
  it('on the backend origin: non-idempotent requests and the event stream are h1-only; a plain GET · HEAD is not', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) expect(isH1OnlyToBackend(o(m), backend), m).toBe(true);
    expect(isH1OnlyToBackend(o('GET', { path: `${BACKEND_EVENT_STREAM_PATH}?member_id=m1` }), backend)).toBe(true);
    expect(isH1OnlyToBackend(o('GET'), backend)).toBe(false);
    expect(isH1OnlyToBackend(o('HEAD'), backend)).toBe(false);
  });
  it('other origins (the pool is only special for the backend) and an unknown backend are never moved', () => {
    expect(isH1OnlyToBackend(o('POST', { origin: 'https://other.example' }), backend)).toBe(false);
    expect(isH1OnlyToBackend(o('POST'), null)).toBe(false);
  });
});

describe('isEventStreamToBackend', () => {
  const backend = 'https://backend.example';
  const opts = (over: Partial<Dispatcher.DispatchOptions> = {}): Dispatcher.DispatchOptions =>
    ({ origin: backend, method: 'GET', path: `${BACKEND_EVENT_STREAM_PATH}?member_id=m1`, ...over }) as Dispatcher.DispatchOptions;
  it('is true for a GET of exactly the stream path (query ignored) on the backend origin', () => {
    expect(isEventStreamToBackend(opts(), backend)).toBe(true);
    expect(isEventStreamToBackend(opts({ path: BACKEND_EVENT_STREAM_PATH }), backend)).toBe(true);
    expect(isEventStreamToBackend(opts({ method: 'get' }), backend)).toBe(true);
  });
  it('is false for another method, another path (prefix · suffix · parent), another origin, or no known backend', () => {
    expect(isEventStreamToBackend(opts({ method: 'POST' }), backend)).toBe(false);
    expect(isEventStreamToBackend(opts({ path: `${BACKEND_EVENT_STREAM_PATH}/x` }), backend)).toBe(false);
    expect(isEventStreamToBackend(opts({ path: '/api/v2/events' }), backend)).toBe(false);
    expect(isEventStreamToBackend(opts({ path: '/x/api/v2/events/stream' }), backend)).toBe(false);
    expect(isEventStreamToBackend(opts({ origin: 'https://realtime.example' }), backend)).toBe(false);
    expect(isEventStreamToBackend(opts(), null)).toBe(false);
  });
});

// ---- the h1 agent's own behaviour (lens on PR 5257, Kadir): three mutants the cells above let through ----
describe('the h1 agent keeps its 60 s keep-alive and is closed / destroyed with the dispatcher', () => {
  it('a POST after 6 s of idle reuses the connection when the server sends no keep-alive hint (the client\'s own keep-alive decides; undici\'s default would drop it)', async () => {
    // the real backend front end (Google Frontend) advertises no `Keep-Alive: timeout=`; Node\'s default would (5 s), so this server turns it off
    const sockets = new Set<{ destroy: () => void }>();
    let conns = 0;
    const server = https.createServer({ key, cert }, (req, res) => {
      req.resume();
      req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    });
    server.keepAliveTimeout = 0; // no hint, and the server never closes an idle socket itself
    server.on('secureConnection', (s: { destroy: () => void; once: (e: string, f: () => void) => void }) => { conns += 1; sockets.add(s); s.once('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      prev = prev ?? getGlobalDispatcher();
      const agent = createBffDispatcher(url, { connect: { ca: cert } });
      made.push(agent);
      setGlobalDispatcher(agent);
      const send = () => fetch(`${url}/api/v2/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.text());
      await send();
      expect(conns).toBe(1);
      await sleep(6000);
      await send();
      expect(conns).toBe(1); // 0 new connections
    } finally {
      await new Promise<void>((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); });
    }
  }, 20000);

  it('close() with an open stream stays pending until the stream ends; afterwards no socket is left (the h1 agent is closed too)', async () => {
    const agent = install();
    await openStream(`${BACKEND_EVENT_STREAM_PATH}?member_id=m1`);
    let closed = false;
    const closing = agent.close().then(() => { closed = true; });
    await sleep(600);
    expect(closed).toBe(false); // the stream is still open
    for (const a of aborts.splice(0)) a.abort();
    await withinMs(5000, closing, 'close() after the stream ended');
    await until(() => srv.open() === 0, 3000, 'server-side sockets after close()');
  }, 15000);

  it('destroy() with an open stream and a POST in flight ends at once and leaves no socket; the in-flight POST is cut, not answered', async () => {
    const agent = install();
    await openStream(`${BACKEND_EVENT_STREAM_PATH}?member_id=m1`);
    const slow = fetch(`${srv.url}/slow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => 'answered', () => 'cut');
    await sleep(150); // the slow POST is on the wire
    const t0 = performance.now();
    await withinMs(2500, agent.destroy(), 'destroy()');
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(await slow).toBe('cut');
    await until(() => srv.open() === 0, 2000, 'server-side sockets after destroy()');
  }, 15000);
});
