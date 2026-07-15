import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return actual;
});

import { proxy as middleware } from './proxy';

const JWT_SECRET = 'test-secret-for-proxy-tests';

async function makeAccessToken(overrides: { exp?: number; type?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: overrides.type ?? 'access', email: 'test@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-123')
    .setIssuedAt(now)
    .setExpirationTime(overrides.exp ?? now + 900)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function makeRequest(path: string, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(`https://app.example.com${path}`);
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

describe('proxy', () => {
  beforeEach(() => {
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000';
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  it('passes public paths without JWT check', async () => {
    for (const path of ['/internal-dogfood', '/login', '/api/notifications']) {
      const response = await middleware(makeRequest(path));
      expect(response.status).toBe(200);
    }
  });

  it('serves onboarding-guide.txt as public — no 307-to-login (45a5a006)', async () => {
    // PUBLIC_EXACT 누락 시 이 요청이 보호 라우트로 오인돼 /login 307로 튕겨나간다(공개 정적
    // 문서가 로그인 뒤에 묶이는 회귀) — no-cookie 요청으로 그 정확한 실패 모드를 재현·가드.
    const response = await middleware(makeRequest('/onboarding-guide.txt'));
    expect(response.status).toBe(200);
  });

  it('passes all /api/* paths without JWT check', async () => {
    const apiPaths = [
      '/api/v1/bridge/slack/interactions',
      '/api/cron/hitl-timeouts',
      '/api/integrations/mcp/github/callback',
      '/api/webhooks/agent-runtime',
    ];
    for (const path of apiPaths) {
      const response = await middleware(makeRequest(path));
      expect(response.status).toBe(200);
    }
  });

  it('redirects to login when no sp_at cookie and refresh fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const response = await middleware(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    // AC3(551bbbee): hard /login 대신 next 보존 + reason 배너 계약. graceful 세션 만료 UX.
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('https://app.example.com/login?');
    expect(loc).toContain(`next=${encodeURIComponent('/dashboard')}`);
    expect(loc).toContain('reason=session_expired');
  });

  it('redirects to login when no sp_at and no sp_rt cookie', async () => {
    const response = await middleware(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    // AC3(551bbbee): hard /login 대신 next 보존 + reason 배너 계약. graceful 세션 만료 UX.
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('https://app.example.com/login?');
    expect(loc).toContain(`next=${encodeURIComponent('/dashboard')}`);
    expect(loc).toContain('reason=session_expired');
  });

  it('allows access with valid sp_at cookie', async () => {
    const token = await makeAccessToken();
    const response = await middleware(makeRequest('/dashboard', { sp_at: token }));
    expect(response.status).toBe(200);
  });

  it('redirects to login with invalid sp_at and no refresh token', async () => {
    const response = await middleware(makeRequest('/dashboard', { sp_at: 'not.a.valid.jwt' }));
    expect(response.status).toBe(307);
    // AC3(551bbbee): hard /login 대신 next 보존 + reason 배너 계약. graceful 세션 만료 UX.
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('https://app.example.com/login?');
    expect(loc).toContain(`next=${encodeURIComponent('/dashboard')}`);
    expect(loc).toContain('reason=session_expired');
  });

  it('refreshes token when sp_at is expiring soon', async () => {
    const now = Math.floor(Date.now() / 1000);
    const soonExpiring = await makeAccessToken({ exp: now + 200 }); // < 300s remaining
    const newAt = await makeAccessToken({ exp: now + 900 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: newAt, refresh_token: 'new-rt' } }),
    });
    const response = await middleware(makeRequest('/dashboard', { sp_at: soonExpiring, sp_rt: 'old-rt' }));
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/v2/auth/refresh'), expect.any(Object));
  });

  it('refreshes when sp_at missing but sp_rt present', async () => {
    const now = Math.floor(Date.now() / 1000);
    const newAt = await makeAccessToken({ exp: now + 900 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: newAt, refresh_token: 'new-rt' } }),
    });
    const response = await middleware(makeRequest('/dashboard', { sp_rt: 'valid-rt' }));
    expect(response.status).toBe(200);
    const setCookieHeader = response.headers.get('set-cookie');
    expect(setCookieHeader).toContain('sp_at=');
  });

  it('blocks Agent API key from UI routes', async () => {
    const req = new NextRequest('https://app.example.com/dashboard');
    req.headers.set('Authorization', 'Bearer sk_agent_key');
    const response = await middleware(req);
    expect(response.status).toBe(403);
  });
});

describe('proxy — resolve (story a539c649 S-route-project S1)', () => {
  beforeEach(() => {
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000';
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  it('reserved 첫 세그먼트(현존 flat 라우트)는 resolve fetch 자체를 시도 안 함 — 회귀 0 핵심 증명', async () => {
    const token = await makeAccessToken();
    const response = await middleware(makeRequest('/dashboard', { sp_at: token }));
    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('실 ws slug(reserved 아님) 진입 시 resolve 성공 → 200 + sp_resolve_cache 쿠키 세팅', async () => {
    const token = await makeAccessToken();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ org_id: 'org-1', org_slug: 'moonklabs', org_role: 'admin', project_id: 'proj-1', project_slug: 'sprintable' }),
    });
    const response = await middleware(makeRequest('/moonklabs/sprintable/board', { sp_at: token }));
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v2/resolve?workspace=moonklabs&project=sprintable'),
      expect.any(Object),
    );
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_resolve_cache=');
  });

  it('resolve 실패(미존재/미소속) → 개입 없이 통과(200) — Next 자체 404 렌더에 위임', async () => {
    const token = await makeAccessToken();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const response = await middleware(makeRequest('/ghost-workspace/proj/board', { sp_at: token }));
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('sp_resolve_cache=');
  });

  it('옛 slug(rename 이력) → BE redirect 필드를 미들웨어가 자체 301로 승격', async () => {
    const token = await makeAccessToken();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ org_id: 'org-1', org_slug: 'new-moonklabs', org_role: 'admin', redirect: { workspace: 'new-moonklabs' } }),
    });
    const response = await middleware(makeRequest('/old-moonklabs/board', { sp_at: token }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/new-moonklabs/board');
  });

  it('캐시 hit(유효 sp_resolve_cache 쿠키+동일 slug) → resolve fetch 생략', async () => {
    const token = await makeAccessToken();
    const cacheToken = await new SignJWT({
      wsSlug: 'moonklabs', projSlug: null,
      orgId: 'org-1', orgSlug: 'moonklabs', orgRole: 'admin',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('50s')
      .sign(new TextEncoder().encode(JWT_SECRET));
    const response = await middleware(makeRequest('/moonklabs/board', { sp_at: token, sp_resolve_cache: cacheToken }));
    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
