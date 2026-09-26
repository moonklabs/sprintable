/**
 * story #4320(까디르 QA ①–④) — 긴 라우트 시한 · 한 번 쓰는 값의 «시간 제한만» · 시간 초과 봉투.
 *
 * 시계: `setTimeout`을 가짜로 두고 `AbortSignal.timeout`을 그 시계로 끊기게 바꿔(원래 것은 진짜 시계라 가짜 시계로 못 민다) «백엔드가
 * 31초 뒤에 답함»을 기다리지 않고 잰다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BFF_CEILING_MS, FRONTEND_REQUEST_LIMIT_MS, LONG_ROUTES } from '@/lib/bff-route-timeouts';

const { getServerSessionMock, getLocaleMock } = vi.hoisted(() => ({ getServerSessionMock: vi.fn(), getLocaleMock: vi.fn() }));
vi.mock('@/lib/db/server', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getServerSession: getServerSessionMock }));
vi.mock('@/i18n/request', () => ({ getLocale: getLocaleMock }));

const fetchMock = vi.fn();

beforeEach(() => {
  process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://backend.test';
  getServerSessionMock.mockResolvedValue(null);
  getLocaleMock.mockResolvedValue('ko');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // 가짜 시계로 끊기는 시간 제한 신호.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException(`timeout ${ms}`, 'TimeoutError')), ms);
    return c.signal;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env['NEXT_PUBLIC_FASTAPI_URL'];
});

/** 백엔드가 `afterMs` 뒤에 JSON으로 답한다 — 그 전에 신호가 끊기면 신호의 이유로 거부. 받은 신호를 기록한다. */
function backendRepliesAfter(afterMs: number, body: unknown = { data: { ok: true } }) {
  const seen: AbortSignal[] = [];
  fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal as AbortSignal;
    seen.push(signal);
    const t = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })), afterMs);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); });
  }));
  return seen;
}

