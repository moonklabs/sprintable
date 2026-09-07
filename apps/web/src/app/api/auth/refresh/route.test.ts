import { beforeEach, describe, expect, it, vi } from 'vitest';

// story e5225c0a(P0) 재진단: 이 route는 proxy.ts PUBLIC_PREFIX('/api/auth/')라 미들웨어의
// stale-cookie cleanup을 안 거친다 — 별도 실패 경로에서 쿠키를 지우는지 직접 검증.
const h = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  csrfCheck: vi.fn(),
}));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: h.csrfCheck }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: h.cookieGet })) }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { POST } from './route';

function makeRequest(): Request {
  return new Request('http://localhost/api/auth/refresh', { method: 'POST', body: '{}' });
}

describe('POST /api/auth/refresh', () => {
  beforeEach(() => {
    h.cookieGet.mockReset();
    h.csrfCheck.mockReset().mockReturnValue(null); // CSRF 통과
    mockFetch.mockReset();
    h.cookieGet.mockImplementation((name: string) => (name === 'sp_rt' ? { value: 'stale-rt' } : undefined));
  });

  it('no refresh token cookie → 401, no fastapi call', async () => {
    h.cookieGet.mockReturnValue(undefined);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('BE refresh 성공 → 200 + sp_at/sp_rt 신규 값 set', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: 'new-at', refresh_token: 'new-rt' } }),
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_at=new-at');
    expect(setCookie).toContain('sp_rt=new-rt');
  });

  it('BE refresh 실패(401) → sp_at/sp_rt 쿠키 삭제(무한 재생산 차단 — 핵심 회귀 가드)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'TOKEN_REVOKED', message: 'revoked' } }),
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_at=;');
    expect(setCookie).toContain('sp_rt=;');
  });

  // story #3644(3632 후속, AC8) — 상류가 502+HTML(CF 오류 페이지)을 내면 이전엔
  // `fastapiRes.json()`이 던져 이 함수 자체가 uncaught로 죽어 sp_at/sp_rt 삭제
  // (무한 재시도 차단의 핵심 방어선)까지 통째로 안 돌았다. safeJsonParse가 빈
  // 객체로 흡수해 `!json.data`가 여전히 true가 되므로 삭제 경로가 살아 있어야 한다.
  it('상류가 502+HTML을 내도 fastapiRes.json() throw로 안 죽고 sp_at/sp_rt를 그대로 삭제한다', async () => {
    mockFetch.mockResolvedValue(new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502, headers: { 'content-type': 'text/html' },
    }));
    const res = await POST(makeRequest());
    expect(res.status).toBe(502);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_at=;');
    expect(setCookie).toContain('sp_rt=;');
  });

  it('domain-scoped 환경(NEXT_PUBLIC_COOKIE_DOMAIN 설정)에서도 삭제에 Domain이 실림 — prod 근본 회귀 가드(3차)', async () => {
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.sprintable.ai';
    process.env['NEXT_PUBLIC_COOKIE_DOMAIN'] = 'app.sprintable.ai';
    try {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'TOKEN_REVOKED', message: 'revoked' } }),
      });
      const res = await POST(makeRequest());
      expect(res.status).toBe(401);
      const setCookie = res.headers.get('set-cookie') ?? '';
      const domainCount = (setCookie.match(/Domain=app\.sprintable\.ai/g) ?? []).length;
      expect(domainCount).toBe(2);
    } finally {
      delete process.env['NEXT_PUBLIC_APP_URL'];
      delete process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
    }
  });
});
