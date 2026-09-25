// story #4299 — BFF route handler 구간 계측(dev 전용 · SERVER_TIMING_MARKERS). 실 로컬 HTTP 서버 + 실 fetch(keep-alive)로
// «꺼져 있으면 오버헤드 0(타이머 · 계측 범위 · 로그 · 헤더 전부 0)» · «켜면 구간 · 연결 판정 · 미들웨어 몫이 맞게 실린다» ·
// «헤더 · 로그에 경로 · id가 안 샌다»를 잰다.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { getServerSessionMock, getLocaleMock, startRouteTimerSpy, withServerTimingSpy } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn(),
  getLocaleMock: vi.fn(),
  startRouteTimerSpy: vi.fn(),
  withServerTimingSpy: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));
vi.mock('@/i18n/request', () => ({ getLocale: getLocaleMock }));
vi.mock('@/lib/server-timing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./server-timing')>();
  return {
    ...actual,
    startRouteTimer: (...args: Parameters<typeof actual.startRouteTimer>) => { startRouteTimerSpy(); return actual.startRouteTimer(...args); },
    withServerTiming: <T,>(fn: () => Promise<T>) => { withServerTimingSpy(); return actual.withServerTiming(fn); },
  };
});

import { proxyToFastapi, proxyToFastapiWithParams } from './fastapi-proxy';
import { MW_T0_HEADER, routeKindForPath } from './server-timing';

const ID = '6f1c2e0a-1b2c-4d5e-8f90-123456789abc';
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); }, 30);
  });
  server.keepAliveTimeout = 5000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env['NEXT_PUBLIC_FASTAPI_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  delete process.env['NEXT_PUBLIC_FASTAPI_URL'];
  await new Promise<void>((r) => server.close(() => r()));
});

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getServerSessionMock.mockReset();
  getLocaleMock.mockReset();
  getLocaleMock.mockResolvedValue('ko');
  startRouteTimerSpy.mockReset();
  withServerTimingSpy.mockReset();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env['SERVER_TIMING_MARKERS'];
  logSpy.mockRestore();
});

const keyRequest = (path: string, extra: Record<string, string> = {}) =>
  new Request(`https://app.example.com${path}`, { headers: { Authorization: 'Bearer sk_test', ...extra } });

const timingLogs = () => logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"server_timing"'));

// 까디르 4652 — «타이밍 로그만 걸러 없음»이 아니라 호출 자체가 0인지를 직접 잰다: console.log 호출 0 · Server-Timing 없음 ·
// undici 채널 구독 0. 새 모듈로(구독 여부는 모듈 상태라 앞 테스트가 이미 구독했으면 안 보인다) 같은 측정을 켜짐에도 돌려 셋 다
// 잡히는 것을 옆에 둔다(양성 대조 — 측정이 틀릴 수 있어야 한다).
describe('꺼짐 호출 0 직접 단언 + 켜짐 양성 대조(새 모듈)', () => {
  async function freshRun(enabled: boolean) {
    vi.resetModules();
    if (enabled) process.env['SERVER_TIMING_MARKERS'] = 'true';
    else delete process.env['SERVER_TIMING_MARKERS'];
    const dc = (await import('node:diagnostics_channel')).default;
    const subSpy = vi.spyOn(dc, 'subscribe');
    try {
      const fresh = await import('./fastapi-proxy');
      logSpy.mockClear();
      const res = await fresh.proxyToFastapi(keyRequest('/api/labels'), '/api/v2/labels');
      const body = await res.text();
      return { logs: logSpy.mock.calls.length, header: res.headers.get('Server-Timing'), subs: subSpy.mock.calls.length, body };
    } finally {
      subSpy.mockRestore();
    }
  }

  it('꺼짐: console.log 0 · Server-Timing 없음 · undici 구독 0 · 본문 그대로', async () => {
    expect(await freshRun(false)).toEqual({ logs: 0, header: null, subs: 0, body: '[]' });
  });

  it('양성 대조 — 켜짐: 같은 측정이 로그 · 헤더 · 구독을 모두 잡는다', async () => {
    const r = await freshRun(true);
    expect(r.logs).toBeGreaterThan(0);
    expect(r.header).toMatch(/^bff;dur=\d+/);
    expect(r.subs).toBeGreaterThan(0);
    expect(r.body).toBe('[]');
  });
});

