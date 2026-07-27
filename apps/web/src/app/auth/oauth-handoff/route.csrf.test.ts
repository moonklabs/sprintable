// e-mobile-oauth-native-handoff-contract §10.9 — 실 verifyCsrfOrigin()을 mock 없이 호출해
// literal `Origin: null` 헤더가 진짜 403으로 거부되는지 E2E 검증(까심 QA #2230 Axis 5 지적:
// route.test.ts는 csrf.ts를 mock 처리해 이 경계가 실제로 안 잡혔음을 정확히 적출).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at', SP_RT_COOKIE: 'sp_rt' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { POST } from './route';

const ENV_KEYS = ['FIREBASE_OAUTH_HANDOFF_ENABLED', 'FIREBASE_BFF_INTERNAL_SECRET', 'NEXT_PUBLIC_FASTAPI_URL', 'APP_BASE_URL', 'NEXT_PUBLIC_APP_URL', 'EXTRA_CSRF_ORIGINS'];

describe('POST /auth/oauth-handoff — §10.9 real verifyCsrfOrigin (no mock)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] = 'true';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('literal Origin: null header → real verifyCsrfOrigin rejects with 403, consume never called', async () => {
    const request = new Request('http://localhost/auth/oauth-handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', Host: 'localhost' },
      body: JSON.stringify({ code: 'c', code_verifier: 'v' }),
    });
    const res = await POST(request);
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sanity check — a same-host Origin still passes through to consume (real verifyCsrfOrigin isn\'t just blanket-rejecting)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt' }) });
    const request = new Request('http://localhost/auth/oauth-handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost' },
      body: JSON.stringify({ code: 'c', code_verifier: 'v' }),
    });
    const res = await POST(request);
    expect(res.status).toBe(303);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
