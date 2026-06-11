import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b9): 직접 서비스 핸들러(StoryService) — 확립 패턴(importActual 스프레드 + class mock).
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), createStoryRepository: vi.fn(),
  getByIdWithDetails: vi.fn(), getById: vi.fn(), update: vi.fn(), del: vi.fn(), logActivity: vi.fn(),
  parseBody: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createStoryRepository: h.createStoryRepository }));
vi.mock('@/services/story', async (importActual) => ({
  ...(await importActual<typeof import('@/services/story')>()),
  StoryService: class {
    getByIdWithDetails = h.getByIdWithDetails; getById = h.getById; update = h.update;
    delete = h.del; logActivity = h.logActivity;
  },
}));
vi.mock('@sprintable/shared', async (importActual) => ({
  ...(await importActual<typeof import('@sprintable/shared')>()),
  parseBody: h.parseBody,
}));

import { GET, PATCH, DELETE } from './route';

const ID = 'story-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const human = () => ({ id: 'a', type: 'human', org_id: 'org-1', project_id: 'p1', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const req = (m = 'GET') => new Request(`http://localhost/x/${ID}`, { method: m });

describe('/api/stories/[id] (직접 서비스 StoryService)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(human());
    h.createStoryRepository.mockResolvedValue({});
    h.logActivity.mockResolvedValue(undefined);  // .catch 체인 — promise 반환 필수
  });

  it('GET: 401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(401);
  });
  it('GET: returns story via getByIdWithDetails(id)', async () => {
    h.getByIdWithDetails.mockResolvedValue({ id: ID, project_id: 'p1', title: 'T' });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(h.getByIdWithDetails).toHaveBeenCalledWith(ID);
    expect((await res.json()).data).toMatchObject({ id: ID });
  });
  it('GET: agent cross-project → 403', async () => {
    h.getAuthContext.mockResolvedValue({ ...human(), type: 'agent', project_id: 'other' });
    h.getByIdWithDetails.mockResolvedValue({ id: ID, project_id: 'p1' });
    expect((await GET(req(), ctx())).status).toBe(403);
  });

  it('PATCH: invalid body → parseBody 400', async () => {
    h.parseBody.mockResolvedValue({ success: false, response: new Response('bad', { status: 400 }) });
    expect((await PATCH(req('PATCH'), ctx())).status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });
  it('PATCH: updates story + logs status change', async () => {
    h.parseBody.mockResolvedValue({ success: true, data: { status: 'done' } });
    h.getById.mockResolvedValue({ id: ID, status: 'todo', title: 'T', assignee_id: null });
    h.update.mockResolvedValue({ id: ID, status: 'done' });
    const res = await PATCH(req('PATCH'), ctx());
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(ID, { status: 'done' });
    expect(h.logActivity).toHaveBeenCalledWith(expect.objectContaining({ action_type: 'status_changed', new_value: 'done' }));
  });

  it('DELETE: deletes via service.delete(id) → {ok:true}', async () => {
    h.del.mockResolvedValue(undefined);
    const res = await DELETE(req('DELETE'), ctx());
    expect(res.status).toBe(200);
    expect(h.del).toHaveBeenCalledWith(ID);
    expect((await res.json()).data).toMatchObject({ ok: true });
  });
});
