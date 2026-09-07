// story #3644(3632 후속, AC8) — 직접 fetch(proxyToFastapi 미경유) 라우트. 상류가
// `.json()` 호출 前 !ok 검사도 없이 바로 파싱하던 형이라, CF가 502/504를 자기 HTML
// 오류 페이지로 바꿔치면(story #3632 그라운딩) 여기서 던져 이미 적혀 있는 폴백 봉투
// 줄에 영영 도달 못 하고 Next.js가 자기 500 HTML을 냈다 — 로그인 경로라 특히 무겁다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/csrf', () => ({ verifyCsrfOrigin: () => null }));

import { POST } from './route';

function loginRequest() {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.com', password: 'x' }),
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/auth/login — 상류 비-JSON 본문(story #3644 AC8)', () => {
  it('상류가 502+HTML(CF 오류 페이지)을 내면 500 HTML로 새지 않고 기존 폴백 봉투+원 status를 낸다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>502 Bad Gateway</body></html>',
      { status: 502, headers: { 'content-type': 'text/html' } },
    )));

    const res = await POST(loginRequest());

    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('AUTH_FAILED');
    expect(body.error.message).toBe('Login failed');
  });

  it('정상 JSON 실패 봉투는 그대로 통과(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: '이메일 또는 비밀번호가 올바르지 않습니다.' } }),
      { status: 401 },
    )));

    const res = await POST(loginRequest());

    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });
});
