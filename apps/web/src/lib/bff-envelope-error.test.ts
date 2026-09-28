/**
 * story #4320(유나 디자인 판정) — BFF가 스스로 짓는 상류 오류 봉투는 **앱의 로케일**로 말한다. 로케일은 목(mock) 없이 진짜 `getLocale`
 * (쿠키 → Accept-Language)로 풀리게 `next/headers`만 바꾼다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../messages/en.json';
import ko from '../../messages/ko.json';

const scope = vi.hoisted(() => ({ cookie: undefined as string | undefined, accept: null as string | null, outside: false }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    if (scope.outside) throw new Error('`cookies` was called outside a request scope');
    return { get: (name: string) => (name === 'locale' && scope.cookie ? { name, value: scope.cookie } : undefined) };
  },
  headers: async () => {
    if (scope.outside) throw new Error('`headers` was called outside a request scope');
    return new Headers(scope.accept ? { 'accept-language': scope.accept } : {});
  },
}));
vi.mock('@/lib/db/server', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getServerSession: vi.fn().mockResolvedValue(null) }));

const fetchMock = vi.fn();
beforeEach(() => {
  process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://backend.test';
  Object.assign(scope, { cookie: undefined, accept: null, outside: false });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['NEXT_PUBLIC_FASTAPI_URL'];
});

const rejectWith = (name: string) => fetchMock.mockRejectedValue(new DOMException(name, name));
const keyRequest = () => new Request('https://app.example.com/api/x', { headers: { Authorization: 'Bearer sk_test' } });

async function proxyEnvelope() {
  const { proxyToFastapi } = await import('@/lib/fastapi-proxy');
  const res = await proxyToFastapi(keyRequest(), '/api/v2/x');
  return { status: res.status, ...(await res.json()).error as { code: string; message: string } };
}

describe('BFF 상류 오류 봉투 — 앱의 로케일로(유나 판정 · 2982 · 3786 부류)', () => {
  it('⭐영어 로케일 쿠키 → 시간 초과 문장이 영어(Accept-Language가 한국어여도 쿠키가 먼저)', async () => {
    scope.cookie = 'en';
    scope.accept = 'ko-KR,ko;q=0.9';
    rejectWith('TimeoutError');
    expect(await proxyEnvelope()).toEqual({ status: 503, code: 'UPSTREAM_TIMEOUT', message: "The server didn't respond in time. Please try again in a moment." });
  });

  it('⭐한국어 로케일 쿠키 → 시간 초과 문장이 한국어(해요체)', async () => {
    scope.cookie = 'ko';
    rejectWith('TimeoutError');
    expect(await proxyEnvelope()).toEqual({ status: 503, code: 'UPSTREAM_TIMEOUT', message: '서버가 제시간에 응답하지 않았어요. 잠시 뒤 다시 시도해 주세요.' });
  });

  it('연결 불가 · 원 요청 취소(499)도 같은 규칙 — 영어 · 한국어', async () => {
    scope.cookie = 'en';
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await proxyEnvelope()).toMatchObject({ status: 503, code: 'UPSTREAM_UNREACHABLE', message: en.bffEnvelope.upstreamUnreachable });
    rejectWith('AbortError');
    expect(await proxyEnvelope()).toMatchObject({ status: 499, code: 'CLIENT_CLOSED_REQUEST', message: en.bffEnvelope.clientClosedRequest });
    scope.cookie = 'ko';
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await proxyEnvelope()).toMatchObject({ message: '서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
    rejectWith('AbortError');
    expect(await proxyEnvelope()).toMatchObject({ message: ko.bffEnvelope.clientClosedRequest });
  });

  it('상류가 JSON이 아닌 오류(CF HTML 등) — 로케일 문장 · 상류 status · Retry-After는 그대로', async () => {
    scope.cookie = 'en';
    fetchMock.mockResolvedValue(new Response('<html>429</html>', { status: 429, headers: { 'content-type': 'text/html', 'retry-after': '7' } }));
    const { proxyToFastapi } = await import('@/lib/fastapi-proxy');
    const res = await proxyToFastapi(keyRequest(), '/api/v2/x');
    expect([res.status, res.headers.get('retry-after')]).toEqual([429, '7']);
    expect((await res.json()).error).toMatchObject({ code: 'UPSTREAM_NON_JSON', message: en.bffEnvelope.upstreamNonJson });
    scope.cookie = 'ko';
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    expect((await (await proxyToFastapi(keyRequest(), '/api/v2/x')).json()).error.message).toBe(ko.bffEnvelope.upstreamNonJson);
  });

  it('쿠키가 없으면 Accept-Language · 둘 다 없으면 기본(영어)', async () => {
    rejectWith('TimeoutError');
    scope.accept = 'ko-KR,ko;q=0.9,en;q=0.8';
    expect((await proxyEnvelope()).message).toBe(ko.bffEnvelope.upstreamTimeout);
    scope.accept = null;
    expect((await proxyEnvelope()).message).toBe(en.bffEnvelope.upstreamTimeout);
  });

  it('⭐직접 fetch(backendFetch)도 같은 헬퍼 — 영어 · 한국어 · 요청 스코프 밖이면 기본(영어)', async () => {
    const { backendFetch } = await import('@/lib/backend-fetch');
    rejectWith('TimeoutError');
    scope.cookie = 'en';
    expect((await (await backendFetch('http://backend.test/x')).json()).error.message).toBe(en.bffEnvelope.upstreamTimeout);
    scope.cookie = 'ko';
    expect((await (await backendFetch('http://backend.test/x')).json()).error.message).toBe(ko.bffEnvelope.upstreamTimeout);
    scope.outside = true;
    const res = await backendFetch('http://backend.test/x');
    expect([res.status, (await res.json()).error.message]).toEqual([503, en.bffEnvelope.upstreamTimeout]);
  });

  it('코드 전부에 문장이 있다(표에서 코드가 빠지면 키 대신 경로가 새어 나간다)', async () => {
    const { bffEnvelopeError } = await import('@/lib/bff-envelope-error');
    for (const cookie of ['en', 'ko'] as const) {
      scope.cookie = cookie;
      const bundle = cookie === 'en' ? en.bffEnvelope : ko.bffEnvelope;
      for (const code of ['UPSTREAM_TIMEOUT', 'UPSTREAM_UNREACHABLE', 'CLIENT_CLOSED_REQUEST', 'UPSTREAM_NON_JSON'] as const) {
        const message = (await (await bffEnvelopeError(code)).json()).error.message as string;
        expect(Object.values(bundle), `${cookie} ${code}`).toContain(message);
      }
    }
  });

  it('문장 짝 — 두 로케일에 같은 키 · 빈 문장 없음 · 한국어는 합니다체가 아님', () => {
    expect(Object.keys(ko.bffEnvelope).sort()).toEqual(Object.keys(en.bffEnvelope).sort());
    for (const [key, text] of Object.entries(ko.bffEnvelope)) {
      expect(text, key).not.toMatch(/니다[.!]?\s*$|니다\./);
      expect(en.bffEnvelope[key as keyof typeof en.bffEnvelope].length, key).toBeGreaterThan(0);
    }
  });
});
