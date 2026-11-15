// story 4844 — the desktop app's web server hands `/api/v2/*` to its backend at the http server's door (embedded-api-relay.cjs), behind the Host guard (embedded-host-guard.cjs).
// Real http servers and raw sockets: what is asserted is what the wire does. The defect it closes (story 4843): Next's proxy never ends the client's response when the upstream is CUT — a stream
// (`GET /api/v2/agent/stream`) of a local agent is then left open for ever after the app's backend restarts.
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const relay = require_('./embedded-api-relay.cjs') as {
  install: (env?: Record<string, string | undefined>, target?: unknown) => boolean;
  relayTarget: (rawUrl: unknown, env?: Record<string, string | undefined>) => URL | null;
};
const guard = require_('./embedded-host-guard.cjs') as { install: (env?: Record<string, string | undefined>, target?: unknown) => boolean };

type Mode = 'end' | 'reset' | 'silent';
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
interface Backend { port: number; seen: Seen[]; open: () => number; held: () => number; mode: Mode; closeAll: () => Promise<void> }

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const savedOrigin = process.env['SPRINTABLE_API_ORIGIN'];
beforeEach(() => { delete process.env['SPRINTABLE_API_ORIGIN']; });
afterEach(() => { if (savedOrigin === undefined) delete process.env['SPRINTABLE_API_ORIGIN']; else process.env['SPRINTABLE_API_ORIGIN'] = savedOrigin; });

/** a stand-in for the app's backend: `/api/v2/agent/stream` sends a first event and then ends / is reset / says nothing, according to `mode`; every other path answers and echoes what it got */
async function backend(initial: Mode = 'end', lifeMs = 300): Promise<Backend> {
  const seen: Seen[] = [];
  const sockets = new Set<net.Socket>();
  let open = 0;
  let held = 0;
  const b: Backend = { port: 0, seen, open: () => open, held: () => held, mode: initial, closeAll: async () => { for (const s of sockets) s.destroy(); } };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url?.startsWith('/api/v2/agent/stream')) {
        open++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': first\n\n');
        res.on('close', () => { open--; });
        if (b.mode === 'end') setTimeout(() => res.end(), lifeMs);
        else if (b.mode === 'reset') setTimeout(() => req.socket.destroy(), lifeMs);
        return;
      }
      if (req.url?.startsWith('/api/v2/hold')) { // never answers: the request stays open until the other side closes it
        held++;
        res.on('close', () => { held--; });
        return;
      }
      if (req.url?.startsWith('/api/v2/slow')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 2500);
        return;
      }
      res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
      res.setHeader('X-Echo-Host', String(req.headers['host']));
      res.statusCode = 201;
      res.end(JSON.stringify({ method: req.method, url: req.url, bodyLength: body.length }));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  b.port = (server.address() as net.AddressInfo).port;
  cleanups.push(async () => { await b.closeAll(); await new Promise<void>((r) => server.close(() => r())); });
  return b;
}

