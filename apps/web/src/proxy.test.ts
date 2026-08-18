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

async function makeAccessToken(overrides: { exp?: number; type?: string; orgId?: string; projectId?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    type: overrides.type ?? 'access',
    email: 'test@example.com',
    ...((overrides.orgId || overrides.projectId)
      ? { app_metadata: { ...(overrides.orgId ? { org_id: overrides.orgId } : {}), ...(overrides.projectId ? { project_id: overrides.projectId } : {}) } }
      : {}),
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

  it('treats /refund-policy as public — no 307-to-login (story #2606)', async () => {
    // /terms·/privacy와 동형 — Toss 체크아웃/푸터에서 링크되는 공개 법적 문서. 이 목록 등록을
    // 놓치면 로그인 없는 방문자가 보호 라우트로 오인돼 /login 307로 튕긴다.
    const response = await middleware(makeRequest('/refund-policy'));
    expect(response.status).toBe(200);
  });

  it('treats /auth/native as public — no 307-to-login (story 26170479, 민군 축c 실측 발견)', async () => {
    // /auth/native는 세션을 만드는 공개 엔드포인트라 호출 시점엔 세션이 없는 게 정상 — PUBLIC
    // 목록 누락 시 보호 라우트로 오인돼 /login 307로 튕겨나간다(실 왕복 통합검증에서 잡힌
    // 크로스레이어 갭, route.ts 단위테스트로는 안 잡힘). no-cookie 요청으로 그 정확한 실패
    // 모드를 재현·가드.
    const response = await middleware(makeRequest('/auth/native'));
    expect(response.status).toBe(200);
  });

  it('does not accidentally widen the guard to all of /auth/* — /auth/reset-required stays protected', async () => {
    // 스코프 정확성 회귀가드 — "/auth/native만 열고 /auth/ 전체는 열지 않는다"는 명시 요구를
    // 실제로 지켰는지 확인. /auth/reset-required는 보호 라우트로 남아있어야 함.
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const response = await middleware(makeRequest('/auth/reset-required'));
    expect(response.status).toBe(307);
  });

  it('treats /auth/oauth-handoff as public — no 307-to-login (e-mobile-oauth-native-handoff-contract §5, same class of gap as story 26170479)', async () => {
    // 세션을 만드는 공개 엔드포인트라 호출 시점엔 세션이 없는 게 정상 — /auth/native와 동일
    // 이유로 PUBLIC 목록에 있어야 한다(#2224 교훈 선제 적용, 실제 사고 재발 전에 가드).
    const response = await middleware(makeRequest('/auth/oauth-handoff'));
    expect(response.status).toBe(200);
  });

  it('treats /.well-known/assetlinks.json as public — App Link 검증기는 인증 쿠키 없이 호출(§10.2)', async () => {
    const response = await middleware(makeRequest('/.well-known/assetlinks.json'));
    expect(response.status).toBe(200);
  });

  it('treats /apple-app-site-association as public — Universal Link 검증기는 인증 쿠키 없이 호출(§10.2)', async () => {
    const response = await middleware(makeRequest('/apple-app-site-association'));
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

  it('redirects to login with reason=session_expired when sp_rt exists but refresh is rejected — real expiry (story #2745 AC2)', async () => {
    // sp_rt가 실재했다가 백엔드가 401로 명시 거부한 경우만 "만료"라 부를 근거가 있다.
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const response = await middleware(makeRequest('/dashboard', { sp_rt: 'dead-rt' }));
    expect(response.status).toBe(307);
    // AC3(551bbbee): hard /login 대신 next 보존 + reason 배너 계약. graceful 세션 만료 UX.
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('https://app.example.com/login?');
    expect(loc).toContain(`next=${encodeURIComponent('/dashboard')}`);
    expect(loc).toContain('reason=session_expired');
  });

  it('redirects to login WITHOUT reason=session_expired when no sp_at and no sp_rt cookie — anonymous first visit (story #2745 AC1, 선생님 지적)', async () => {
    // 근본 버그: sp_at/sp_rt/활성계정 금고 중 아무 신호도 없는 익명 첫 방문자가 보호 라우트에
    // 진입해도 예전엔 loginRedirect가 무조건 reason=session_expired를 붙였다 — "만료"는 살아있던
    // 세션이 죽었다는 주장인데, 애초에 세션이 없었으면 성립하지 않는다. 재현: /legal/refund 같은
    // 보호 라우트에 쿠키 0개 브라우저로 진입(선생님 실측 2026-08-18).
    const response = await middleware(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    const loc = response.headers.get('location') ?? '';
    expect(loc).toContain('https://app.example.com/login?');
    expect(loc).toContain(`next=${encodeURIComponent('/dashboard')}`);
    expect(loc).not.toContain('reason=session_expired');
  });

  it('clears sp_at/sp_rt cookies on definitive refresh failure — UI path (story e5225c0a P0)', async () => {
    // 산티아고 실측: refresh 실패 시 쿠키를 안 지워 30일 sp_rt 가 401 무한 재생산. 이 테스트는
    // 그 정확한 실패 모드를 재현하고 수정을 고정한다.
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const response = await middleware(makeRequest('/dashboard', { sp_rt: 'stale-rt-ui' }));
    expect(response.status).toBe(307);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_rt=;');
    expect(setCookie).toContain('sp_at=;');
  });

  it('clears sp_at/sp_rt cookies on definitive refresh failure — API path (story e5225c0a P0)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const response = await middleware(makeRequest('/api/notifications', { sp_rt: 'stale-rt-api' }));
    expect(response.status).toBe(200); // handler 가 401 반환하도록 통과
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_rt=;');
    expect(setCookie).toContain('sp_at=;');
  });

  it('clears cookies with matching Domain attribute when NEXT_PUBLIC_COOKIE_DOMAIN is set (prod root cause — story e5225c0a 3차)', async () => {
    // 산티아고 gcloud 실측 근본: prod FE Cloud Run엔 NEXT_PUBLIC_COOKIE_DOMAIN=app.sprintable.ai가
    // Secret Manager로 설정돼있다(dev엔 없어 이 시나리오가 dev 검증을 통과했던 이유). SET 시 Domain이
    // 붙는데 delete가 Domain 없이 나가면 브라우저가 다른 쿠키로 취급해 삭제가 조용히 no-op된다 —
    // 이 테스트는 그 domain-scoped 환경을 시뮬레이트해 삭제 Set-Cookie에 Domain이 실려야 함을 고정한다.
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.sprintable.ai';
    process.env['NEXT_PUBLIC_COOKIE_DOMAIN'] = 'app.sprintable.ai';
    try {
      mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
      const response = await middleware(makeRequest('/dashboard', { sp_rt: 'stale-rt-domain' }));
      expect(response.status).toBe(307);
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('Domain=app.sprintable.ai');
      // 두 쿠키 모두에 Domain이 실렸는지(하나만 고치는 회귀 방지) — sp_at/sp_rt 각각의 Set-Cookie
      // 청크에 Domain이 붙어있어야 하므로 개수로 확인.
      const domainCount = (setCookie.match(/Domain=app\.sprintable\.ai/g) ?? []).length;
      expect(domainCount).toBe(2);
    } finally {
      delete process.env['NEXT_PUBLIC_APP_URL'];
      delete process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
    }
  });

  // #2124 ㉯(오르테가군·선생님 실측 2026-07-27) — 기대값 뒤집힘(오르테가군 지시: 새로 짜지 말고
  // 그 자리 뒤집는 것 — "결함을 증명하는 테스트"에서 "결함이 돌아오면 잡는 가드"로). 예전엔
  // status를 안 가리고(401도 429도 5xx도 네트워크에러도) 전부 clearAuthCookies로 이어졌다 —
  // 이제 status===401(진짜 TOKEN_REVOKED)만 지우고, 나머지(transient — 죽었는지 확인 못 함)는
  // 쿠키를 보존해 다음 방문에 재시도할 여지를 남긴다.
  it('일시 장애(503 — rate-limit이나 콜드스타트 등)에서는 sp_at/sp_rt를 지우지 않는다 — 진짜 401이 아니므로(story #2124 ㉯)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE' } }) });
    const response = await middleware(makeRequest('/dashboard', { sp_rt: 'still-valid-rt-503' }));
    expect(response.status).toBe(307); // 이 요청 자체는 여전히 미인증 처리(로그인으로) — 다만 쿠키는 살아남는다
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('sp_rt=;');
    expect(setCookie).not.toContain('sp_at=;');
  });

  it('네트워크 레벨 throw(fetch reject — 타임아웃/DNS 등)에서도 sp_at/sp_rt를 지우지 않는다 — 토큰 자체는 무관하므로(story #2124 ㉯)', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed: network error'));
    const response = await middleware(makeRequest('/dashboard', { sp_rt: 'still-valid-rt-network-error' }));
    expect(response.status).toBe(307);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('sp_rt=;');
    expect(setCookie).not.toContain('sp_at=;');
  });

  it('진짜 401(TOKEN_REVOKED)일 때는 여전히 sp_at/sp_rt를 지운다 — ㉯가 clearAuthCookies를 아예 없앤 게 아니라 조건만 좁힌 것임을 확認(story #2124 ㉯ 회귀가드)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const response = await middleware(makeRequest('/dashboard', { sp_rt: 'genuinely-dead-rt' }));
    expect(response.status).toBe(307);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_rt=;');
    expect(setCookie).toContain('sp_at=;');
  });

  // #2124 사슬 3단계 — ㉮(vault 폴백) 착지 後 기대값 뒤집힘(오르테가군 지시: 새로 짜지 말고 그
  // 셋의 기대값만 뒤집는 것). 원래는 "금고가 있어도 proxy가 안 봐서 복구 불가"를 증명하는
  // 결함-재현 테스트였다 — 이제는 "sp_rt가 죽어도 active 계정의 금고 토큰으로 갱신에 성공한다"는
  // 정상동작 가드다. 결함이 돌아오면(vault 폴백이 다시 사라지면) 이 테스트가 RED로 잡는다.
  it('sp_rt가 죽어도 sp_active_account가 가리키는 계정의 금고(sp_acct_rt_<id>) 토큰으로 갱신에 성공한다(story #2124 ㉮)', async () => {
    const activeId = '5dfbd9fc-94c2-4afc-9814-da4b7ad08c28';
    const now = Math.floor(Date.now() / 1000);
    const newAt = await new SignJWT({ type: 'access', email: 'test@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(activeId)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(JWT_SECRET));
    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { refresh_token: string };
      if (body.refresh_token === 'vaulted-active-account-rt') {
        return Promise.resolve({ ok: true, json: async () => ({ data: { access_token: newAt, refresh_token: 'new-rt-from-vault' } }) });
      }
      // sp_rt(죽은 토큰) 경로는 여전히 503 — 그래서 폴백이 실제로 발동해야만 이 테스트가 통과한다.
      return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE' } }) });
    });
    const response = await middleware(makeRequest('/dashboard', {
      sp_rt: 'active-rt-about-to-die',
      [`sp_acct_rt_${activeId}`]: 'vaulted-active-account-rt',
      sp_active_account: activeId,
    }));
    expect(response.status).toBe(200); // 리다이렉트 안 됨 — 로그인 화면으로 안 튕겨나감
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('sp_at=');
    expect(setCookie).toContain('new-rt-from-vault');
  });

  // 경계 ①(오르테가군 지시): 금고에 있는 아무 토큰이나 쓰면 안 됨 — active 포인터가 가리키는
  // 계정 것만. 다른 계정의 금고 항목이 있어도 그건 안 쓰고 기존(null) 동작 그대로.
  it('active 포인터와 다른 계정의 금고 항목은 쓰지 않는다(story #2124 ㉮ 경계①)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE' } }) });
    const response = await middleware(makeRequest('/dashboard', {
      sp_rt: 'active-rt-about-to-die',
      sp_acct_rt_other_account_id: 'someone-elses-vault-token',
      sp_active_account: 'this-account-id-has-no-vault-entry',
    }));
    expect(response.status).toBe(307); // 폴백 대상이 없으니 기존 그대로 로그인으로
    // sp_rt 시도 1회만(active 계정 것도 아닌 다른 금고 항목으로 추가 시도 0)
    const refreshCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[0] as string).includes('/api/v2/auth/refresh'));
    expect(refreshCalls.length).toBe(1);
  });

  // 경계 ②(오르테가군 지시): active 포인터가 가리키는 계정이 금고에 아예 없으면 조용히 다른
  // 걸로 안 감 — 기존 null 동작 그대로(폴백의 폴백 없음).
  it('active 포인터가 가리키는 계정이 금고에 없으면 폴백 없이 기존 동작 그대로(story #2124 ㉮ 경계②)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE' } }) });
    const response = await middleware(makeRequest('/dashboard', {
      sp_rt: 'active-rt-about-to-die',
      sp_active_account: 'account-with-no-vault-entry-at-all',
      // sp_acct_rt_account-with-no-vault-entry-at-all 쿠키 자체가 없음
    }));
    expect(response.status).toBe(307);
    const refreshCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[0] as string).includes('/api/v2/auth/refresh'));
    expect(refreshCalls.length).toBe(1);
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

  // story #2212 근본원인 — curl로 라이브 재현해 확定한 결함: sp_at이 없거나 무효라 refresh를
  // 타는 두 분기가, 새 토큰을 받고도 원 pathname을 그냥 NextResponse.next()로 통과시켰다.
  // bare 레거시 링크(/board 등)는 그 pathname에 대응하는 페이지가 없어(오직 /{ws}/{proj}/board만
  // 존재) Next 라우터가 즉시 404 — 토큰 자체는 정상으로 새로 발급됐는데도(다음 요청은 정상 301)
  // 이 요청은 구제 안 됐다("재로그인 직후 첫 진입만 404, 재진입은 정상"과 정확히 일치). 이 두
  // 테스트가 그 회귀가드 — refresh 성공 후에도 legacy-resource-redirect가 반드시 실행돼야 한다.
  it('sp_at이 무효(만료 등)라 refresh를 타도, 그 새 토큰으로 legacy 리소스 경로가 여전히 301 해소된다(story #2212)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const newAt = await makeAccessToken({ exp: now + 900, orgId: 'org-1', projectId: 'proj-1' });
    mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
      if (url.includes('/api/v2/auth/refresh')) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { access_token: newAt, refresh_token: 'new-rt' } }) });
      }
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', slug: 'sprintable' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    // sp_at은 서명 자체가 무효(claims 검증 실패) — verifyAccessToken이 null을 반환하는 경로.
    const response = await middleware(makeRequest('/board', { sp_at: 'not.a.valid.jwt', sp_rt: 'old-rt' }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/board');
    expect(response.headers.get('set-cookie')).toContain('sp_at=');
  });

  it('sp_at 쿠키 자체가 없어(만료 후 삭제 등) refresh를 타도, 그 새 토큰으로 legacy 리소스 경로가 여전히 301 해소된다(story #2212)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const newAt = await makeAccessToken({ exp: now + 900, orgId: 'org-1', projectId: 'proj-1' });
    mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
      if (url.includes('/api/v2/auth/refresh')) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { access_token: newAt, refresh_token: 'new-rt' } }) });
      }
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', slug: 'sprintable' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const response = await middleware(makeRequest('/board', { sp_rt: 'valid-rt' }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/board');
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
    // 리소스명은 이 테스트의 관심사(workspace/project resolve)와 무관 — RENAMED_RESOURCES에
    // 없는 이름을 써야 redirectRenamedResourcePath가 가로채지 않는다(#2373 board→flow 편입 후
    // 'board'를 쓰면 이 resolve 로직에 닿기 전에 301로 새는 회귀가 났다).
    const response = await middleware(makeRequest('/moonklabs/sprintable/goals', { sp_at: token }));
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
    const response = await middleware(makeRequest('/ghost-workspace/proj/goals', { sp_at: token }));
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

  it('story #2039 AC3 — 구 한글 project slug(예: /moonklabs/장사왕/board)도 형식 탈락 없이 resolve해 canonical로 301한다', async () => {
    // PO 실재현 경로 그대로: workspace는 이미 ASCII('moonklabs')라 문제가 없고, **project
    // 세그먼트가 구 한글 slug('장사왕')**인 자리 — 딱 이 자리가 원 버그다.
    //
    // 회귀 재현 ①: SLUG_FORMAT(kebab·ASCII) 검사가 남아있던 시절엔 '장사왕'이 그 형식에서
    // 탈락해 looksLikeWorkspaceSegment(segments[1])가 false를 반환 → projSlug가 undefined로
    // 떨어져 resolve가 project 파라미터 없이(workspace만) 호출됐다 — 즉 project 조회 자체가
    // 시도되지 않았다.
    //
    // 회귀 재현 ②(2차 발견, 형식게이트 하나만으론 안 풀림): `pathname`은 비ASCII 세그먼트를
    // 항상 percent-encoded로 준다. 그 문자열을 디코드 없이 그대로 URLSearchParams에 넣으면
    // `%`가 `%25`로 재인코딩돼 이중 인코딩된 쿼리스트링이 나가고, 백엔드가 한 번만 디코드하므로
    // DB의 raw 한글 slug와 매칭되지 않는다. 아래 단언은 fetch가 **단일 인코딩**된 쿼리스트링
    // (`project=%EC%9E%A5%EC%82%AC%EC%99%95`, decodeURIComponent 한 번으로 '장사왕' 복원)
    // 으로 호출됐는지까지 정확히 검증한다.
    const token = await makeAccessToken();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ org_id: 'org-1', org_slug: 'moonklabs', org_role: 'admin', project_id: 'proj-1', redirect: { project: 'project-307152f3' } }),
    });
    // 리소스명은 board 대신 goals — #2373로 board가 RENAMED_RESOURCES에 편입되면서 이 자리에
    // board를 쓰면 redirectRenamedResourcePath가 workspace resolve보다 먼저 가로채 mockFetch가
    // 0회 호출되는 회귀가 났다(이 테스트가 재려는 한글 slug 이중인코딩 가드 자체가 무력화된다).
    const response = await middleware(makeRequest('/moonklabs/%EC%9E%A5%EC%82%AC%EC%99%95/goals', { sp_at: token }));
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/v2/resolve?workspace=moonklabs&project=%EC%9E%A5%EC%82%AC%EC%99%95',
      expect.any(Object),
    );
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/project-307152f3/goals');
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
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
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
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
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
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
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

  // story #2212 — 이 두 케이스는 예전엔 "개입 없이 통과"(→ Next 자체 404)가 정답이라고
  // 봤으나, 그 자체가 dead-end 결함이었다(AC3/AC4). 프로젝트를 못 정했거나(쿠키+JWT 둘 다 없음)
  // BE 해소 자체가 실패해도, org는 확定돼 있으니 org-briefing(프로젝트 불필요 페이지)으로
  // next=원 목적지를 들고 보낸다 — "고르면 여기로 돌아온다"(use-unified-switcher.ts가 소비).
  it('current-project 쿠키도 JWT project_id도 없으면 404 대신 /org-briefing?next=<원경로+되돌이방지마커>로 302(story #2212)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    // ⛔카디르 QA 2차 재진단(2026-08-09) — orgId는 이제 /api/v2/me 실조회로 확定한다(JWT 클레임
    // 직접 디코드 대신) — 이 테스트도 그 조회가 성공한다고 가정한다(mockFetch가 이제 호출된다,
    // 예전엔 JWT만 디코드해서 0회였다 — "호출 안 됨"이 아니라 "302 목적지가 맞다"가 이 테스트의
    // 진짜 관심사).
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/v2/me')) {
        return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const response = await middleware(makeRequest('/docs/my-doc', { sp_at: token }));
    expect(response.status).toBe(302);
    // _prRetry=1 — 프로젝트를 골라도 또 실패하면(아래 되돌이 방지 테스트) 다시 안 튕기기 위한 내부 마커.
    expect(response.headers.get('location')).toBe('https://app.example.com/org-briefing?next=%2Fdocs%2Fmy-doc%3F_prRetry%3D1');
  });

  it('org/project는 확定됐는데 BE 단건 조회만 실패(예: 삭제됨)해도 404 대신 /org-briefing?next=<원경로+되돌이방지마커>로 302(story #2212)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/v2/me')) {
        return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const response = await middleware(makeRequest('/docs/my-doc', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://app.example.com/org-briefing?next=%2Fdocs%2Fmy-doc%3F_prRetry%3D1');
  });

  // ⛔실측 결함(2026-08-09, PO puppeteer 재현 — 흐름 메뉴→/flow bare→dead-end 404) — 단건조회
  // (GET /projects/{id})가 slug 有인 정상 프로젝트인데도 이따금 실패해 이 자리가 dead-end
  // 404였다(원인 미확定, BE 로그 확認 별건). 리스트 엔드포인트(GET /projects)로 안전하게
  // 폴백해 org-briefing 되돌이 없이 바로 301 성공하는지 잠근다.
  it('단건조회(GET /projects/{id})만 실패해도 리스트(GET /projects)에서 찾아 301 성공한다(단건조회 불안정 dead-end fix)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-1')) {
        return Promise.resolve({ ok: false, status: 404 }); // 단건조회는 실패
      }
      if (url.endsWith('/api/v2/projects')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'other-proj', slug: 'other' }, { id: 'proj-1', slug: 'sprintable' }],
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const response = await middleware(makeRequest('/docs/my-doc', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/docs/my-doc');
  });

  // ⛔카디르 QA 근본 재진단(2026-08-09, 실측 8회 재현) — 위 리스트 폴백 fix는 이 헤더 없이는
  // 애초에 못 먹었다: X-Org-Id 없는 project 조회는 BE get_verified_org_id가 JWT 기본 org로
  // 스코프해, 세션의 현재/타겟 org가 그와 다른 멀티org 계정에선 엉뚱한 org로 스코프돼 빈
  // 결과/404가 난다(curl로 X-Org-Id 붙이면 정상 확認됨) — 단건조회·리스트 조회 둘 다 X-Org-Id
  // 를 보내는지 직접 잠근다(회귀 시 다시 dead-end로 돌아간다).
  it('project 단건조회·리스트조회 둘 다 X-Org-Id 헤더를 보낸다(멀티org 계정 cross-org 스코프 오류 방지)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-1')) {
        return Promise.resolve({ ok: false, status: 404 }); // 단건조회는 실패 → 리스트 폴백 유도
      }
      if (url.endsWith('/api/v2/projects')) {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'proj-1', slug: 'sprintable' }] });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    await middleware(makeRequest('/docs/my-doc', { sp_at: token, sprintable_current_project_id: 'proj-1' }));

    const singleItemCall = mockFetch.mock.calls.find((args: unknown[]) => (args[0] as string).includes('/api/v2/projects/proj-1'));
    const listCall = mockFetch.mock.calls.find((args: unknown[]) => (args[0] as string).endsWith('/api/v2/projects'));
    expect((singleItemCall?.[1] as { headers?: Record<string, string> })?.headers?.['X-Org-Id']).toBe('org-1');
    expect((listCall?.[1] as { headers?: Record<string, string> })?.headers?.['X-Org-Id']).toBe('org-1');
  });

  // ⛔카디르 QA 2차 재진단(2026-08-09, 실측 8회 재현) — 진짜 회귀가드. 위 테스트들은 JWT의
  // org_id와 /api/v2/me의 org_id가 우연히 같은 'org-1'이라 구현이 JWT를 디코드하든 /me를
  // 실조회하든 결과가 똑같아 mutation을 못 잡았다(뮤테이션self-check으로 직접 확認한 맹점).
  // 멀티org 계정처럼 **둘을 의도적으로 다르게** 둬 /api/v2/me(실조회)의 org가 이긴다는 걸
  // 직접 잠근다 — JWT 클레임으로 되돌아가면 이 테스트가 RED된다.
  it('JWT의 org_id 클레임이 stale해도(멀티org 계정) /api/v2/me의 살아있는 org_id를 쓴다', async () => {
    const token = await makeAccessToken({ orgId: 'jwt-org-stale' });
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/v2/me')) {
        return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-live' }) });
      }
      if (url.includes('/api/v2/organizations/org-live')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-live', slug: 'liveorg' }) });
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
    expect(response.headers.get('location')).toBe('https://app.example.com/liveorg/sprintable/docs/my-doc');
    expect(mockFetch.mock.calls.some((args: unknown[]) => (args[0] as string).includes('/api/v2/organizations/jwt-org-stale'))).toBe(false);
  });

  // PO 실제 재현(2026-08-09) — org-briefing 배너대로 프로젝트를 선택해 next(_prRetry=1 달고)로
  // 돌아온 요청. fix 전에는 단건조회 실패 + retry-guard가 겹쳐 정직한 404로 막다른 dead-end였다
  // (선택해도 못 빠져나옴) — 리스트 폴백이 이 재시도 요청에서도 먹혀 301로 뚫리는지 잠근다.
  it('되돌이(재시도, _prRetry=1) 요청에서도 단건조회 실패+리스트 성공이면 301로 정상 착지한다(PO 실제 재현 dead-end fix)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-1')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (url.endsWith('/api/v2/projects')) {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'proj-1', slug: 'sprintable' }] });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const response = await middleware(makeRequest('/docs/my-doc?_prRetry=1', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/docs/my-doc');
  });

  // story #2212(오르테가 지적, 되돌이 방지) — 프로젝트를 골라 next로 돌아왔는데도(=이 요청 자체가
  // _prRetry=1을 달고 옴) 여전히 해소가 실패하면, 다시 /org-briefing으로 튕기지 않고 정직하게
  // 멈춘다(Next 자체 404) — 무한 왕복 대신 "여기서 안 된다"는 신호.
  it('되돌이 방지 — _prRetry=1을 달고 왔는데도 또 실패하면 다시 org-briefing으로 안 튕기고 개입 없이 통과(404)한다', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/docs/my-doc?_prRetry=1', { sp_at: token }));
    expect(response.status).toBe(200); // 개입 없이 통과 — Next 라우터가 이 pathname에 404를 렌더
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

  it.each(['standup', 'retro', 'loops', 'artifacts', 'mockups', 'sprints', 'storage', 'epics', 'board', 'goals'])(
    'bare /%s(/*) → 실 slug로 301(redirectLegacyResourcePath 일반화 증명)',
    async (resource) => {
      const token = await makeAccessToken({ orgId: 'org-1' });
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
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

  it('story #1999: CURRENT_PROJECT_COOKIE 부재(평범한 로그인 직후) 시 access token app_metadata.project_id로 fallback — 여전히 301', async () => {
    const token = await makeAccessToken({ orgId: 'org-1', projectId: 'proj-1' });
    mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', slug: 'sprintable' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    // 쿠키 없이 sp_at만 — 온보딩/switch-project를 거치지 않은 순수 로그인 세션 재현.
    const response = await middleware(makeRequest('/board?story=abc', { sp_at: token }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/board?story=abc');
  });

  it('story #1999: 쿠키와 JWT project_id가 다르면 쿠키 우선(명시 switch-project 결과 존중)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1', projectId: 'proj-old' });
    mockFetch.mockImplementation((url: string) => {
        if (url.includes('/api/v2/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ org_id: 'org-1' }) });
        }
      if (url.includes('/api/v2/organizations/org-1')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'org-1', slug: 'moonklabs' }) });
      }
      if (url.includes('/api/v2/projects/proj-new')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-new', slug: 'newer-project' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const response = await middleware(makeRequest('/board', { sp_at: token, sprintable_current_project_id: 'proj-new' }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/newer-project/board');
  });

  it('이관 안 된 리소스(예: /meetings — dead feature, S-route-project 스코프 밖)는 개입 없이 통과 — MIGRATED_RESOURCES 밖', async () => {
    // story a539c649 S3d: board는 이관 완료(MIGRATED_RESOURCES 편입)라 이 예시로 더 이상 부적합
    // — meetings는 확인된 미사용/비활성 기능이라 마이그레이션 스코프 자체에서 제외됨(교사 승인).
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/meetings', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('proxy — 경로 리터럴 rename 301(story 8fc51517, 에픽→목표): [ws]/[proj]/epics/* → [ws]/[proj]/goals/*', () => {
  beforeEach(() => {
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000';
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  it('/{ws}/{proj}/epics → 301 /{ws}/{proj}/goals(같은 ws/proj 세그먼트 보존, org/project 재조회 없음)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/moonklabs/sprintable/epics', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/goals');
    // 3번째 세그먼트만 교체하는 순수 문자열 치환이라 org/project fetch가 전혀 없어야 한다.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('/{ws}/{proj}/epics/{id} — 딥링크(id 서브패스)도 손실 없이 이동', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/moonklabs/sprintable/epics/e-123', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/goals/e-123');
  });

  it('/{ws}/{proj}/board → 301 /{ws}/{proj}/flow(board도 RENAMED_RESOURCES 대상 — #2373 prod 승격 board 은퇴 회귀가드)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/moonklabs/sprintable/board', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/flow');
    // 3번째 세그먼트만 교체하는 순수 문자열 치환이라 org/project fetch가 전혀 없어야 한다(epics→goals와 동형).
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('이미 신 경로(/goals)로 들어온 요청은 재리다이렉트 없이 그대로 통과(무한루프 방지 확인)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ org_id: 'org-1', org_slug: 'moonklabs', org_role: 'member', project_id: 'proj-1', project_slug: 'sprintable' }),
    });
    const response = await middleware(makeRequest('/moonklabs/sprintable/goals', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).not.toBe(301);
  });
});

describe('proxy — 폐기된 리소스 301(story #2378, 유나양 design:changes: rename과 다른 통) — mockups는 은퇴, id는 버린다', () => {
  beforeEach(() => {
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000';
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  it('/{ws}/{proj}/mockups → 301 /{ws}/{proj}/artifacts(mockups 은퇴 — E-CANVAS가 후계 목록 화면으로 착지)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/moonklabs/sprintable/mockups', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/artifacts');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('/{ws}/{proj}/mockups/{id} → 301 /{ws}/{proj}/artifacts(id 하위 세그먼트는 «버린다» — mockup id≠artifact id라 들고 가면 남의 항목이 열릴 수 있다)', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/moonklabs/sprintable/mockups/abc123', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(301);
    // ⛔/artifacts/abc123 이 아니다 — RENAMED_RESOURCES(epics→goals)와 정확히 다른 지점.
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/artifacts');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('/{ws}/{proj}/mockups/{id}/edit도 동일 — 하위세그먼트 전부 버리고 목록 루트로', async () => {
    const token = await makeAccessToken({ orgId: 'org-1' });
    const response = await middleware(makeRequest('/moonklabs/sprintable/mockups/abc123/edit', {
      sp_at: token, sprintable_current_project_id: 'proj-1',
    }));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.example.com/moonklabs/sprintable/artifacts');
  });
});

describe('proxy — story #2595 connect-guide locale rewrite', () => {
  it('rewrites /connect-guide.txt to the English default when no locale signal is present', async () => {
    const response = await middleware(makeRequest('/connect-guide.txt'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-rewrite')).toContain('/connect-guide.en.txt');
  });

  it('rewrites /connect-guide.txt to Korean when the locale cookie says ko', async () => {
    const response = await middleware(makeRequest('/connect-guide.txt', { locale: 'ko' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-rewrite')).toContain('/connect-guide.ko.txt');
  });

  it('rewrites /connect-guide.txt to Korean via Accept-Language when no cookie is set', async () => {
    const req = makeRequest('/connect-guide.txt');
    req.headers.set('accept-language', 'ko-KR,ko;q=0.9');
    const response = await middleware(req);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-rewrite')).toContain('/connect-guide.ko.txt');
  });

  it('a locale cookie value outside the supported set falls back to English, not a crash', async () => {
    const response = await middleware(makeRequest('/connect-guide.txt', { locale: 'fr' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-rewrite')).toContain('/connect-guide.en.txt');
  });

  it('direct requests to the per-locale files themselves are public (no login redirect)', async () => {
    for (const path of ['/connect-guide.en.txt', '/connect-guide.ko.txt']) {
      const response = await middleware(makeRequest(path));
      expect(response.status).toBe(200);
    }
  });
});
