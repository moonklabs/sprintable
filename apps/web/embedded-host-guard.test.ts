// story 4824 (security lens AC7) — the desktop app's web server answers only `Host: 127.0.0.1:<its port>`, at the http server's door. Real http servers, raw sockets: what is
// asserted is what the wire does, not what a helper returns.
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);
const guard = require_('./embedded-host-guard.cjs') as {
  install: (env?: Record<string, string | undefined>, target?: unknown) => boolean;
  isAllowedHost: (host: unknown, port?: number) => boolean;
  targetAuthorityAllowed: (url: unknown, port?: number) => boolean;
};

interface Rig { port: number; hits: string[]; upgrades: number; close: () => Promise<void> }
const rigs: Rig[] = [];

/** a server class of its own (the guard is installed on ITS prototype, not on every http server of the test run) */
async function rig(env: Record<string, string | undefined> = { SPRINTABLE_EMBEDDED: '1' }, pinPort = true): Promise<Rig> {
  class GuardedServer extends http.Server {}
  const hits: string[] = [];
  const server = new GuardedServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.statusCode = 200; res.end('ok'); });
  let upgrades = 0;
  server.on('upgrade', (_req, socket) => { upgrades++; socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n'); });
  server.on('connect', (_req, socket) => { socket.end('HTTP/1.1 200 Connection established\r\n\r\n'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  guard.install(pinPort ? { ...env, PORT: String(port) } : env, GuardedServer.prototype);
  const r: Rig = { port, hits, get upgrades() { return upgrades; }, close: () => new Promise((res) => server.close(() => res())) } as Rig;
  rigs.push(r);
  return r;
}
afterEach(async () => { while (rigs.length) await rigs.pop()!.close(); });

/** one raw HTTP exchange; resolves with the status line + body the server wrote back */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => { out += d.toString(); });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(request);
    setTimeout(() => s.destroy(), 800).unref();
  });
}
const get = (path: string, host: string | null, extra = '') => `GET ${path} HTTP/1.1\r\n${host === null ? '' : `Host: ${host}\r\n`}Connection: close\r\n${extra}\r\n`;
const status = (r: string): string => /^HTTP\/1\.\d (\d{3})/.exec(r)?.[1] ?? 'none';

describe('isAllowedHost', () => {
  it('only 127.0.0.1:<port>; with a known port only that port', () => {
    expect(guard.isAllowedHost('127.0.0.1:3108')).toBe(true);
    expect(guard.isAllowedHost('127.0.0.1:3108', 3108)).toBe(true);
    expect(guard.isAllowedHost('127.0.0.1:3109', 3108)).toBe(false);
    for (const bad of ['127.0.0.1', 'localhost:3108', '[::1]:3108', '127.1:3108', '0x7f.0.0.1:3108', '127.0.0.1.:3108', '127.0.0.1.evil.com:3108', '127.0.0.1:3108@evil.com', 'evil.com@127.0.0.1:3108', '127.0.0.1:3108.evil.com', ' 127.0.0.1:3108', '127.0.0.1:3108 ', '127.0.0.1:', '127.0.0.1:123456', '', 'LOCALHOST:3108', '2130706433:3108', '127.0.0.1:3108,evil.com']) {
      expect(guard.isAllowedHost(bad, 3108), JSON.stringify(bad)).toBe(false);
    }
    expect(guard.isAllowedHost(undefined, 3108)).toBe(false);
    expect(guard.isAllowedHost(['127.0.0.1:3108'], 3108)).toBe(false);
  });
});

