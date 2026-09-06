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

// story #3549(3547 BE·디디 계약, 유나 §13-8②, PO 確定 2026-09-06) — Facebook Page가
// 2개 이상이면 BE가 연결을 만들지 않고 `{kind:"pending_selection", ...}`을 돌려준다.
// 브라우저 리다이렉트는 POST 바디를 못 옮기므로 다음 요청이 스스로 다시 그릴 수
// 있게 쿼리에 후보·만료 시각을 싣는다.
describe('GET /api/oauth-channel/callback/[channel] — Facebook 「선택 대기」(story #3549)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    h.cookiesGetMock.mockReset();
    h.cookiesDeleteMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  function stubFacebookCookies() {
    const defaults: Record<string, string> = { oauth_channel_org_facebook: 'org-1', sp_at: 'sp-at-token' };
    h.cookiesGetMock.mockImplementation((name: string) => (name in defaults ? { value: defaults[name] } : undefined));
  }
  function facebookRequest(query: Record<string, string>): Request {
    const url = new URL('http://localhost/api/oauth-channel/callback/facebook');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return new Request(url.toString());
  }
  function facebookRouteParams() {
    return { params: Promise.resolve({ channel: 'facebook' }) };
  }

  it('kind=pending_selection — candidates·pending_id·expires_at을 쿼리에 실어 select_pending으로 리다이렉트한다(연결은 안 만들어짐)', async () => {
    stubFacebookCookies();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        kind: 'pending_selection', pending_id: 'pending-1',
        candidates: [{ page_id: 'p1', name: '우리 회사 페이지' }, { page_id: 'p2', name: '2호점' }],
        expires_at: '2026-09-06T00:00:00Z',
      }),
    });
    const res = await GET(facebookRequest({ code: 'c', state: 's' }), facebookRouteParams());
    const location = res.headers.get('location')!;
    expect(location).toContain('/organization/channels?');
    expect(location).toContain('select_pending=facebook');
    expect(location).toContain('pending_id=pending-1');
    expect(location).toContain('expires_at=2026-09-06T00%3A00%3A00Z');
    expect(decodeURIComponent(new URL(location).searchParams.get('candidates')!)).toBe(
      JSON.stringify([{ page_id: 'p1', name: '우리 회사 페이지' }, { page_id: 'p2', name: '2호점' }]),
    );
    expect(location).not.toContain('connected=facebook');
  });

  it('kind=pending_selection·candidates=[] — 0개도(§13-8③) 같은 select_pending 경로로 넘긴다(화면이 0개 문구를 고른다)', async () => {
    stubFacebookCookies();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'pending_selection', pending_id: 'pending-2', candidates: [], expires_at: '2026-09-06T00:00:00Z' }),
    });
    const res = await GET(facebookRequest({ code: 'c', state: 's' }), facebookRouteParams());
    const location = res.headers.get('location')!;
    expect(location).toContain('select_pending=facebook');
    expect(decodeURIComponent(new URL(location).searchParams.get('candidates')!)).toBe('[]');
  });

  it('kind 없음(threads·instagram류, 기존 계약 그대로) — 여전히 ?connected=로', async () => {
    stubFacebookCookies();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'c1', channel: 'facebook' }) });
    const res = await GET(facebookRequest({ code: 'c', state: 's' }), facebookRouteParams());
    expect(res.headers.get('location')).toBe('http://localhost:3108/organization/channels?connected=facebook');
  });
});