interface Door { port: number; nextHits: string[]; connections: () => Promise<number> }
/** the app's web server: a request listener that stands for Next, a server class of its own, and the layers installed in the order given (the first listed is installed first = innermost) */
async function door(layers: Array<'relay' | 'guard'> = ['relay', 'guard']): Promise<Door> {
  class AppServer extends http.Server {}
  const nextHits: string[] = [];
  const server = new AppServer((req, res) => { nextHits.push(`${req.method} ${req.url}`); res.end('next'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  for (const layer of layers) (layer === 'relay' ? relay : guard).install({ SPRINTABLE_EMBEDDED: '1', PORT: String(port) }, AppServer.prototype);
  cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { port, nextHits, connections: () => new Promise((r) => server.getConnections((_e, n) => r(n))) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** one raw HTTP exchange; resolves with everything the server wrote back */
function raw(port: number, request: string, wait = 800): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => { out += d.toString(); });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(request);
    setTimeout(() => s.destroy(), wait).unref();
  });
}
const get = (port: number, p: string, extra = '', host = `127.0.0.1:${port}`) => `GET ${p} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${extra}\r\n`;
const status = (r: string): string => /^HTTP\/1\.\d (\d{3})/.exec(r)?.[1] ?? 'none';

/** open N streams to `port`; resolves with how many ENDED or were CUT from the client's side within `ms` (the others are still open) */
async function streams(port: number, n: number, ms: number, p = '/api/v2/agent/stream'): Promise<{ answered: number; ended: number; sockets: net.Socket[] }> {
  let answered = 0;
  let ended = 0;
  const sockets: net.Socket[] = [];
  for (let i = 0; i < n; i++) {
    const req = http.get({ host: '127.0.0.1', port, path: `${p}?i=${i}`, agent: false, headers: { 'User-Agent': 'python-httpx/0.27' } }, (res) => {
      answered++;
      sockets.push(res.socket);
      let done = false;
      const over = () => { if (!done) { done = true; ended++; } };
      res.on('end', over); res.on('close', over); res.on('error', over); res.on('aborted', over);
      res.resume();
    });
    req.on('error', () => undefined);
  }
  await sleep(ms);
  return { answered, ended, sockets };
}

describe('relayTarget', () => {
  const env = { SPRINTABLE_API_ORIGIN: 'http://127.0.0.1:5555' };
  it('reads the path the way lib/embedded-api-origin.ts does: the prefix in any letter case, the backend gets the canonical one, the query goes on', () => {
    expect(relay.relayTarget('/api/v2/stories?x=1&y=2', env)?.href).toBe('http://127.0.0.1:5555/api/v2/stories?x=1&y=2');
    expect(relay.relayTarget('/API/V2/Stories', env)?.href).toBe('http://127.0.0.1:5555/api/v2/Stories');
    expect(relay.relayTarget('/api/v2/a/b/c', env)?.pathname).toBe('/api/v2/a/b/c');
  });
  it('anything that is not an API path, or has no usable backend address, is null (Next gets it as before)', () => {
    for (const p of ['/api/v2', '/api/v2x/x', '/api/dashboard', '/login', '//api/v2/x', 'http://evil/api/v2/x', '/api/v2/../dashboard', '/api/v2/%2e%2e/dashboard', undefined, 5]) {
      expect(relay.relayTarget(p, env), String(p)).toBeNull();
    }
    for (const origin of [undefined, '', 'not a url', 'ftp://x', 'file:///etc']) {
      expect(relay.relayTarget('/api/v2/x', { SPRINTABLE_API_ORIGIN: origin }), String(origin)).toBeNull();
    }
  });
});

describe('the relay behind the Host guard', () => {
  it('an API request goes to the backend (canonical path, query, Host of the backend, forwarding headers written here); everything else goes to Next', async () => {
    const be = await backend();
    process.env['SPRINTABLE_API_ORIGIN'] = `http://127.0.0.1:${be.port}`;
    const d = await door();
    const out = await raw(d.port, get(d.port, '/API/V2/things?x=1', 'X-Forwarded-For: 6.6.6.6\r\nX-Forwarded-Host: evil.example\r\nX-Forwarded-Port: 1\r\nX-Forwarded-Prefix: /evil\r\nX-Forwarded-Proto: https\r\nConnection: keep-alive, X-Secret\r\nX-Secret: s\r\nKeep-Alive: 5\r\n'));
    expect(status(out)).toBe('201');
    expect(out.toLowerCase()).toContain('set-cookie: a=1');
    expect(out.toLowerCase()).toContain('set-cookie: b=2'); // two Set-Cookie lines stay two
    expect(be.seen).toHaveLength(1);
    expect(be.seen[0].url).toBe('/api/v2/things?x=1');
    expect(be.seen[0].headers['host']).toBe(`127.0.0.1:${be.port}`);
    expect(be.seen[0].headers['x-forwarded-for']).toBe('127.0.0.1'); // not the client's claim
    expect(be.seen[0].headers['x-forwarded-host']).toBe(`127.0.0.1:${d.port}`);
    expect(be.seen[0].headers['x-forwarded-proto']).toBe('http');
    expect(be.seen[0].headers['x-forwarded-port'], 'a forwarding header the relay does not write itself is not taken from the client either').toBeUndefined();
    expect(be.seen[0].headers['x-forwarded-prefix']).toBeUndefined();
    expect(be.seen[0].headers['x-secret']).toBeUndefined(); // named by Connection: hop-by-hop
    expect(be.seen[0].headers['keep-alive']).toBeUndefined();
    expect(d.nextHits).toEqual([]);
    expect(status(await raw(d.port, get(d.port, '/login')))).toBe('200');
    expect(status(await raw(d.port, get(d.port, '/api/dashboard')))).toBe('200');
    expect(status(await raw(d.port, get(d.port, '/api/v2')))).toBe('200'); // the bare prefix is a Next path
    expect(d.nextHits).toEqual(['GET /login', 'GET /api/dashboard', 'GET /api/v2']);
    expect(be.seen).toHaveLength(1);
  });

  it('a request body goes through whole, with a length and chunked', async () => {
    const be = await backend();
    process.env['SPRINTABLE_API_ORIGIN'] = `http://127.0.0.1:${be.port}`;
    const d = await door();
    const body = 'x'.repeat(200_000);
    const post = await raw(d.port, `POST /api/v2/up HTTP/1.1\r\nHost: 127.0.0.1:${d.port}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`, 1500);
    expect(status(post)).toBe('201');
    expect(be.seen[0].body.length).toBe(200_000);
    const chunked = await raw(d.port, `POST /api/v2/up2 HTTP/1.1\r\nHost: 127.0.0.1:${d.port}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n`, 1500);
    expect(status(chunked)).toBe('201');
    expect(be.seen[1].body).toBe('hello world');
  });

  it('the stream the backend ENDS ends for the client too', async () => {
    const be = await backend('end', 300);
    process.env['SPRINTABLE_API_ORIGIN'] = `http://127.0.0.1:${be.port}`;
    const d = await door();
    const r = await streams(d.port, 20, 1500);
    expect(r.answered).toBe(20);
    expect(r.ended).toBe(20);
    expect(be.open()).toBe(0);
  });

  it('the stream the backend CUTS (a reset in the middle of the response) ends for the client too: 20 of 20, nothing held — the case Next failed', async () => {
    const be = await backend('reset', 300);
    process.env['SPRINTABLE_API_ORIGIN'] = `http://127.0.0.1:${be.port}`;
    const d = await door();
    const r = await streams(d.port, 20, 1500);
    expect(r.answered).toBe(20);
    expect(r.ended, 'every client connection ended').toBe(20);
    await sleep(200);
    expect(await d.connections(), 'the door holds no connection').toBe(0);
    expect(be.open()).toBe(0);
  });

  it('a silent backend keeps the client waiting, and when the CLIENT goes away the upstream is closed', async () => {
    const be = await backend('silent');
    process.env['SPRINTABLE_API_ORIGIN'] = `http://127.0.0.1:${be.port}`;
    const d = await door();
    const r = await streams(d.port, 10, 800);
    expect(r.answered).toBe(10);
    expect(r.ended).toBe(0);
    expect(be.open()).toBe(10);
    for (const s of r.sockets) s.destroy();
    await sleep(600);
    expect(be.open(), 'the upstream requests were closed with the clients').toBe(0);
    expect(await d.connections()).toBe(0);
  });

  it('a client that leaves BEFORE the backend has answered closes the upstream request too (nothing is left waiting on a backend that never answers)', async () => {
    const be = await backend();
    process.env['SPRINTABLE_API_ORIGIN'] = `http://127.0.0.1:${be.port}`;
    const d = await door();
    const socks: net.Socket[] = [];
    for (let i = 0; i < 5; i++) {
      const s = net.connect(d.port, '127.0.0.1');
      s.write(get(d.port, `/api/v2/hold?i=${i}`));
      socks.push(s);
    }
    await sleep(500);
    expect(be.held(), 'the five requests wait at the backend').toBe(5);
    for (const s of socks) s.destroy();
    await sleep(600);
    expect(be.held(), 'they were closed with their clients').toBe(0);
    expect(await d.connections()).toBe(0);
  });

  it('a stream is not held back: the first event arrives at once although the response goes on, and nothing is compressed', async () => {
    const be = await backend();
    process.env['SPRINTABLE_API_ORIGIN'] = `http://127.0.0.1:${be.port}`;
    const d = await door();
    const first = await new Promise<{ ms: number; encoding: string | undefined; data: string }>((resolve, reject) => {
      const t0 = Date.now();
      const req = http.get({ host: '127.0.0.1', port: d.port, path: '/api/v2/slow', agent: false, headers: { 'Accept-Encoding': 'gzip, zstd' } }, (res) => {
        res.once('data', (c: Buffer) => { resolve({ ms: Date.now() - t0, encoding: res.headers['content-encoding'] as string | undefined, data: c.toString() }); req.destroy(); });
      });
      req.on('error', reject);
    });
    expect(first.data).toBe('data: one\n\n');
    expect(first.ms, 'the first chunk comes long before the response ends (2.5 s)').toBeLessThan(800);
    expect(first.encoding).toBeUndefined();
  });

  it('a backend that is not there is a 502, not a hang', async () => {
    process.env['SPRINTABLE_API_ORIGIN'] = 'http://127.0.0.1:1';
    const d = await door();
    const out = await raw(d.port, get(d.port, '/api/v2/x'), 3000);
    expect(status(out)).toBe('502');
    expect(out).toContain('Bad Gateway');
  });

  it('without a usable SPRINTABLE_API_ORIGIN every request goes to Next as it did before', async () => {
    const d = await door();
    expect(status(await raw(d.port, get(d.port, '/api/v2/x')))).toBe('200');
    process.env['SPRINTABLE_API_ORIGIN'] = 'not a url';
    expect(status(await raw(d.port, get(d.port, '/api/v2/y')))).toBe('200');
    expect(d.nextHits).toEqual(['GET /api/v2/x', 'GET /api/v2/y']);
  });

  it('the Host guard judges an /api/v2 request FIRST: a foreign Host or another site never reaches the backend; the right Host does', async () => {
    const be = await backend('silent');
    process.env['SPRINTABLE_API_ORIGIN'] = `http://127.0.0.1:${be.port}`;
    const d = await door(['relay', 'guard']);
    for (const host of ['evil.example', `localhost:${d.port}`, `127.0.0.1:${d.port + 1}`, `127.0.0.1.evil.example:${d.port}`]) {
      const out = await raw(d.port, get(d.port, '/api/v2/agent/stream', '', host));
      expect(status(out), host).toBe('400');
      expect(out).toContain('Invalid host header');
    }
    for (const extra of ['Sec-Fetch-Site: cross-site\r\n', 'Sec-Fetch-Site: same-site\r\n', 'Origin: http://evil.example\r\n', 'Origin: null\r\n']) {
      expect(status(await raw(d.port, get(d.port, '/api/v2/agent/stream', extra))), extra).toBe('403');
    }
    const absolute = await raw(d.port, get(d.port, 'http://evil.example/api/v2/agent/stream'));
    expect(status(absolute)).toBe('400');
    expect(be.seen, 'the backend was never reached').toEqual([]);
    expect(be.open()).toBe(0);
    expect(d.nextHits).toEqual([]);
    const ok = await raw(d.port, get(d.port, '/api/v2/agent/stream', 'Sec-Fetch-Site: same-origin\r\n'), 600);
    expect(status(ok)).toBe('200');
    expect(be.seen).toHaveLength(1);
  });

  it('the ORDER matters: with the relay installed AFTER the guard (outside it) a foreign Host reaches the backend — that is why the entrance installs the relay first', async () => {
    const be = await backend('silent');
    process.env['SPRINTABLE_API_ORIGIN'] = `http://127.0.0.1:${be.port}`;
    const wrong = await door(['guard', 'relay']);
    const out = await raw(wrong.port, get(wrong.port, '/api/v2/agent/stream', '', 'evil.example'), 600);
    expect(status(out), 'the wrong order lets a rebinding page through').toBe('200');
    expect(be.seen).toHaveLength(1);
  });

  it('is installed only for the app\'s own server; installing twice is one relay', async () => {
    class Plain extends http.Server {}
    const original = Plain.prototype.emit;
    expect(relay.install({}, Plain.prototype)).toBe(false);
    expect(relay.install({ SPRINTABLE_EMBEDDED: '0' }, Plain.prototype)).toBe(false);
    expect(Plain.prototype.emit).toBe(original);
    expect(relay.install({ SPRINTABLE_EMBEDDED: '1' }, Plain.prototype)).toBe(true);
    const wrapped = Plain.prototype.emit;
    expect(wrapped).not.toBe(original);
    expect(relay.install({ SPRINTABLE_EMBEDDED: '1' }, Plain.prototype)).toBe(true);
    expect(Plain.prototype.emit).toBe(wrapped);
  });
});

describe('the entrance file, started as the app starts it', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'entry4844-'));
  // The stub says it is listening with a marker that cannot be part of a path: the bare word «up» is also inside a random temp-directory name now and then (`/tmp/entry4844-kOswup/…`), which broke the NEGATIVE assertion below about 1 run in 800.
  const READY = 'STUB-LISTENING-4844';
  const stubServer = `const http = require('node:http');
http.createServer((req, res) => { res.end('next'); }).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('${READY}'));
`;
  async function start(files: string[], extra: Record<string, string> = {}, relayBody?: string): Promise<{ proc: ChildProcess; port: number; out: () => string; exited: Promise<number | null> }> {
    const tmp = dir();
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    for (const f of files) copyFileSync(path.join(here, f), path.join(tmp, f));
    if (relayBody !== undefined) writeFileSync(path.join(tmp, 'embedded-api-relay.cjs'), relayBody);
    writeFileSync(path.join(tmp, 'server.js'), stubServer);
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    let log = '';
    const proc = spawn(process.execPath, [path.join(tmp, 'embedded-entry.cjs')], { cwd: tmp, env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production', SPRINTABLE_EMBEDDED: '1', PORT: String(port), ...extra } as NodeJS.ProcessEnv }); // (Next's types make NODE_ENV a required literal of ProcessEnv: the cast keeps `extra` free to carry other names)
    proc.stdout!.on('data', (d: Buffer) => { log += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { log += d.toString(); });
    const exited = new Promise<number | null>((r) => proc.on('exit', (c) => r(c)));
    cleanups.push(() => { proc.kill('SIGKILL'); });
    for (let i = 0; i < 100 && !log.includes(READY); i++) { await sleep(50); if (proc.exitCode !== null) break; }
    return { proc, port, out: () => log, exited };
  }

  it('the real entry file, guard and relay: /api/v2 goes to the backend through the guard; a foreign Host is refused; a cut stream ends', async () => {
    const be = await backend('reset', 300);
    const app = await start(['embedded-entry.cjs', 'embedded-host-guard.cjs', 'embedded-api-relay.cjs'], { SPRINTABLE_API_ORIGIN: `http://127.0.0.1:${be.port}` });
    expect(app.out()).toContain(READY);
    expect(status(await raw(app.port, get(app.port, '/page')))).toBe('200');
    expect(status(await raw(app.port, get(app.port, '/api/v2/agent/stream', '', 'evil.example')))).toBe('400');
    expect(be.seen).toEqual([]);
    const r = await streams(app.port, 5, 1500);
    expect(r.answered).toBe(5);
    expect(r.ended).toBe(5);
    expect(be.open()).toBe(0);
  });

  it('an app build that does not carry the relay file starts as before (the guard works, /api/v2 goes to Next)', async () => {
    const be = await backend();
    const app = await start(['embedded-entry.cjs', 'embedded-host-guard.cjs'], { SPRINTABLE_API_ORIGIN: `http://127.0.0.1:${be.port}` });
    expect(app.out()).toContain(READY);
    expect(status(await raw(app.port, get(app.port, '/api/v2/x')))).toBe('200');
    expect(be.seen).toEqual([]);
    expect(status(await raw(app.port, get(app.port, '/api/v2/x', '', 'evil.example')))).toBe('400');
  });

  it('only «the relay file is not there» is let through: a relay that fails for another reason stops the start', async () => {
    const app = await start(['embedded-entry.cjs', 'embedded-host-guard.cjs'], {}, "require('./some-other-file-that-is-missing.cjs');\n");
    expect(await app.exited).not.toBe(0);
    expect(app.out()).toContain('some-other-file-that-is-missing');
    expect(app.out()).not.toContain(READY);
  });
});
