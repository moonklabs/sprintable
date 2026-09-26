/**
 * story #4346 — 앱 콜드 기동 묶음(보드 · 스프린트 · 목표 첫 로드)의 목록 GET이 사람 세션에서 `/api/v2/me`를 따로 부르지 않는다.
 *
 * 민 4299 재측(배포 32): 콜드 기동마다 BFF가 API 호출 앞에 `/me`를 7번(stories ×5 · goals · sprints · 한 번 63~163ms) 불렀다.
 * 원인: 세 라우트의 GET이 `getAuthContext`(사람 세션이면 늘 `/me` 왕복 — React `cache`는 요청 하나 안에서만 묶는다)를 썼는데,
 * 쓰는 값은 rate-limit 칸뿐(사람 세션엔 해당 없음)이다. org · project만 필요한 라우트용 `getOrgProjectAuthContext`(story 7d6b770b ·
 * JWT claim이 있으면 `/me` 0)가 이미 있다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fastapiCallMock, getServerSessionMock, proxyMock } = vi.hoisted(() => ({
  fastapiCallMock: vi.fn(),
  getServerSessionMock: vi.fn(),
  proxyMock: vi.fn(),
}));

vi.mock('@sprintable/storage-api', () => ({ fastapiCall: fastapiCallMock }));
vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxyMock }));
vi.mock('@/lib/storage/factory', () => {
  const repo = { list: vi.fn(async () => []) };
  return {
    createStoryRepository: vi.fn(async () => repo),
    createGoalRepository: vi.fn(async () => repo),
    createSprintRepository: vi.fn(async () => repo),
  };
});

const meCalls = () => fastapiCallMock.mock.calls.filter(([, path]) => path === '/api/v2/me').length;

beforeEach(() => {
  fastapiCallMock.mockReset();
  fastapiCallMock.mockImplementation(async (_method: string, path: string) =>
    path === '/api/v2/me' ? { id: 'm1', org_id: 'org-1', project_id: 'proj-1', project_name: 'P' } : [],
  );
  getServerSessionMock.mockReset();
  getServerSessionMock.mockResolvedValue({ access_token: 'tok', user_id: 'u1', org_id: 'org-1', project_id: 'proj-1' });
  proxyMock.mockReset();
  proxyMock.mockImplementation(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
});

describe('콜드 기동 목록 GET — 사람 세션(claim 있음)에서 /me 0', () => {
  it.each([
    ['stories', () => import('./stories/route'), 'http://localhost/api/stories?sprint_id=s1'],
    ['stories(미매달림)', () => import('./stories/route'), 'http://localhost/api/stories?unattached=true'],
    ['goals', () => import('./goals/route'), 'http://localhost/api/goals'],
    ['sprints', () => import('./sprints/route'), 'http://localhost/api/sprints'],
  ])('⭐%s', async (_name, load, url) => {
    const { GET } = await load();
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(meCalls()).toBe(0);
  });

  it('claim이 없으면 예전처럼 /me로 되묻는다(fail-closed · 인증 자체는 그대로)', async () => {
    getServerSessionMock.mockResolvedValue({ access_token: 'tok', user_id: 'u1', org_id: null, project_id: null });
    const { GET } = await import('./sprints/route');
    const res = await GET(new Request('http://localhost/api/sprints'));
    expect(res.status).toBe(200);
    expect(meCalls()).toBe(1);
  });

  it('세션이 없으면 401', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const { GET } = await import('./goals/route');
    expect((await GET(new Request('http://localhost/api/goals'))).status).toBe(401);
  });
});
