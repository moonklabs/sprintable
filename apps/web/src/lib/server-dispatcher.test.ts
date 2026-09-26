// story #4299 AC2 — BFF 서버 fetch 공유 연결 풀. 실 로컬 TLS 서버(자체 서명 인증서 · openssl로 테스트마다 새로) + **실 전역 fetch**로
// «Node 내장 fetch가 npm undici 디스패처를 실제로 쓴다» · «백엔드 origin만 h2 · h2에서만 한 연결에 동시 요청» ·
// «h1 백엔드는 파이프라인 없음 — 끝나지 않는 응답(SSE)이 열려 있어도 다른 요청이 끝난다» ·
// «외부 h1 origin은 파이프라인 없음» · «keep-alive가 기본 4초를 넘어 산다» · «계측 spans에 협상 판(h2/h1)» ·
// «설치는 한 번 · 백엔드 origin은 fastapiBaseUrl()»을 새 연결 수로 잰다.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

import { BFF_KEEPALIVE_MS, createBffDispatcher, installBffDispatcher, installedBackendOrigin } from './server-dispatcher';
import { withServerTiming } from './server-timing';

let cert: Buffer;
let key: Buffer;
let tmp = '';
// 서버마다 새 TLS 연결 수 · 받은 요청의 HTTP 판
type Srv = { url: string; conns: () => number; close: () => Promise<void> };
let backend: Srv; // h2 전용(백엔드 run.app처럼 ALPN h2)
let extH1: Srv; // h1 전용 · keep-alive 힌트 없음(유휴로 안 끊음) — GFE처럼 Keep-Alive 헤더를 안 준다
let extH2: Srv; // h2도 되는 외부 서버(외부 origin엔 h2를 안 쓰는지)
let inflight = 0;
let maxInflight = 0;

const reply = (req: { httpVersion: string }, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }) =>
  setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ v: req.httpVersion })); }, 40);

async function listen(server: https.Server | http2.Http2SecureServer): Promise<Srv> {
  let n = 0;
  // 닫을 때 살아 있는 TLS 연결(keep-alive · h2 세션)을 직접 끊는다 — 풀이 연결을 오래 살려 두므로 server.close()만으로는
  // 연결이 끝나길 기다리다 멈춘다(CI Node 22에서 afterAll 10초 초과).
  const sockets = new Set<{ destroy: () => void }>();
  server.on('secureConnection', (sock: { destroy: () => void; once: (e: string, f: () => void) => void }) => {
    n += 1;
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    conns: () => n,
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      for (const sock of sockets) sock.destroy();
    }),
  };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-disp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  key = fs.readFileSync(path.join(tmp, 'key.pem'));
  cert = fs.readFileSync(path.join(tmp, 'cert.pem'));
  const b = http2.createSecureServer({ key, cert });
  // 백엔드는 동시에 처리 중인 요청 수의 최댓값도 센다 — 연결 상한 4에서도 한 연결에 여러 요청이 동시에 실리는지(파이프라인).
  b.on('request', (req, res) => {
    inflight += 1; maxInflight = Math.max(maxInflight, inflight);
    res.on('finish', () => { inflight -= 1; });
    reply(req, res);
  });
  backend = await listen(b);
  const h1 = https.createServer({ key, cert }, reply);
  h1.keepAliveTimeout = 0; // 0 = Keep-Alive 힌트 헤더 없음 · 유휴로 안 닫음(끊기는 쪽은 클라이언트 keep-alive만)
  extH1 = await listen(h1);
  const e2 = http2.createSecureServer({ key, cert, allowHTTP1: true });
  e2.on('request', reply);
  extH2 = await listen(e2);
});

