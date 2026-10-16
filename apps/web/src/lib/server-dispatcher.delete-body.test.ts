// story #4723 — 본문이 있는 DELETE가 백엔드에 «길이와 함께» 닿는다. undici h2는 DELETE에 content-length를 안 달아(client-h2.js
// expectsPayload = PUT · POST · PATCH만) 길이 없는 h2 DATA가 Cloud Run 앞단을 지나며 «본문 없음»이 됐다(dev 실측: 설정 → 조직 삭제 422
// body missing). 이 파일은 실 로컬 TLS 서버(h2 + h1 둘 다 되는 백엔드 — Cloud Run처럼) + 실 전역 fetch로 잰다:
// «본문 있는 DELETE = content-length 있음 · 본문 그대로» · «다른 메서드 · 본문 없는 DELETE는 그대로 h2» · «프록시 경유 조직 삭제 라우트도».
// 되돌리면(server-dispatcher.ts의 h1 경로를 빼면) 첫 시험이 RED — DELETE의 content-length가 null이 된다.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Agent, Dispatcher } from 'undici';

const { getServerSessionMock, getLocaleMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn(),
  getLocaleMock: vi.fn(),
}));
vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));
vi.mock('@/i18n/request', () => ({ getLocale: getLocaleMock }));

import { createBffDispatcher, isBodyDeleteToBackend } from './server-dispatcher';

