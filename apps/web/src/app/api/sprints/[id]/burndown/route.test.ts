import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b7): 직접 서비스 핸들러 — auth 게이트 → SprintService(repo).getBurndown(id) → 래핑.
// proxy 아님. 구 stale 테스트 폐기, 현 서비스 계약(메서드 호출·NotFoundError→404)으로 재작성.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  createSprintRepository: vi.fn(),
  getBurndown: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createSprintRepository: h.createSprintRepository }));
vi.mock('@/services/sprint', async (importActual) => ({
  // 에러클래스(NotFoundError·ForbiddenError 등)는 실제 유지(handleApiError가 instanceof로 참조)·SprintService만 오버라이드.
  ...(await importActual<typeof import('@/services/sprint')>()),
  SprintService: class { getBurndown = h.getBurndown; },
}));

import { GET } from './route';
import { NotFoundError } from '@/services/sprint';

const ID = 'sprint-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const req = () => new Request(`http://localhost/api/sprints/${ID}/burndown`);

describe('GET /api/sprints/[id]/burndown (직접 서비스)', () => {
  beforeEach(() => {
    h.getAuthContext.mockReset(); h.createSprintRepository.mockReset(); h.getBurndown.mockReset();
    h.getAuthContext.mockResolvedValue(agent());
    h.createSprintRepository.mockResolvedValue({});
  });
  it('401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(401);
    expect(h.getBurndown).not.toHaveBeenCalled();
  });
  it('returns burndown data via SprintService(id) wrapped', async () => {
    h.getBurndown.mockResolvedValue({ days: [1, 2, 3] });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(h.getBurndown).toHaveBeenCalledWith(ID);
    expect((await res.json()).data).toMatchObject({ days: [1, 2, 3] });
  });
  it('NotFoundError → 404', async () => {
    h.getBurndown.mockRejectedValue(new NotFoundError('sprint not found'));
    expect((await GET(req(), ctx())).status).toBe(404);
  });
});