afterAll(async () => {
  await Promise.all([backend.close(), extH1.close(), extH2.close()]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

let prev: Dispatcher | null = null;
// 테스트가 만든 디스패처 — 끝날 때 destroy해 연결을 정리한다(서버를 닫기 전에).
const made: Dispatcher[] = [];
function track<T extends Dispatcher>(d: T): T {
  made.push(d);
  return d;
}
function swapDispatcher(d: Dispatcher) {
  prev = prev ?? getGlobalDispatcher();
  setGlobalDispatcher(track(d));
}
afterEach(async () => {
  if (prev) setGlobalDispatcher(prev);
  prev = null;
  delete process.env['NEXT_PUBLIC_FASTAPI_URL'];
  await Promise.all(made.splice(0).map((d) => d.destroy().catch(() => {})));
});

/** 실 전역 fetch로 n건을 동시에 — 새로 연 연결 수와 받은 HTTP 판(겹치지 않게 모음). */
async function burst(srv: Srv, n: number) {
  const before = srv.conns();
  const versions = await Promise.all(Array.from({ length: n }, () => fetch(`${srv.url}/x`, { cache: 'no-store' }).then((r) => r.json() as Promise<{ v: string }>).then((j) => j.v)));
  return { newConns: srv.conns() - before, versions: [...new Set(versions)] };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const testAgent = () => createBffDispatcher(backend.url, { connect: { ca: cert } });

describe('전역 fetch ↔ npm undici 디스패처', () => {
  it('Node 내장 fetch가 setGlobalDispatcher한 디스패처를 실제로 쓴다(dispatch 호출 수)', async () => {
    const agent = testAgent();
    let calls = 0;
    const orig = agent.dispatch.bind(agent);
    agent.dispatch = ((opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => { calls += 1; return orig(opts, handler); }) as typeof agent.dispatch;
    swapDispatcher(agent);
    await burst(backend, 3);
    expect(calls).toBe(3);
  });
});

describe('백엔드 origin — h2에서만 한 연결에 동시 요청', () => {
  it('따뜻한 풀: 이미 열린 연결에 동시 32건을 싣는다(새 연결 0 · h2)', async () => {
    swapDispatcher(testAgent());
    await burst(backend, 16);
    expect(await burst(backend, 32)).toEqual({ newConns: 0, versions: ['2.0'] });
  });

  it('따뜻한 풀에서 동시 32건이 한꺼번에 처리된다(백엔드가 동시에 처리 중인 수 = 32 — h2 스트림)', async () => {
    swapDispatcher(testAgent());
    await burst(backend, 16);
    maxInflight = 0;
    await burst(backend, 32);
    expect(maxInflight).toBe(32);
  });
});

describe('외부 origin — keep-alive만(h2 · 파이프라인 없음)', () => {
  it('외부 h1 origin은 파이프라인 없음: 동시 6건 = 연결 6', async () => {
    swapDispatcher(testAgent());
    const r = await burst(extH1, 6);
    expect(r).toEqual({ newConns: 6, versions: ['1.1'] });
  });

  it('외부 origin은 h2가 되는 서버여도 h1(백엔드만 h2)', async () => {
    swapDispatcher(testAgent());
    const r = await burst(extH2, 2);
    expect(r.versions).toEqual(['1.1']);
  });

  it(`keep-alive ${BFF_KEEPALIVE_MS / 1000}초 — 기본(4초)을 넘겨 4.5초 쉬어도 같은 연결(양성 대조: 기본 Agent는 새로 연다)`, async () => {
    swapDispatcher(testAgent());
    await burst(extH1, 1);
    await sleep(4_500);
    expect((await burst(extH1, 1)).newConns).toBe(0);
    // 양성 대조 — 같은 측정으로 기본 설정(keep-alive 4초)은 새 연결을 연다(측정이 틀릴 수 있어야 한다).
    setGlobalDispatcher(track(new Agent({ connect: { ca: cert } })));
    await burst(extH1, 1);
    await sleep(4_500);
    expect((await burst(extH1, 1)).newConns).toBe(1);
  }, 20_000);
});

describe('협상 판(proto) — 계측 spans에 h2/h1', () => {
  it('백엔드(h2) 호출은 proto=h2 · 외부 h1 호출은 proto=h1 — h1으로 내려가면 재측 · 로그에서 바로 보인다', async () => {
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    try {
      swapDispatcher(testAgent());
      const { spans } = await withServerTiming(async () => {
        await fetch(`${backend.url}/api/v2/me`).then((r) => r.text());
        await fetch(`${extH1.url}/x`).then((r) => r.text());
      });
      expect(spans.map((sp) => sp.proto)).toEqual(['h2', 'h1']);
    } finally {
      delete process.env['SERVER_TIMING_MARKERS'];
    }
  });
});

// 운영 설치엔 연결 상한이 없어 풀 줄이 안 생기지만, 줄이 생기면(상한 · 앞으로의 설정) undici가 줄 선 요청을 남의 연결 콜백 문맥에서
// 만든다 — 그래도 계측 범위가 맞는지를 테스트용 상한(backendConnections)으로 줄을 일부러 만들어 잰다.
const QUEUE_CAP = 4;
const queueingAgent = () => createBffDispatcher(backend.url, { connect: { ca: cert }, backendConnections: QUEUE_CAP });

describe('풀 줄에 선 요청도 제 계측 범위에 적힌다', () => {
  it(`범위 16개가 동시에 부르면(테스트용 상한 ${QUEUE_CAP}) 범위마다 자기 호출 1건 — 줄 선 요청이 첫 요청 범위에 몰리지 않는다`, async () => {
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    try {
      swapDispatcher(queueingAgent());
      const results = await Promise.all(Array.from({ length: 16 }, () =>
        withServerTiming(async () => { await fetch(`${backend.url}/api/v2/labels`).then((r) => r.text()); })));
      expect(results.map((r) => r.spans.length)).toEqual(Array(16).fill(1));
      expect(results.filter((r) => r.spans[0]!.newConnection === true)).toHaveLength(QUEUE_CAP); // 줄이 실제로 생겼다(양성 대조)
      // 줄 선 요청은 연결을 기다린 시간이 대기(wait)에 든다(연결이 열릴 때까지).
      expect(Math.max(...results.map((r) => r.spans[0]!.waitMs ?? 0))).toBeGreaterThan(0);
    } finally {
      delete process.env['SERVER_TIMING_MARKERS'];
    }
  });
});

describe('번들 사본이 여러 벌이어도 계측 상태는 하나', () => {
  // Next prod 빌드는 server-timing을 middleware · instrumentation(연결 풀) · 라우트 청크에 따로 싣는다(세 벌 실측).
  // 연결 풀 쪽 사본이 적은 디스패치 범위를 라우트 쪽 사본(여기선 이 파일 맨 위 import)이 읽어야 한다.
  it('다른 모듈 사본의 연결 풀로 줄 선 요청 16건도 이 사본의 범위마다 1건씩', async () => {
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    try {
      vi.resetModules();
      const other = await import('./server-dispatcher'); // 새 server-timing 사본을 끌고 온다
      swapDispatcher(other.createBffDispatcher(backend.url, { connect: { ca: cert }, backendConnections: QUEUE_CAP }));
      const results = await Promise.all(Array.from({ length: 16 }, () =>
        withServerTiming(async () => { await fetch(`${backend.url}/api/v2/labels`).then((r) => r.text()); })));
      expect(results.map((r) => r.spans.length)).toEqual(Array(16).fill(1));
    } finally {
      delete process.env['SERVER_TIMING_MARKERS'];
    }
  });
});

describe('h1 백엔드(평문 CI · 로컬 · 자체 호스트)는 파이프라인 없음', () => {
  // REALTIME_URL이 비면 SSE(/api/event-stream)도 백엔드 origin으로 간다. h1에서 파이프라인을 걸면 끝나지 않는 응답 뒤에 다른 요청이
  // 줄 서서 영영 안 끝난다(4699 CI Contrast guard가 prod next start에서 14분 멈춤).
  it('끝나지 않는 응답(SSE) 5개가 열려 있어도 같은 origin의 다른 16건은 끝난다(파이프라인 · 연결 상한이 있으면 막힘)', async () => {
    const plain = http.createServer((req, res) => {
      if (req.url === '/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': open\n\n'); return; } // 안 끝냄
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, 20);
    });
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    const socks = new Set<{ destroy: () => void }>();
    plain.on('connection', (sk) => { socks.add(sk); sk.once('close', () => socks.delete(sk)); });
    const ctrl = new AbortController();
    try {
      swapDispatcher(createBffDispatcher(origin)); // 백엔드 origin = 평문 h1 · 운영 설치와 같은 옵션(상한 없음)
      const sses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${origin}/sse`, { signal: ctrl.signal }))); // 헤더만 · 본문은 열린 채
      expect(sses.map((x) => x.status)).toEqual(Array(5).fill(200));
      const done = Promise.all(Array.from({ length: 16 }, () => fetch(`${origin}/x`).then((r) => r.text())));
      const r = await Promise.race([done.then(() => 'done'), sleep(3_000).then(() => 'stuck')]);
      expect(r).toBe('done');
    } finally {
      ctrl.abort();
      for (const sk of socks) sk.destroy();
      await new Promise<void>((r) => plain.close(() => r()));
    }
  });
});

describe('만들어지기 전에 끝난 요청은 줄에서 바로 빠진다', () => {
  it('같은 경로 둘 중 먼저 것이 만들어지기 전에 오류로 끝나면, 뒤 것은 자기 범위에 적힌다', async () => {
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    try {
      const agent = testAgent();
      swapDispatcher(agent);
      const origin = backend.url;
      // A: 헤더 값이 잘못돼 undici가 요청을 만들기 전에 오류로 끝난다(request:create 없음 · handler 오류 콜백만).
      const a = await withServerTiming(() => new Promise<unknown>((resolve) => {
        agent.dispatch({ origin, path: '/api/v2/labels', method: 'GET', headers: { 'x-bad': 'a\nb' } }, {
          onConnect() {}, onHeaders() { return true; }, onData() { return true; }, onComplete() { resolve(null); },
          onError(err: Error) { resolve(err); },
        } as unknown as Dispatcher.DispatchHandler);
      }));
      expect(a.value).toBeInstanceOf(Error);
      expect(a.spans).toHaveLength(0);
      // B: 같은 (origin · method · path) — A의 기록을 꺼내 A 범위에 적히면 안 된다.
      const b = await withServerTiming(async () => { await fetch(`${origin}/api/v2/labels`).then((r) => r.text()); });
      expect(b.spans).toHaveLength(1);
      expect(a.spans).toHaveLength(0);
    } finally {
      delete process.env['SERVER_TIMING_MARKERS'];
    }
  });
});

describe('installBffDispatcher — 한 번 · 백엔드 origin은 fastapiBaseUrl()', () => {
  it('설치하면 전역 디스패처가 바뀌고, 두 번 불러도 같은 것 · 백엔드 origin = NEXT_PUBLIC_FASTAPI_URL', () => {
    prev = getGlobalDispatcher();
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'https://backend.example.run.app/some/base';
    expect(installedBackendOrigin()).toBeNull();
    const a = track(installBffDispatcher());
    expect(getGlobalDispatcher()).toBe(a);
    expect(installBffDispatcher()).toBe(a);
    expect(installedBackendOrigin()).toBe('https://backend.example.run.app');
  });
});