type Seen = { method: string; url: string; v: string; contentLength: string | undefined; body: string };
let cert: Buffer;
let tmp = '';
let server: http2.Http2SecureServer;
let url = '';
let seen: Seen[] = [];
const sockets = new Set<{ destroy: () => void }>();

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-del-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  cert = fs.readFileSync(path.join(tmp, 'cert.pem'));
  // h2도 h1도 되는 백엔드(Cloud Run 앞단이 두 판을 다 받는 것과 같다)
  server = http2.createSecureServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert, allowHTTP1: true });
  server.on('secureConnection', (s: { destroy: () => void; once: (e: string, f: () => void) => void }) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  server.on('request', (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, v: req.httpVersion, contentLength: req.headers['content-length'], body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { ok: true } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

let prev: Dispatcher | null = null;
const made: Dispatcher[] = [];
function use(): Dispatcher {
  prev = prev ?? getGlobalDispatcher();
  const d = createBffDispatcher(url, { connect: { ca: cert } });
  made.push(d);
  setGlobalDispatcher(d);
  process.env['NEXT_PUBLIC_FASTAPI_URL'] = url;
  seen = [];
  return d;
}
afterEach(async () => {
  if (prev) setGlobalDispatcher(prev);
  prev = null;
  delete process.env['NEXT_PUBLIC_FASTAPI_URL'];
  await Promise.all(made.splice(0).map((d) => d.destroy().catch(() => {})));
});

const BODY = JSON.stringify({ confirmation: 'dam-del-check', confirm_without_impact: false });
const JSON_HDR = { 'Content-Type': 'application/json' };

describe('본문 있는 DELETE — 길이와 함께 닿는다', () => {
  it('DELETE + JSON 본문: 백엔드가 content-length와 본문을 그대로 받는다', async () => {
    use();
    const res = await fetch(`${url}/api/v2/organizations/o1`, { method: 'DELETE', headers: JSON_HDR, body: BODY });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/api/v2/organizations/o1', contentLength: String(BODY.length), body: BODY });
  });

  it('본문 있는 DELETE를 연달아 보내도(같은 h1 연결 재사용) 매번 길이 · 본문이 닿는다', async () => {
    use();
    for (let i = 0; i < 3; i += 1) {
      const b = JSON.stringify({ story_ids: [`s${i}`] });
      await fetch(`${url}/api/v2/hypotheses/h/links`, { method: 'DELETE', headers: JSON_HDR, body: b });
      expect(seen[i]).toMatchObject({ contentLength: String(b.length), body: b });
    }
  });
});

describe('그 밖은 그대로 — 다른 메서드 · 본문 없는 DELETE는 h2', () => {
  it('본문 없는 DELETE · 빈 문자열 본문 DELETE(프록시가 DELETE에도 text()를 싣는다) · GET · POST · PATCH는 h2 그대로', async () => {
    use();
    await fetch(`${url}/a`, { method: 'DELETE' });
    await fetch(`${url}/b`, { method: 'DELETE', headers: JSON_HDR, body: '' });
    await fetch(`${url}/c`, { method: 'GET' });
    await fetch(`${url}/d`, { method: 'POST', headers: JSON_HDR, body: BODY });
    await fetch(`${url}/e`, { method: 'PATCH', headers: JSON_HDR, body: BODY });
    expect(seen.map((s) => [s.method, s.url, s.v])).toEqual([
      ['DELETE', '/a', '2.0'], ['DELETE', '/b', '2.0'], ['GET', '/c', '2.0'], ['POST', '/d', '2.0'], ['PATCH', '/e', '2.0'],
    ]);
    expect(seen[3]).toMatchObject({ contentLength: String(BODY.length), body: BODY });
    expect(seen[4]).toMatchObject({ contentLength: String(BODY.length), body: BODY });
  });

  it('분류: 백엔드 origin의 본문 있는 DELETE만 h1', () => {
    const b = 'https://be.test';
    const o = (method: string, body: unknown, origin = b) => ({ method, body, origin, path: '/x' }) as unknown as Dispatcher.DispatchOptions;
    expect(isBodyDeleteToBackend(o('DELETE', '{"a":1}'), b)).toBe(true);
    expect(isBodyDeleteToBackend(o('delete', Buffer.from('x')), b)).toBe(true);
    expect(isBodyDeleteToBackend(o('DELETE', ''), b)).toBe(false);
    expect(isBodyDeleteToBackend(o('DELETE', null), b)).toBe(false);
    // 전역 fetch가 넘기는 모양: 본문 `''` = 스트림 + content-length 0(본문 없음) · 'abc' = 스트림 + content-length 3
    const stream = (async function* () { yield Buffer.from(''); })();
    expect(isBodyDeleteToBackend({ ...o('DELETE', stream), headers: { 'content-length': '0' } } as Dispatcher.DispatchOptions, b)).toBe(false);
    expect(isBodyDeleteToBackend({ ...o('DELETE', stream), headers: ['Content-Length', '3'] } as Dispatcher.DispatchOptions, b)).toBe(true);
    expect(isBodyDeleteToBackend({ ...o('DELETE', stream), headers: { 'Content-Type': 'application/json' } } as Dispatcher.DispatchOptions, b)).toBe(true); // 길이 모르는 스트림
    expect(isBodyDeleteToBackend(o('POST', '{"a":1}'), b)).toBe(false);
    expect(isBodyDeleteToBackend(o('DELETE', '{"a":1}', 'https://other.test'), b)).toBe(false);
    expect(isBodyDeleteToBackend(o('DELETE', '{"a":1}'), null)).toBe(false);
  });
});

describe('닫는 일 · 머리 · 빈 본문 (codex 검수 반영)', () => {
  it('h1 쪽까지 닫힌다: 본문 있는 DELETE 뒤 destroy하면 그 h1 연결도 끊기고, 부순 뒤의 본문 DELETE는 새 h1을 만들지 않고 오류로 끝난다', async () => {
    const d = use();
    await fetch(`${url}/api/v2/organizations/o1`, { method: 'DELETE', headers: JSON_HDR, body: BODY });
    expect(seen).toHaveLength(1);
    await d.destroy();
    const before = seen.length;
    await expect(fetch(`${url}/api/v2/organizations/o2`, { method: 'DELETE', headers: JSON_HDR, body: BODY })).rejects.toBeTruthy();
    expect(seen.length).toBe(before);
  });

  it('부순 뒤 첫 본문 DELETE는 h1을 새로 만들어 보내지 않고 오류로 끝난다(닫힌 뒤 새는 연결 없음)', async () => {
    const d = use();
    await d.destroy();
    await expect(fetch(`${url}/api/v2/organizations/o3`, { method: 'DELETE', headers: JSON_HDR, body: BODY })).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it('닫는 중(destroy를 부른 바로 그 순간)에 직접 dispatch한 본문 DELETE도 h2로 새지 않는다 — 본문 없이 가지 않고 «닫힘» 오류로 끝난다', async () => {
    const d = use();
    const pending = d.destroy(); // 기다리지 않는다 — 같은 틱에서 바로 dispatch
    const errors: Error[] = [];
    d.dispatch(
      { origin: url, path: '/api/v2/organizations/o4', method: 'DELETE', headers: { 'content-type': 'application/json', 'content-length': String(BODY.length) }, body: BODY },
      { onConnect: () => {}, onHeaders: () => true, onData: () => true, onComplete: () => {}, onError: (e: Error) => { errors.push(e); } } as unknown as Dispatcher.DispatchHandler,
    );
    await pending;
    await new Promise((r) => setTimeout(r, 300));
    expect(errors).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it('close도 콜백 판 · promise 판 둘 다 끝난다(자기 자신을 끝없이 부르지 않는다)', async () => {
    const d1 = use() as Agent;
    await fetch(`${url}/x`, { method: 'DELETE', headers: JSON_HDR, body: BODY });
    await d1.close();
    expect(d1.closed).toBe(true);
    const d2 = createBffDispatcher(url, { connect: { ca: cert } });
    made.push(d2);
    setGlobalDispatcher(d2);
    await fetch(`${url}/y`, { method: 'DELETE', headers: JSON_HDR, body: BODY }); // h1 쪽을 실제로 만든 뒤 콜백 판으로 닫는다
    await new Promise<void>((resolve) => { d2.close(() => resolve()); });
    expect(d2.closed).toBe(true);
    await expect(fetch(`${url}/z`, { method: 'DELETE', headers: JSON_HDR, body: BODY })).rejects.toBeTruthy();
  });

  it('한 번 읽으면 끝나는 머리(제너레이터)는 분류가 읽지 않는다 — 읽으면 undici가 받을 머리가 사라진다', () => {
    const b = 'https://be.test';
    let reads = 0;
    const gen = (function* () { reads += 1; yield ['content-type', 'application/json']; })();
    const opts = { method: 'DELETE', body: '{"a":1}', origin: b, path: '/x', headers: gen } as unknown as Dispatcher.DispatchOptions;
    expect(isBodyDeleteToBackend(opts, b)).toBe(true);
    expect([...gen]).toEqual([['content-type', 'application/json']]); // 분류 뒤에도 그대로 남아 있다
    expect(reads).toBe(1);
  });

  it('빈 Buffer · 빈 Uint8Array 본문 DELETE는 본문 없음(h2 그대로)', () => {
    const b = 'https://be.test';
    const o = (body: unknown) => ({ method: 'DELETE', body, origin: b, path: '/x' }) as unknown as Dispatcher.DispatchOptions;
    expect(isBodyDeleteToBackend(o(Buffer.alloc(0)), b)).toBe(false);
    expect(isBodyDeleteToBackend(o(new Uint8Array(0)), b)).toBe(false);
    expect(isBodyDeleteToBackend(o(Buffer.from('x')), b)).toBe(true);
  });
});

describe('프록시 경유 — 설정 → 조직 삭제 라우트', () => {
  it('DELETE /api/organizations/{id}: 브라우저가 보낸 본문이 길이와 함께 /api/v2/organizations/{id}에 닿는다', async () => {
    use();
    getLocaleMock.mockResolvedValue('ko');
    const { DELETE } = await import('@/app/api/organizations/[id]/route');
    const req = new Request('https://app.test/api/organizations/org-1', {
      method: 'DELETE', headers: { ...JSON_HDR, Authorization: 'Bearer t' }, body: BODY,
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'org-1' }) });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/api/v2/organizations/org-1', contentLength: String(BODY.length), body: BODY });
  });

  it('가설 연결 해제(storage-api 경유 · 웹 서버 내부 호출): 본문이 길이와 함께 /api/v2/hypotheses/{id}/links에 닿는다', async () => {
    use();
    const { ApiHypothesisRepository } = await import('@sprintable/storage-api');
    await new ApiHypothesisRepository('tok').unlink('h1', { story_ids: ['s1'] } as never);
    const b = JSON.stringify({ story_ids: ['s1'] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/api/v2/hypotheses/h1/links', contentLength: String(b.length), body: b });
  });
});
