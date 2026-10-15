// story #3644(3632 후속, AC8) — 직접 fetch(proxyToFastapi 미경유) 라우트. 조직 전환은
// 인증 토큰을 새로 발급받는 자리라 로그인과 같은 무게 — 상류가 502+HTML(CF 오류
// 페이지)을 내면 이전엔 `fastapiRes.json()`이 던져 이미 적혀 있는 폴백 봉투("HTTP
// ${status}")에 영영 도달 못 하고 Next.js가 자기 500 HTML을 냈다.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getServerSessionMock } = vi.hoisted(() => ({ getServerSessionMock: vi.fn() }));
vi.mock('@/lib/db/server', () => ({
  getServerSession: getServerSessionMock,
  SP_AT_COOKIE: 'sp_at',
  SP_RT_COOKIE: 'sp_rt',
}));
const cookieJar = vi.hoisted(() => ({ rt: 'rt-this-session' as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'sp_rt' && cookieJar.rt ? { value: cookieJar.rt } : undefined) }),
}));

import { POST } from './route';

function switchRequest(orgId = 'org-2') {
  return new Request('http://localhost/api/switch-org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: orgId }),
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  getServerSessionMock.mockReset();
  getServerSessionMock.mockResolvedValue({ access_token: 'token-1', org_id: 'org-1', project_id: 'proj-1' });
});

describe('/api/switch-org — 상류 비-JSON 본문(story #3644 AC8)', () => {
  it('상류가 502+HTML을 내면 500 HTML로 새지 않고 기존 폴백 봉투("HTTP 502")+원 status를 낸다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>502 Bad Gateway</body></html>',
      { status: 502, headers: { 'content-type': 'text/html' } },
    )));

    const res = await POST(switchRequest());

    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SWITCH_FAILED');
    expect(body.error.message).toBe('HTTP 502');
  });

  it('정상 JSON 실패 봉투는 그대로 통과(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'ORG_ACCESS_DENIED', message: '이 조직에 접근할 수 없습니다.' } }),
      { status: 403 },
    )));

    const res = await POST(switchRequest());

    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('ORG_ACCESS_DENIED');
  });
});

describe('[SID:4400] /api/switch-org sends this session\'s refresh token', () => {
  it('the backend gets sp_rt, so it revokes only this session (other devices keep theirs)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'X' } }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    cookieJar.rt = 'rt-this-session';
    await POST(switchRequest('org-2'));
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ org_id: 'org-2', refresh_token: 'rt-this-session' });
  });

  it('without the cookie the field is left out (the backend then keeps its previous behaviour)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'X' } }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    cookieJar.rt = undefined;
    await POST(switchRequest('org-2'));
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ org_id: 'org-2' });
  });
});
