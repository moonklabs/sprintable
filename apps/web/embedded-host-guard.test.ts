// story 4824 (security lens AC7) — the desktop app's web server answers only `Host: 127.0.0.1:<its port>`, at the http server's door. Real http servers, raw sockets: what is
// asserted is what the wire does, not what a helper returns.
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require_ = createRequire(import.meta.url);
const guard = require_('./embedded-host-guard.cjs') as {
  install: (env?: Record<string, string | undefined>, target?: unknown, options?: { bodyBudget?: number }) => boolean;
  isAllowedHost: (host: unknown, port?: number) => boolean;
  targetAuthorityAllowed: (url: unknown, port?: number) => boolean;
  crossSiteRequest: (req: unknown, port?: number) => boolean;
};

interface Rig { port: number; hits: string[]; bodies: number[]; upgrades: number; close: () => Promise<void> }
const rigs: Rig[] = [];

/** a server class of its own (the guard is installed on ITS prototype, not on every http server of the test run) */
async function rig(env: Record<string, string | undefined> = { SPRINTABLE_EMBEDDED: '1' }, pinPort = true, options: { bodyBudget?: number } = {}): Promise<Rig> {
  class GuardedServer extends http.Server {}
  const hits: string[] = [];
  const bodies: number[] = []; // how many body bytes the app READ for each request (an app that reads the body, like the proxy that forwards it)
  const server = new GuardedServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; });
    req.on('end', () => { bodies.push(n); res.statusCode = 200; res.end(`ok ${n}`); });
  });
  let upgrades = 0;
  server.on('upgrade', (_req, socket) => { upgrades++; socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n'); });
  server.on('connect', (_req, socket) => { socket.end('HTTP/1.1 200 Connection established\r\n\r\n'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  guard.install(pinPort ? { ...env, PORT: String(port) } : env, GuardedServer.prototype, options); // (the guard asks the server for its real port; PORT is only a fallback)
  const r: Rig = { port, hits, bodies, get upgrades() { return upgrades; }, close: () => new Promise((res) => server.close(() => res())) } as Rig;
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
  it('only 127.0.0.1:<port>, only that port; with no known port nothing is allowed', () => {
    expect(guard.isAllowedHost('127.0.0.1:3108')).toBe(false); // no port to compare with: closed
    expect(guard.isAllowedHost('127.0.0.1:3108', 0)).toBe(false);
    expect(guard.isAllowedHost('127.0.0.1:0', 0)).toBe(false);
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

  it('Expect: 100-continue: a refused request never gets «100 Continue» (wrong Host · another site), a good one does, and any other Expect value is a 417 as Node does it', async () => {
    const r = await rig();
    const post = (extra: string, host = `127.0.0.1:${r.port}`) => `POST /api/v2/x HTTP/1.1\r\nHost: ${host}\r\nExpect: 100-continue\r\nContent-Length: 5\r\nConnection: close\r\n${extra}\r\nhello`;
    const bad = await raw(r.port, post('', 'evil.example'));
    expect(bad).toContain('400 Bad Request');
    expect(bad).not.toContain('100 Continue');
    const cross = await raw(r.port, post('Sec-Fetch-Site: cross-site\r\n'));
    expect(cross).toContain('403 Forbidden');
    expect(cross).not.toContain('100 Continue');
    expect(r.hits).toEqual([]);
    const good = await raw(r.port, post(''));
    expect(good).toContain('100 Continue');
    expect(good).toContain('200 OK');
    expect(good).toContain('ok 5');
    const other = await raw(r.port, `POST /x HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nExpect: something-else\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    expect(status(other)).toBe('417');
    expect(r.hits).toEqual(['POST /api/v2/x']);
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

  it('the guard compares with the port the server is REALLY bound to, not with the PORT it was told: PORT=0, a wrong PORT or none at all make no difference', async () => {
    for (const envPort of ['0', '1', '99999', 'abc', undefined]) {
      const r = await rig({ SPRINTABLE_EMBEDDED: '1', ...(envPort === undefined ? {} : { PORT: envPort }) }, false);
      expect(status(await raw(r.port, get('/', `127.0.0.1:${r.port}`))), `PORT=${envPort}`).toBe('200'); // the real port: the app's own window works
      expect(status(await raw(r.port, get('/', envPort === '0' ? '127.0.0.1:0' : `127.0.0.1:${envPort ?? 1234}`))), `PORT=${envPort} · the told port`).toBe('400'); // a port nobody listens on is not a way in
    }
  });
});

describe('a request that another site makes through the person\'s browser', () => {
  const ok = (r: Rig) => `127.0.0.1:${r.port}`;

  it('Sec-Fetch-Site decides: same-origin and none pass; same-site · cross-site · anything unknown is a 403 and the app is never reached', async () => {
    const r = await rig();
    for (const [site, want] of [['same-origin', '200'], ['none', '200'], ['cross-site', '403'], ['same-site', '403'], ['', '403'], ['Cross-Site', '403'], ['same-origin, cross-site', '403']] as const) {
      expect(status(await raw(r.port, get('/', ok(r), `Sec-Fetch-Site: ${site}\r\n`))), `Sec-Fetch-Site: ${JSON.stringify(site)}`).toBe(want);
    }
    expect(r.hits).toHaveLength(2);
  });

  it('a top-level navigation from another site is refused as well (the app has no sender of such links)', async () => {
    const r = await rig();
    expect(status(await raw(r.port, get('/login', ok(r), 'Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n')))).toBe('403');
    expect(r.hits).toEqual([]);
  });

  it('a browser without Sec-Fetch is judged by Origin: only this server\'s own origin passes (also «null» is refused); a request with neither header is a tool and passes', async () => {
    const r = await rig();
    expect(status(await raw(r.port, get('/', ok(r), `Origin: http://127.0.0.1:${r.port}\r\n`)))).toBe('200');
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${r.port + 1}`, `http://localhost:${r.port}`, `https://127.0.0.1:${r.port}`]) {
      expect(status(await raw(r.port, get('/', ok(r), `Origin: ${origin}\r\n`))), origin).toBe('403');
    }
    expect(status(await raw(r.port, get('/', ok(r))))).toBe('200');
    expect(r.hits).toHaveLength(2);
  });

  it('Sec-Fetch-Site wins over Origin (a same-origin mark is not undone by an Origin, a cross-site mark is not rescued by one)', async () => {
    const r = await rig();
    expect(status(await raw(r.port, get('/', ok(r), `Sec-Fetch-Site: cross-site\r\nOrigin: http://127.0.0.1:${r.port}\r\n`)))).toBe('403');
    expect(status(await raw(r.port, get('/', ok(r), `Sec-Fetch-Site: same-origin\r\nOrigin: http://127.0.0.1:${r.port}\r\n`)))).toBe('200');
  });

  it('websocket upgrades from another site are refused too; the wrong Host is still a 400 before this check', async () => {
    const r = await rig();
    const up = (host: string, extra: string) => `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;
    expect(status(await raw(r.port, up(ok(r), 'Sec-Fetch-Site: cross-site\r\n')))).toBe('403');
    expect(status(await raw(r.port, up(ok(r), 'Origin: http://evil.example\r\n')))).toBe('403');
    expect(status(await raw(r.port, up('evil.example', 'Sec-Fetch-Site: cross-site\r\n')))).toBe('400');
    expect(status(await raw(r.port, up(ok(r), 'Sec-Fetch-Site: same-origin\r\n')))).toBe('101');
    expect(r.upgrades).toBe(1);
  });

  it('crossSiteRequest on its own', () => {
    expect(guard.crossSiteRequest({ headers: {} }, 3108)).toBe(false);
    expect(guard.crossSiteRequest({ headers: { 'sec-fetch-site': 'cross-site' } }, 3108)).toBe(true);
    expect(guard.crossSiteRequest({ headers: { origin: 'http://127.0.0.1:3108' } }, 3108)).toBe(false);
    expect(guard.crossSiteRequest({ headers: { origin: 'http://127.0.0.1:3108' } })).toBe(true); // no known port: no origin is «its own»
  });
});

describe('the memory that request bodies in flight can take', () => {
  const BUDGET = 1000;
  const head = (r: Rig, extra: string) => `POST /upload HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nConnection: close\r\n${extra}\r\n`;

  /** opens a request whose body is declared but not sent yet; resolves with a function that sends the rest and one that gives the answer */
  function stalled(r: Rig, declared: number): { finish: (rest: string) => void; answer: Promise<string> } {
    const s = net.connect(r.port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => { out += d.toString(); });
    const answer = new Promise<string>((resolve) => { s.on('close', () => resolve(out)); s.on('error', () => resolve(out)); });
    s.write(head(r, `Content-Length: ${declared}\r\n`) + 'x');
    return { finish: (rest: string) => { s.write(rest); }, answer };
  }

  it('a declared body is reserved when its headers arrive: past the budget the next one is a 503 before its body is read; when the first is done the reservation is back', async () => {
    const r = await rig({ SPRINTABLE_EMBEDDED: '1' }, true, { bodyBudget: BUDGET });
    const first = stalled(r, 700);
    await vi.waitFor(() => expect(r.hits).toEqual(['POST /upload'])); // the app has the first request: its 700 bytes are reserved
    const refused = await raw(r.port, head(r, 'Content-Length: 400\r\n') + 'y'.repeat(400));
    expect(status(refused)).toBe('503');
    expect(refused).toContain('Retry-After: 1');
    expect(r.hits).toEqual(['POST /upload']); // never reached
    const fits = stalled(r, 300);
    await vi.waitFor(() => expect(r.hits).toHaveLength(2)); // 700 + 300 = exactly the budget
    first.finish('x'.repeat(699)); fits.finish('z'.repeat(299));
    expect(await first.answer).toContain('ok 700');
    expect(await fits.answer).toContain('ok 300');
    const again = await raw(r.port, head(r, 'Content-Length: 900\r\n') + 'w'.repeat(900));
    expect(again).toContain('ok 900'); // the reservations were given back
  });

  it('a single body bigger than the whole budget is refused at once', async () => {
    const r = await rig({ SPRINTABLE_EMBEDDED: '1' }, true, { bodyBudget: BUDGET });
    expect(status(await raw(r.port, head(r, 'Content-Length: 1001\r\n') + 'q'.repeat(1001)))).toBe('503');
    expect(r.hits).toEqual([]);
  });

  it('a chunked body has no declared size: it is counted by the bytes that really arrive, passes untouched under the budget, and is cut off with 503 past it', async () => {
    const r = await rig({ SPRINTABLE_EMBEDDED: '1' }, true, { bodyBudget: BUDGET });
    const chunk = (n: number) => `${n.toString(16)}\r\n${'c'.repeat(n)}\r\n`;
    const under = await raw(r.port, head(r, 'Transfer-Encoding: chunked\r\n') + chunk(300) + chunk(200) + '0\r\n\r\n');
    expect(under).toContain('ok 500'); // every byte reached the app
    expect(r.bodies.at(-1)).toBe(500);
    const over = await raw(r.port, head(r, 'Transfer-Encoding: chunked\r\n') + chunk(600) + chunk(600) + '0\r\n\r\n');
    expect(status(over)).toBe('503');
    expect(over).not.toContain('ok 1200');
  });

  it('a chunked body\'s bytes count against the others in flight; they are given back at the end', async () => {
    const r = await rig({ SPRINTABLE_EMBEDDED: '1' }, true, { bodyBudget: BUDGET });
    const hold = stalled(r, 800);
    await vi.waitFor(() => expect(r.hits).toHaveLength(1));
    const chunk = (n: number) => `${n.toString(16)}\r\n${'c'.repeat(n)}\r\n`;
    const squeezed = await raw(r.port, head(r, 'Transfer-Encoding: chunked\r\n') + chunk(150) + chunk(150) + '0\r\n\r\n'); // 800 + 300 > 1000
    expect(status(squeezed)).toBe('503');
    hold.finish('h'.repeat(799));
    await hold.answer;
    const after = await raw(r.port, head(r, 'Transfer-Encoding: chunked\r\n') + chunk(150) + chunk(150) + '0\r\n\r\n');
    expect(after).toContain('ok 300');
  });

  it('a body of any kind is the same bytes at the app as were sent (the counting does not touch the data) — binary, both ways of sending it', async () => {
    const r = await rig({ SPRINTABLE_EMBEDDED: '1' }, true, { bodyBudget: 1_000_000 });
    const payload = Buffer.alloc(70_000); for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
    const send = (headers: string, bodyBuf: Buffer): Promise<string> => new Promise((resolve) => {
      const s = net.connect(r.port, '127.0.0.1'); let out = '';
      s.on('data', (d) => { out += d.toString('latin1'); }); s.on('close', () => resolve(out));
      s.write(head(r, headers)); s.write(bodyBuf);
    });
    expect(await send(`Content-Length: ${payload.length}\r\n`, payload)).toContain('ok 70000');
    const framed = Buffer.concat([Buffer.from(`${payload.length.toString(16)}\r\n`), payload, Buffer.from('\r\n0\r\n\r\n')]);
    expect(await send('Transfer-Encoding: chunked\r\n', framed)).toContain('ok 70000');
    expect(r.bodies).toEqual([70000, 70000]);
  });

  it('a request that is refused before any body (wrong Host · another site) reserves nothing', async () => {
    const r = await rig({ SPRINTABLE_EMBEDDED: '1' }, true, { bodyBudget: BUDGET });
    for (let i = 0; i < 5; i++) {
      expect(status(await raw(r.port, `POST /x HTTP/1.1\r\nHost: evil.example\r\nContent-Length: 900\r\nConnection: close\r\n\r\n${'e'.repeat(900)}`))).toBe('400');
      expect(status(await raw(r.port, head(r, 'Sec-Fetch-Site: cross-site\r\nContent-Length: 900\r\n') + 'e'.repeat(900)))).toBe('403');
    }
    expect(await raw(r.port, head(r, 'Content-Length: 900\r\n') + 'g'.repeat(900))).toContain('ok 900');
  });

  it('an over-budget request with Expect: 100-continue is refused before «100 Continue» and its body is never asked for', async () => {
    const r = await rig({ SPRINTABLE_EMBEDDED: '1' }, true, { bodyBudget: BUDGET });
    const out = await raw(r.port, head(r, 'Expect: 100-continue\r\nContent-Length: 5000\r\n'));
    expect(status(out)).toBe('503');
    expect(out).not.toContain('100 Continue');
  });
});
