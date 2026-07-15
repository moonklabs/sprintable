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

async function makeAccessToken(overrides: { exp?: number; type?: string; orgId?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    type: overrides.type ?? 'access',
    email: 'test@example.com',
    ...(overrides.orgId ? { app_metadata: { org_id: overrides.orgId } } : {}),
  })
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

  it('clears sp_at/sp_rt cookies on definitive refresh failure — UI path (story e5225c0a P0)', async () => {
    // 산티아고 실측: refresh 실패 시 쿠키를 안 지워 30일 sp_rt 가 401 무한 재생산. 이 테스트는
    // 그 정확한 실패 모드를 재현하고 수정을 고정한다.
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const response = await middleware(makeRequest('/dashboard', { sp_rt: 'stale-rt-ui' }));
    expect(response.status).toBe(307);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_rt=;');
    expect(setCookie).toContain('sp_at=;');
  });

  it('clears sp_at/sp_rt cookies on definitive refresh failure — API path (story e5225c0a P0)', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const response = await middleware(makeRequest('/api/notifications', { sp_rt: 'stale-rt-api' }));
    expect(response.status).toBe(200); // handler 가 401 반환하도록 통과
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_rt=;');
    expect(setCookie).toContain('sp_at=;');
  });

  it('does NOT clear cookies when refresh succeeds but is suppressed for a different active account (RC2 regression guard)', async () => {
    // refreshMatchesActive=false 는 refresh 자체가 실패한 게 아니라(다른 계정의 늦은 refresh를
    // 의도적으로 무시하는 것) — clearAuthCookies 를 호출하면 안 된다. sp_active_account 포인터를
    // 새 토큰의 sub('user-123')와 다르게 둬서 이 분기를 트리거.
    const now = Math.floor(Date.now() / 1000);
    const newAt = await makeAccessToken({ exp: now + 900 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: newAt, refresh_token: 'new-rt' } }),
    });
    const response = await middleware(
      makeRequest('/dashboard', { sp_rt: 'rc2-suppressed-rt', sp_active_account: 'someone-else' }),
    );
    expect(response.status).toBe(307); // 이 요청 자체는 여전히 미인증(다른 계정) — 로그인 리다이렉트
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('sp_rt=;');
    expect(setCookie).not.toContain('sp_at=;');
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

describe('proxy — legacy /docs bare-URL redirect (story a539c649 S2)', () => {
  beforeEach(() => {
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000';
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  it('/docs/design-tokens 는 개입 없이 통과(project-scoped 아닌 정적 페이지, 무회귀)', async () => {
    // org_id+current-project 쿠키 둘 다 갖춰 다른 가드가 이 케이스를 우연히 가려주지 않게 한다
    // (design-tokens 제외 가드 자체를 직접 증명 — 뮤테이션 셀프체크로 확인).
    const token = await makeAccessToken({ orgId: 'org-1' });
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', slug: 'sprintable' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const response = await middleware(makeRequest('/docs/design-tokens', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('bare /docs/{slug} + org_id(JWT)+current-project 쿠키 있으면 실 slug로 301', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', slug: 'sprintable' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const response = await middleware(makeRequest('/docs/my-doc', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/docs/my-doc');
  });

  it('bare /docs(list, slug 없음)도 동일하게 301', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', slug: 'sprintable' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const response = await middleware(makeRequest('/docs', { sp_at: token, sprintable_current_project_id: 'proj-1' }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/docs');
  });

  it('current-project 쿠키 없으면 개입 없이 통과 — Next 자체 404로 정직하게 실패(과잉확장 아님)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/docs/my-doc', { sp_at: token }));
    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('org/project 단건 조회 실패(예: 삭제됨) 시 개입 없이 통과', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    const response = await middleware(makeRequest('/docs/my-doc', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(200);
  });
});

describe('proxy — legacy resource redirect generalized to non-docs resources (story a539c649 S3a/b)', () => {
  beforeEach(() => {
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000';
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  it.each(['standup', 'retro', 'loops', 'artifacts', 'mockups', 'sprints', 'storage', 'epics'])(
    'bare /%s(/*) → 실 slug로 301(redirectLegacyResourcePath 일반화 증명)',
    async (resource) => {
      const token = await makeAccessToken({ orgId: 'org-1' });
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/v2/organizations/org-1')) {
          return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
        }
        if (url.includes('/api/v2/projects/proj-1')) {
          return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', slug: 'sprintable' }) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      const response = await middleware(makeRequest(`/${resource}`, {
        sp_at: token, sprintable_current_project_id: 'proj-1',
      }));
      expect(response.status).toBe(301);
      expect(response.headers.get('location')).toBe(`https://app.example.com/moonklabs/sprintable/${resource}`);
    },
  );

  it('이관 안 된 리소스(예: /board)는 개입 없이 통과 — MIGRATED_RESOURCES 밖', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/board', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
