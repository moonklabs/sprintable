// story #3204(acquisition 계측) — POST /api/auth/register가 proxy.ts의 first-touch
// 귀속 쿠키를 BE로 relay하고, 가입 성공 後 그 쿠키를 지우는지(카디르 QA, PR#3612 — 안
// 지우면 같은 브라우저 재가입 시 前 계정 귀속이 새 계정에 오염) 고정.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookiesGetMock: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: h.cookiesGetMock })),
}));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));
vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: () => null }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { POST } from './route';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/register — first-touch 귀속 relay + 소비(story #3204)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    h.cookiesGetMock.mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  function stubAttrCookies(overrides: Record<string, string> = {}) {
    h.cookiesGetMock.mockImplementation((name: string) =>
      name in overrides ? { value: overrides[name] } : undefined,
    );
  }

  it('귀속 쿠키가 있으면 BE 요청 바디에 그대로 실려 간다', async () => {
    stubAttrCookies({ sp_attr_src: 'google', sp_attr_medium: 'cpc' });
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { access_token: 'at', refresh_token: 'rt' } }),
    });
    await POST(makeRequest({ email: 'a@b.com', password: 'Abc123!!', display_name: 'A', tos_accepted: true }));

    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.signup_utm_source).toBe('google');
    expect(body.signup_utm_medium).toBe('cpc');
  });

  it('가입 성공(201) 응답에서 귀속 쿠키 4개를 전부 지운다(maxAge=0)', async () => {
    stubAttrCookies({ sp_attr_src: 'google', sp_attr_ref: 'https://twitter.com/x' });
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { access_token: 'at', refresh_token: 'rt' } }),
    });
    const res = await POST(makeRequest({ email: 'a@b.com', password: 'Abc123!!', display_name: 'A', tos_accepted: true }));

    expect(res.status).toBe(201);
    for (const name of ['sp_attr_src', 'sp_attr_medium', 'sp_attr_campaign', 'sp_attr_ref']) {
      const cookie = res.cookies.get(name);
      expect(cookie?.value).toBe('');
      expect(cookie?.maxAge).toBe(0);
    }
  });

  it('가입 실패면 귀속 쿠키를 지우지 않는다(아직 소비된 게 아님 — 재시도 때 다시 쓴다)', async () => {
    stubAttrCookies({ sp_attr_src: 'google' });
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 409, json: async () => ({ error: { code: 'EMAIL_TAKEN', message: 'x' } }),
    });
    const res = await POST(makeRequest({ email: 'a@b.com', password: 'Abc123!!', display_name: 'A', tos_accepted: true }));

    expect(res.status).toBe(409);
    expect(res.cookies.get('sp_attr_src')).toBeUndefined();
  });
});