describe('the guard on a real server', () => {
  it('the right Host reaches the app; every other spelling is a 400 and the app is never reached', async () => {
    const r = await rig();
    expect(status(await raw(r.port, get('/login', `127.0.0.1:${r.port}`)))).toBe('200');
    expect(r.hits).toEqual(['GET /login']);
    const before = r.hits.length;
    for (const host of [`localhost:${r.port}`, `[::1]:${r.port}`, 'evil.example', `127.0.0.1.evil.example:${r.port}`, `127.0.0.1:${r.port}@evil.example`, '127.0.0.1', `127.0.0.1:${r.port + 1}`, '127.1', null]) {
      const out = await raw(r.port, get('/login', host));
      expect(status(out), String(host)).toBe('400'); // (a missing Host is already refused by Node's own parser — also a 400)
    }
    expect(await raw(r.port, get('/login', 'evil.example'))).toContain('Invalid host header'); // the guard's own answer
    expect(r.hits.length).toBe(before); // none of them got to the app
  });

  it('it does not matter WHICH path: the spellings a proxy matcher disagrees with the router about are all refused with a wrong Host', async () => {
    const r = await rig();
    for (const p of ['/api/v2/stories', '/API/V2/stories', '/Api/v2/x', '/api/v2/stories.png', '/api/v2/x.js', '/api/%76%32/x', '/api/v2%2fx', '/api/./v2/x', '/api/v2/../v2/x', '//api/v2/x', '/api/v2/%252e%252e/x', '/_next/static/a.js', '/favicon.ico', '/manifest.webmanifest', '/x.json', '/login', '/']) {
      expect(status(await raw(r.port, get(p, 'evil.example'))), p).toBe('400');
    }
    expect(r.hits).toEqual([]);
  });

  it('an absolute-form target names its own authority: a good Host does not rescue a foreign authority; a loopback authority is fine', async () => {
    const r = await rig();
    expect(status(await raw(r.port, get('http://evil.example/login', `127.0.0.1:${r.port}`)))).toBe('400');
    expect(status(await raw(r.port, get('https://evil.example:443/x', `127.0.0.1:${r.port}`)))).toBe('400');
    expect(status(await raw(r.port, get(`http://127.0.0.1:${r.port}/login`, `127.0.0.1:${r.port}`)))).toBe('200');
    expect(r.hits).toEqual([`GET http://127.0.0.1:${r.port}/login`]);
  });

  it('upgrades (websockets) and CONNECT are refused with a wrong Host and let through with the right one', async () => {
    const r = await rig();
    const up = (host: string) => `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    expect(status(await raw(r.port, up('evil.example')))).toBe('400');
    expect(r.upgrades).toBe(0);
    expect(status(await raw(r.port, up(`127.0.0.1:${r.port}`)))).toBe('101');
    expect(r.upgrades).toBe(1);
    expect(status(await raw(r.port, `CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n`))).toBe('400');
  });

  it('Expect: 100-continue with a wrong Host: the app is never reached and the answer is 400 (Node itself may write the interim «100 Continue» line first when nobody listens for checkContinue — nothing is read or run)', async () => {
    const r = await rig();
    const out = await raw(r.port, `POST /api/v2/x HTTP/1.1\r\nHost: evil.example\r\nExpect: 100-continue\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`);
    expect(out).toContain('400 Bad Request');
    expect(out).toContain('Invalid host header');
    expect(r.hits).toEqual([]);
  });

  it('is installed only for the app\'s own server (SPRINTABLE_EMBEDDED=1): any other deployment is untouched; installing twice is one guard', async () => {
    class Plain extends http.Server {}
    const original = Plain.prototype.emit;
    expect(guard.install({}, Plain.prototype)).toBe(false);
    expect(guard.install({ SPRINTABLE_EMBEDDED: '0' }, Plain.prototype)).toBe(false);
    expect(Plain.prototype.emit).toBe(original);
    class Twice extends http.Server {}
    expect(guard.install({ SPRINTABLE_EMBEDDED: '1' }, Twice.prototype)).toBe(true);
    const once = Twice.prototype.emit;
    expect(guard.install({ SPRINTABLE_EMBEDDED: '1' }, Twice.prototype)).toBe(true);
    expect(Twice.prototype.emit).toBe(once);
  });

  it('without a known port any port of 127.0.0.1 is accepted (the app always sets PORT; this is the fallback)', async () => {
    const r = await rig({ SPRINTABLE_EMBEDDED: '1' }, false);
    expect(status(await raw(r.port, get('/', `127.0.0.1:${r.port}`)))).toBe('200');
    expect(status(await raw(r.port, get('/', 'localhost:1234')))).toBe('400');
  });
});
