import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b7): 직접 서비스 핸들러 — auth 게이트 → SprintService(repo).kickoff(id, message) → 래핑.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  createSprintRepository: vi.fn(),
  kickoff: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createSprintRepository: h.createSprintRepository }));
vi.mock('@/services/sprint', async (importActual) => ({
  // 에러클래스(NotFoundError·ForbiddenError 등)는 실제 유지(handleApiError가 instanceof로 참조)·SprintService만 오버라이드.
  ...(await importActual<typeof import('@/services/sprint')>()),
  SprintService: class { kickoff = h.kickoff; },
}));

import { POST } from './route';
import { NotFoundError } from '@/services/sprint';

const ID = 'sprint-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const req = (body: object = { message: 'go' }) =>
  new Request(`http://localhost/api/sprints/${ID}/kickoff`, { method: 'POST', body: JSON.stringify(body) });

describe('POST /api/sprints/[id]/kickoff (직접 서비스)', () => {
  beforeEach(() => {
    h.getAuthContext.mockReset(); h.createSprintRepository.mockReset(); h.kickoff.mockReset();
    h.getAuthContext.mockResolvedValue(agent());
    h.createSprintRepository.mockResolvedValue({});
  });
  it('401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await POST(req(), ctx())).status).toBe(401);
    expect(h.kickoff).not.toHaveBeenCalled();
  });
  it('kicks off via SprintService(id, message) wrapped', async () => {
    h.kickoff.mockResolvedValue({ started: true });
    const res = await POST(req({ message: 'go team' }), ctx());
    expect(res.status).toBe(200);
    expect(h.kickoff).toHaveBeenCalledWith(ID, 'go team');
    expect((await res.json()).data).toMatchObject({ started: true });
  });
  it('NotFoundError → 404', async () => {
    h.kickoff.mockRejectedValue(new NotFoundError('sprint not found'));
    expect((await POST(req(), ctx())).status).toBe(404);
  });
});
