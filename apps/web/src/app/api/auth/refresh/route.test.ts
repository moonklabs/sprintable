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
});