describe('꺼져 있으면(기본 · prod) 오버헤드 0', () => {
  it('타이머 · 계측 범위 · 로그 · 헤더 전부 0 — 응답은 그대로', async () => {
    const res = await proxyToFastapi(keyRequest('/api/labels'), '/api/v2/labels');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[]');
    expect(res.headers.get('Server-Timing')).toBeNull();
    expect(startRouteTimerSpy).not.toHaveBeenCalled();
    expect(withServerTimingSpy).not.toHaveBeenCalled();
    expect(timingLogs()).toEqual([]);
  });

  it('클라이언트가 미들웨어 시각 헤더를 보내도 꺼져 있으면 아무것도 안 낸다', async () => {
    const res = await proxyToFastapi(keyRequest('/api/labels', { [MW_T0_HEADER]: String(Date.now() - 500) }), '/api/v2/labels');
    expect(res.headers.get('Server-Timing')).toBeNull();
    expect(startRouteTimerSpy).not.toHaveBeenCalled();
  });

  it('SERVER_TIMING_MARKERS가 "true" 말고 다른 값이면 꺼짐', async () => {
    process.env['SERVER_TIMING_MARKERS'] = '1';
    const res = await proxyToFastapi(keyRequest('/api/labels'), '/api/v2/labels');
    expect(res.headers.get('Server-Timing')).toBeNull();
    expect(startRouteTimerSpy).not.toHaveBeenCalled();
  });
});

function parse(header: string | null): Map<string, { dur: number; desc?: string }> {
  const out = new Map<string, { dur: number; desc?: string }>();
  for (const part of (header ?? '').split(', ')) {
    const [name, ...params] = part.split(';');
    const dur = Number(params.find((p) => p.startsWith('dur='))?.slice(4));
    const desc = params.find((p) => p.startsWith('desc='))?.slice(6, -1);
    out.set(name!, { dur, desc });
  }
  return out;
}

