import { beforeEach, describe, expect, it, vi } from 'vitest';

// 결함 fix(2026-07-30) — `include` searchParam이 GET 핸들러에서 GoalService.list()로 한 번도
// 전달되지 않았다(story #2298/#2303의 `include=glance` 옵트인이 이 지점에서부터 이미 죽어
// 있었다 — #2224 초점 스트립 결함의 진짜 근본). ca37b2b0(stories route)와 같은 패턴으로
// GoalService.list()를 목킹해 실제로 전달되는 filters 객체를 직접 검증한다.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), createGoalRepository: vi.fn(), list: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createGoalRepository: h.createGoalRepository }));
vi.mock('@/services/goal', async (importActual) => ({
  ...(await importActual<typeof import('@/services/goal')>()),
  GoalService: class { list = h.list; },
}));

import { GET } from './route';

const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

describe('/api/goals GET — include(story #2298 glance 옵트인) forwarding', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createGoalRepository.mockResolvedValue({});
    h.list.mockResolvedValue([]);
  });

  it('forwards include=glance from the query string to GoalService.list()', async () => {
    await GET(new Request('http://localhost/api/goals?project_id=p&order_by=position&include=glance'));

    const calledWith = h.list.mock.calls[0]![0] as { include?: string };
    expect(calledWith.include).toBe('glance');
  });

  it('omits include when the query string has none(기존 무옵션 호출 byte-identical 유지)', async () => {
    await GET(new Request('http://localhost/api/goals?project_id=p'));

    const calledWith = h.list.mock.calls[0]![0] as { include?: string };
    expect(calledWith.include).toBeUndefined();
  });
});