const authed = (url: string, init: RequestInit = {}) =>
  new Request(`https://app.example.com${url}`, { method: 'POST', body: '{}', ...init, headers: { Authorization: 'Bearer sk_test', 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

describe('긴 라우트 표(bff-route-timeouts · 까디르 QA ①②)', () => {
  it('⭐세 층이 맞물린다 — BFF ≤ 프런트 한도 − 여유 · 브라우저 > BFF · 백엔드 최악 + 여유가 천장을 넘으면 «동기로 못 기다림»', () => {
    for (const [key, r] of Object.entries(LONG_ROUTES)) {
      expect(r.bffMs, `${key} BFF가 프런트 Cloud Run보다 먼저 답한다`).toBeLessThanOrEqual(BFF_CEILING_MS);
      expect(r.bffMs, key).toBeLessThan(FRONTEND_REQUEST_LIMIT_MS);
      expect(r.browserMs, `${key} 브라우저가 BFF의 503 봉투를 받는다`).toBeGreaterThan(r.bffMs);
      if (r.backendWorstMs !== null && !r.syncImpossible) expect(r.bffMs, `${key} 백엔드 최악보다 길다`).toBeGreaterThan(r.backendWorstMs);
      expect(r.syncImpossible, key).toBe(r.backendWorstMs === null || r.backendWorstMs >= BFF_CEILING_MS);
      expect(r.basis.length, `${key} 근거(백엔드 파일:줄)`).toBeGreaterThan(10);
    }
    // 동기로 못 기다리는 줄 — 후속 카드(결제: 주문번호 조회 · 제공자 긴 작업: 비동기화).
    expect(Object.entries(LONG_ROUTES).filter(([, r]) => r.syncImpossible).map(([k]) => k).sort()).toEqual(
      ['attachmentConvert', 'billingChangeTier', 'billingCheckout', 'channelAssetConfirm', 'channelDraftSubmit', 'channelPublishNow', 'gateTransition', 'loopContextPack'],
    );
  });

  it('프런트 한도가 배포 설정(cloudbuild.yaml _FRONTEND_TIMEOUT)과 같다', () => {
    const yaml = readFileSync(path.resolve(__dirname, '../../../../cloudbuild.yaml'), 'utf8');
    const m = yaml.match(/_FRONTEND_TIMEOUT:\s*'(\d+)'/);
    expect(Number(m?.[1]) * 1000).toBe(FRONTEND_REQUEST_LIMIT_MS);
  });
});

describe('결제 경로 — 30초 넘게 걸리는 백엔드를 끝까지 기다린다(까디르 QA ① P1)', () => {
  it('⭐백엔드가 31초 뒤에 답하면 성공(예전 기본 30초면 503 — 이중 결제 위험)', async () => {
    backendRepliesAfter(31_000, { data: { subscription_id: 'sub-1' } });
    const { POST } = await import('@/app/api/billing/checkout/route');
    const pending = POST(authed('/api/billing/checkout'));
    await vi.advanceTimersByTimeAsync(31_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('한 번 쓰는 값 · 새 토큰 — 원 요청을 끊어도 백엔드 호출은 끝까지(까디르 QA ③)', () => {
  it('⭐결제(공용 프록시): 원 요청 abort → 백엔드 fetch 신호는 끊기지 않는다', async () => {
    const seen = backendRepliesAfter(5_000);
    const client = new AbortController();
    const { POST } = await import('@/app/api/billing/checkout/route');
    const pending = POST(authed('/api/billing/checkout', { signal: client.signal }));
    await vi.advanceTimersByTimeAsync(0);
    client.abort();
    expect(seen[0]?.aborted, '원 요청 취소가 넘어가면 청구는 됐는데 결과를 못 받는다').toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).status).toBe(200);
  });

  it('⭐로그인(직접 backendFetch · TOTP 소비 · 리프레시 발급): 원 요청 abort → 백엔드 fetch 신호는 끊기지 않는다', async () => {
    const seen = backendRepliesAfter(1_000, { data: { access_token: 'a', refresh_token: 'r' } });
    const client = new AbortController();
    const { POST } = await import('@/app/api/auth/login/route');
    const pending = POST(new Request('https://app.example.com/api/auth/login', {
      method: 'POST', body: JSON.stringify({ email: 'a@b.c', password: 'x', totp_code: '123456' }), signal: client.signal, headers: { 'Content-Type': 'application/json' },
    }) as never);
    await vi.advanceTimersByTimeAsync(0);
    client.abort();
    expect(seen[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
  });

  it('대조 — 한 번 쓰는 값이 아닌 라우트(회고 종합)는 원 요청 취소가 넘어간다', async () => {
    const seen = backendRepliesAfter(5_000);
    const client = new AbortController();
    const { POST } = await import('@/app/api/retro-sessions/[id]/synthesis/route');
    const pending = POST(authed('/api/retro-sessions/r1/synthesis', { signal: client.signal }), { params: Promise.resolve({ id: 'r1' }) } as never);
    await vi.advanceTimersByTimeAsync(0);
    client.abort();
    expect(seen[0]?.aborted).toBe(true);
    await pending.catch(() => {});
  });
});

describe('시간 초과는 봉투로 — 본문 읽기 중에도 · 직접 fetch도(까디르 QA ④)', () => {
  function headersThenStalledBody() {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
          signal.addEventListener('abort', () => controller.error(signal.reason));
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    });
  }

  it('⭐공용 프록시 — 머리를 받은 뒤 본문 읽기 중 시간 초과 → 503 UPSTREAM_TIMEOUT(예전엔 500)', async () => {
    headersThenStalledBody();
    const { proxyToFastapi } = await import('@/lib/fastapi-proxy');
    const pending = proxyToFastapi(authed('/api/x', { method: 'GET', body: undefined }), '/api/v2/x', { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('⭐backendFetch — 머리 전 시간 초과 · 본문 읽기 중 시간 초과 둘 다 503 봉투 · 원 요청 취소는 499', async () => {
    const { backendFetch } = await import('@/lib/backend-fetch');
    backendRepliesAfter(60_000);
    let pending = backendFetch('http://backend.test/x', { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    let res = await pending;
    expect([res.status, (await res.json()).error.code]).toEqual([503, 'UPSTREAM_TIMEOUT']);

    headersThenStalledBody();
    pending = backendFetch('http://backend.test/x', { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    res = await pending;
    expect([res.status, (await res.json()).error.code]).toEqual([503, 'UPSTREAM_TIMEOUT']);

    backendRepliesAfter(60_000);
    const client = new AbortController();
    pending = backendFetch('http://backend.test/x', { request: new Request('https://a.test/', { signal: client.signal }) });
    await vi.advanceTimersByTimeAsync(0);
    client.abort();
    res = await pending;
    expect(res.status).toBe(499);
  });

  it('backendFetch — 본문 · 상태 · Set-Cookie는 그대로 넘기고 압축 · 길이 머리는 뺀다(본문을 풀어 다시 싣는다)', async () => {
    const h = new Headers({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '999' });
    h.append('set-cookie', 'a=1');
    h.append('set-cookie', 'b=2');
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 201, headers: h }));
    const { backendFetch } = await import('@/lib/backend-fetch');
    const res = await backendFetch('http://backend.test/x', { timeoutMs: 1_000 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });
});