describe('켜면(dev) 구간 · 연결 판정 · 미들웨어 몫', () => {
  beforeEach(() => { process.env['SERVER_TIMING_MARKERS'] = 'true'; });

  it('구간 다섯 + 백엔드 호출 한 칸이 순서대로 · 구간 합 ≤ 합계 · 백엔드 첫 바이트가 서버 지연(30ms)을 담는다', async () => {
    const res = await proxyToFastapi(keyRequest('/api/labels'), '/api/v2/labels');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[]');
    const t = parse(res.headers.get('Server-Timing'));
    expect([...t.keys()]).toEqual(['bff', 'bff_auth', 'bff_locale', 'bff_reqbody', 'bff_be_ttfb', 'bff_be_body', 'be0-other']);
    const sum = ['bff_auth', 'bff_locale', 'bff_reqbody', 'bff_be_ttfb', 'bff_be_body'].reduce((a, k) => a + t.get(k)!.dur, 0);
    expect(sum).toBeLessThanOrEqual(t.get('bff')!.dur + 5); // 칸마다 반올림
    expect(t.get('bff_be_ttfb')!.dur).toBeGreaterThanOrEqual(25);
    expect(t.get('be0-other')!.desc).toMatch(/^t\+\d+ wait=\d+ conn=(new|reuse)$/);
    expect(startRouteTimerSpy).toHaveBeenCalledTimes(1);
  });

  it('같은 연결을 다시 쓰면 conn=reuse — 동시 요청 때 새 연결을 여는지 가르는 칸', async () => {
    await (await proxyToFastapi(keyRequest('/api/labels'), '/api/v2/labels')).text();
    const res = await proxyToFastapi(keyRequest('/api/labels'), '/api/v2/labels');
    expect(parse(res.headers.get('Server-Timing')).get('be0-other')!.desc).toMatch(/conn=reuse$/);
  });

  it('미들웨어가 찍은 시각이 있으면 bff_pre(미들웨어 + 라우트까지 대기)', async () => {
    const res = await proxyToFastapi(keyRequest('/api/labels', { [MW_T0_HEADER]: String(Date.now() - 120) }), '/api/v2/labels');
    const pre = parse(res.headers.get('Server-Timing')).get('bff_pre');
    expect(pre?.desc).toBe('mw+queue');
    expect(pre!.dur).toBeGreaterThanOrEqual(120);
    expect(pre!.dur).toBeLessThan(1000);
  });

  it.each([['없음', undefined], ['숫자 아님', 'abc'], ['미래', String(Date.now() + 10_000)], ['1분 넘게 전', String(Date.now() - 120_000)]])(
    '미들웨어 시각이 %s이면 bff_pre를 안 낸다', async (_n, v) => {
      const res = await proxyToFastapi(keyRequest('/api/labels', v === undefined ? {} : { [MW_T0_HEADER]: v }), '/api/v2/labels');
      const t = parse(res.headers.get('Server-Timing'));
      expect(t.has('bff')).toBe(true);
      expect(t.has('bff_pre')).toBe(false);
    },
  );

  it('인증 없음(401) · 백엔드 연결 실패(503)도 헤더 · 로그를 낸다 — 도달한 구간까지만', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const unauth = await proxyToFastapi(new Request('https://app.example.com/api/labels'), '/api/v2/labels');
    expect(unauth.status).toBe(401);
    expect([...parse(unauth.headers.get('Server-Timing')).keys()]).toEqual(['bff', 'bff_auth']);

    const saved = process.env['NEXT_PUBLIC_FASTAPI_URL'];
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://127.0.0.1:1';
    try {
      const down = await proxyToFastapi(keyRequest('/api/labels'), '/api/v2/labels');
      expect(down.status).toBe(503);
      expect([...parse(down.headers.get('Server-Timing')).keys()].slice(0, 4)).toEqual(['bff', 'bff_auth', 'bff_locale', 'bff_reqbody']);
      expect(parse(down.headers.get('Server-Timing')).has('bff_be_ttfb')).toBe(false);
    } finally {
      process.env['NEXT_PUBLIC_FASTAPI_URL'] = saved;
    }
    expect(timingLogs().map((l) => JSON.parse(l).status)).toEqual([401, 503]);
  });

  it('헤더 · 로그에 경로 · id · 쿼리 · 키가 안 샌다 — 로그는 리소스 이름 · 깊이만', async () => {
    const res = await proxyToFastapiWithParams(
      keyRequest(`/api/stories/${ID}/comments?project_id=${ID}`), '/api/v2/stories/[id]/comments', { id: ID },
    );
    await res.text();
    const header = res.headers.get('Server-Timing') ?? '';
    const [line] = timingLogs();
    for (const leaked of [ID, 'stories', 'project_id', 'sk_test', '/api/']) {
      expect(header, leaked).not.toContain(leaked);
    }
    for (const leaked of [ID, 'project_id', 'sk_test', '/api/']) {
      expect(line, leaked).not.toContain(leaked);
    }
    const parsed = JSON.parse(line!);
    expect(parsed).toMatchObject({ message: 'server_timing', surface: 'bff', kind: 'v2/stories/+2', status: 200 });
    expect(parsed.marks.map((m: [string, number]) => m[0])).toEqual(['auth', 'locale', 'reqbody', 'be_ttfb', 'be_body']);
  });
});

describe('routeKindForPath — 리소스 이름 · 깊이만', () => {
  it.each([
    ['/api/v2/labels', 'v2/labels'],
    ['/api/v2/labels?project_id=x', 'v2/labels'],
    [`/api/v2/stories/${ID}`, 'v2/stories/+1'],
    [`/api/v2/gates/${ID}/decide`, 'v2/gates/+2'],
    ['/api/v2/dependencies/graph', 'v2/dependencies/+1'],
    [`/api/v2/${ID}/x`, 'other'],
    ['/api/v2/abcdef12-3456-4789-abcd-ef0123456789', 'other'],
    // 음성 사례(까디르 4652) — 개인정보 · id가 버전 칸이나 리소스 칸에 와도 이름으로 안 실린다.
    ['/api/v2/someone@example.com/profile', 'other'],
    ['/api/someone@example.com/labels', 'other'],
    ['/api/v2/12345', 'other'],
    ['/api/v2/label.json', 'other'],
    ['/api/v2/oauth2', 'other'],
    [`/api/${ID}/labels`, 'other'],
    ['/api/latest/labels', 'other'],
    ['/api/V2/labels', 'other'],
    ['/api/v2/Labels', 'other'],
    ['/api/v10/labels', 'v10/labels'],
    ['/weird', 'other'],
    ['', 'other'],
  ])('%s → %s', (path, kind) => {
    expect(routeKindForPath(path)).toBe(kind);
  });
});
