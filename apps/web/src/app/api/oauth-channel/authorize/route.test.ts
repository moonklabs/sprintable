// story #3376 — app/auth/link/route.ts와 동형 레일 회귀가드. 핵심: (1) org/channel 쿼리
// 없으면 즉시 에러 리다이렉트(BE 호출 0) (2) sp_at 없으면 로그인으로 (3) 성공 시 org_id를
// oauth_channel_org_{channel} 쿠키에 남기고(디코드 안 하는 opaque state와 별개 채널) BE가
// 준 url로 그대로 리다이렉트 (4) BE 실패는 에러코드를 그대로 쿼리에 실어 되돌린다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookiesGetMock: vi.fn(), cookiesSetMock: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: h.cookiesGetMock, set: h.cookiesSetMock })),
}));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at' }));
vi.mock('@/services/app-url', () => ({ resolveAppUrl: () => 'http://localhost:3108' }));
vi.mock('@/lib/auth/oauth-cookies', () => ({ oauthCookieOptions: () => ({ httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 300, path: '/' }) }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { GET } from './route';

function makeRequest(query: Record<string, string>): Request {
  const url = new URL('http://localhost/api/oauth-channel/authorize');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

describe('GET /api/oauth-channel/authorize (story #3376)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    h.cookiesGetMock.mockReset();
    h.cookiesSetMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('org 또는 channel 쿼리가 없으면 BE를 부르지 않고 즉시 에러 리다이렉트', async () => {
    const res = await GET(makeRequest({ org: 'org-1' })); // channel 없음
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toContain('connect_error=INVALID_REQUEST');
  });

  it('sp_at 쿠키가 없으면 로그인으로 리다이렉트', async () => {
    h.cookiesGetMock.mockReturnValue(undefined);
    const res = await GET(makeRequest({ org: 'org-1', channel: 'threads' }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toContain('/login?next=');
  });

  // story #3613(페드루 PO 確定 2026-09-07) — BE `authorize_channel_connection`
  // (channel_connections.py:403, response_model=AuthorizeResponse)은 성공 시
  // «맨몸» `{url,state}`를 낸다(backend/app에 성공 응답 전역 봉투 0). 이 mock을
  // `{data:{url}}`로 두면(구판 그대로) 라우트의 구현 버그와 mock의 버그가 서로
  // 상쇄돼 테스트가 «실패할 수 없는 표본»이 된다(2026-09-06 #3907 생성 시점부터
  // 라이브가 실은 한 번도 성립한 적 없었는데 이 테스트는 계속 green이었던 원인) —
  // BE 실제 형(맨몸)으로 mock해 라이브와 같은 경로를 통과하는지 검증한다.
  it('성공 — org_id를 oauth_channel_org_{channel} 쿠키에 남기고 BE가 준 url로 리다이렉트(BE 실제 형=맨몸)', async () => {
    h.cookiesGetMock.mockReturnValue({ value: 'sp-at-token' });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ url: 'https://threads.net/oauth/authorize?x=1', state: 'opaque-state' }) });
    const res = await GET(makeRequest({ org: 'org-1', channel: 'threads' }));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/organizations/org-1/channel-connections/threads/authorize'),
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer sp-at-token' } }),
    );
    expect(h.cookiesSetMock).toHaveBeenCalledWith('oauth_channel_org_threads', 'org-1', expect.any(Object));
    expect(res.headers.get('location')).toBe('https://threads.net/oauth/authorize?x=1');
  });

  // story #3613 — instagram/facebook/facebook_sandbox도 같은 라우트를 공유한다(채널명만
  // 다름). 실 OAuth는 못 돌리니 BE의 맨몸 url을 그대로 리다이렉트하는지만 채널별로 고정.
  it.each(['instagram', 'facebook', 'facebook_sandbox'])(
    '%s — 같은 라우트가 BE 맨몸 url로 그대로 리다이렉트한다(회귀)',
    async (channel) => {
      h.cookiesGetMock.mockReturnValue({ value: 'sp-at-token' });
      const providerUrl = `https://provider.example/${channel}/oauth?x=1`;
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ url: providerUrl, state: 'opaque-state' }) });
      const res = await GET(makeRequest({ org: 'org-1', channel }));
      expect(res.headers.get('location')).toBe(providerUrl);
      expect(h.cookiesSetMock).toHaveBeenCalledWith(`oauth_channel_org_${channel}`, 'org-1', expect.any(Object));
    },
  );

  // story #3613(양성 대조) — BE가 맨몸 응답에 url을 안 실은 극단(malformed) 사례도
  // CHANNEL_AUTHORIZE_FAILED로 안전하게 떨어져야 한다(undefined url로 리다이렉트 금지).
  it('BE가 맨몸 응답에 url이 없으면 CHANNEL_AUTHORIZE_FAILED로 리다이렉트(회귀)', async () => {
    h.cookiesGetMock.mockReturnValue({ value: 'sp-at-token' });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ state: 'opaque-state' }) });
    const res = await GET(makeRequest({ org: 'org-1', channel: 'threads' }));
    expect(h.cookiesSetMock).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toContain('connect_error=CHANNEL_AUTHORIZE_FAILED');
  });

  it('BE가 409 CHANNEL_APP_CREDENTIALS_MISSING을 주면 그 코드를 그대로 쿼리에 실어 되돌린다(쿠키 미설정)', async () => {
    h.cookiesGetMock.mockReturnValue({ value: 'sp-at-token' });
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ data: null, error: { code: 'CHANNEL_APP_CREDENTIALS_MISSING' } }) });
    const res = await GET(makeRequest({ org: 'org-1', channel: 'threads' }));
    expect(h.cookiesSetMock).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toContain('connect_error=CHANNEL_APP_CREDENTIALS_MISSING');
  });
});
