// story #3376 — Meta 리다이렉트를 받는 GET 엔드포인트. 핵심: (1) code/state/org_id(쿠키)
// 중 하나라도 없으면 BE를 부르지 않고 즉시 에러 리다이렉트 (2) org_id 쿠키는 성공/실패
// 무관하게 항상 소비 즉시 삭제(재사용 방지) (3) 성공 시 ?connected={channel}로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookiesGetMock: vi.fn(), cookiesDeleteMock: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: h.cookiesGetMock, delete: h.cookiesDeleteMock })),
}));
vi.mock('@/lib/db/server', () => ({ SP_AT_COOKIE: 'sp_at' }));
vi.mock('@/services/app-url', () => ({ resolveAppUrl: () => 'http://localhost:3108' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { GET } from './route';

function makeRequest(query: Record<string, string>): Request {
  const url = new URL('http://localhost/api/oauth-channel/callback/threads');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url.toString());
}
function routeParams() {
  return { params: Promise.resolve({ channel: 'threads' }) };
}

describe('GET /api/oauth-channel/callback/[channel] (story #3376)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    h.cookiesGetMock.mockReset();
    h.cookiesDeleteMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  function stubCookies(overrides: Record<string, string> = {}) {
    const defaults: Record<string, string> = { oauth_channel_org_threads: 'org-1', sp_at: 'sp-at-token', ...overrides };
    h.cookiesGetMock.mockImplementation((name: string) => (name in defaults ? { value: defaults[name] } : undefined));
  }

  it('⭐story #3407 — error 파라미터(Meta 거부)가 있으면 code/state 유무와 무관하게 즉시 OAUTH_PROVIDER_DENIED로, BE는 안 부른다', async () => {
    stubCookies();
    const res = await GET(makeRequest({ error: 'access_denied', error_reason: 'user_denied', state: 's' }), routeParams());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toContain('connect_error=OAUTH_PROVIDER_DENIED');
    expect(res.headers.get('location')).not.toContain('access_denied');
    expect(res.headers.get('location')).not.toContain('user_denied');
  });

  it('⭐story #3407 페드루 리뷰 — error=server_error(제공자 오류)는 거부가 아니라 OAUTH_PROVIDER_ERROR로 가른다', async () => {
    stubCookies();
    const res = await GET(makeRequest({ error: 'server_error', state: 's' }), routeParams());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toContain('connect_error=OAUTH_PROVIDER_ERROR');
    expect(res.headers.get('location')).not.toContain('server_error');
  });

  it('code·state·org_id 쿠키 중 org_id가 없으면 BE를 부르지 않고 에러 리다이렉트', async () => {
    h.cookiesGetMock.mockReturnValue(undefined); // oauth_channel_org_threads 없음
    const res = await GET(makeRequest({ code: 'c', state: 's' }), routeParams());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toContain('connect_error=OAUTH_MISSING_PARAMS');
  });

  it('org_id 쿠키는 성공 실패 무관하게 소비 즉시 항상 삭제된다', async () => {
    stubCookies();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'c1' } }) });
    await GET(makeRequest({ code: 'c', state: 's' }), routeParams());
    expect(h.cookiesDeleteMock).toHaveBeenCalledWith('oauth_channel_org_threads');
  });

  it('sp_at 세션이 없으면 SESSION_EXPIRED로 리다이렉트', async () => {
    stubCookies({ sp_at: '' });
    h.cookiesGetMock.mockImplementation((name: string) => {
      if (name === 'oauth_channel_org_threads') return { value: 'org-1' };
      return undefined; // sp_at 없음
    });
    const res = await GET(makeRequest({ code: 'c', state: 's' }), routeParams());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toContain('connect_error=SESSION_EXPIRED');
  });

  it('성공 — BE에 org_id·code·state를 전달하고 ?connected=threads로 리다이렉트', async () => {
    stubCookies();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'c1' } }) });
    const res = await GET(makeRequest({ code: 'auth-code', state: 'the-state' }), routeParams());
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/organizations/org-1/channel-connections/threads/callback'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sp-at-token' },
        body: JSON.stringify({ code: 'auth-code', state: 'the-state' }),
      }),
    );
    expect(res.headers.get('location')).toBe('http://localhost:3108/organization/channels?connected=threads');
  });

  it('BE가 400 CHANNEL_OAUTH_STATE_INVALID을 주면 그 코드를 쿼리에 실어 되돌린다', async () => {
    stubCookies();
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ data: null, error: { code: 'CHANNEL_OAUTH_STATE_INVALID' } }) });
    const res = await GET(makeRequest({ code: 'c', state: 's' }), routeParams());
    expect(res.headers.get('location')).toContain('connect_error=CHANNEL_OAUTH_STATE_INVALID');
  });
});
