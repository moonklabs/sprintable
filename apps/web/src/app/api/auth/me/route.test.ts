// story #3195 — 카디르 QA 치명(PR#3617): 이전엔 onboarding-form.tsx/verify-email/page.tsx가
// `/api/me`(BE me.py::get_me, TeamMember 필수)를 불렀는데, 그 회로가 겨냥하는 "무 org"
// 상태에선 BE가 404를 내 email_verified/org_id를 전혀 못 읽었다 — FE 테스트는 fetch를
// 모듈째 mock해 이 실경로(route.ts → proxyToFastapi → BE) 자체를 안 지나가서 못 잡혔다
// (PR#3605와 동형 "실경로 미도달" 클래스). 이 파일은 fastapi-proxy.test.ts/PR#3605
// route.test.ts와 동형 패턴 — getServerSession+global.fetch만 mock하고 route의 GET을
// 직접 호출해 실제 프록시 코드 경로(→ /api/v2/auth/me)를 지나며 "실경로 도달"을 증명한다.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getServerSessionMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn(),
}));
vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));

import { GET } from './route';

describe('/api/auth/me — 실경로 계약(story #3195, 카디르 QA)', () => {
  beforeEach(() => {
    getServerSessionMock.mockReset();
    getServerSessionMock.mockResolvedValue({ access_token: 'token-1' });
  });

  it('BE(/api/v2/auth/me)를 호출하고 응답을 단일래핑 {data: ...}로 반환한다', async () => {
    const beBody = { member_id: 'm-1', org_id: null, project_id: null, email_verified: false };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/v2/auth/me');
      return new Response(JSON.stringify(beBody), { status: 200 });
    });
    global.fetch = fetchMock;

    const res = await GET(new Request('http://localhost/api/auth/me'));
    const json = await res.json();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(json.data).toEqual(beBody);
    expect(json.error).toBeNull();
  });

  it('무 org(=이 스토리가 겨냥하는 온보딩 1/4 상태) — BE가 org_id:null·email_verified 실값으로 200 낸다(404 아님)', async () => {
    // BE app.routers.auth.get_auth_me는 JWT claims만 읽어 TeamMember/org 유무와 무관하게
    // 항상 200을 낸다(me.py::get_me와 달리) — 여기서는 그 계약을 FE 라우트가 그대로
    // 통과시키는지만 증명한다(BE 자체 핸들러 로직은 backend/tests/test_3195_*.py 소관).
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({ member_id: 'm-1', org_id: null, project_id: null, email_verified: true }),
      { status: 200 },
    ));

    const res = await GET(new Request('http://localhost/api/auth/me'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.org_id).toBeNull();
    expect(json.data.email_verified).toBe(true);
  });

  it('세션 없음 — BE 호출 없이 401', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const res = await GET(new Request('http://localhost/api/auth/me'));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('BE 에러(500)를 그대로 전달한다(삼키지 않음)', async () => {
    global.fetch = vi.fn(async () => new Response('boom', { status: 500 }));
    const res = await GET(new Request('http://localhost/api/auth/me'));
    expect(res.status).toBe(500);
  });
});
