import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b8): 직접 서비스 핸들러(TaskService) — b7 정석 재사용. proxy 아님.
// GET=service.list(+story_id면 counts) / POST=parseBody→service.create(201). pagination 헬퍼는 실제 사용.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), createTaskRepository: vi.fn(),
  list: vi.fn(), create: vi.fn(), parseBody: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createTaskRepository: h.createTaskRepository }));
vi.mock('@/services/task', async (importActual) => ({
  ...(await importActual<typeof import('@/services/task')>()),
  TaskService: class { list = h.list; create = h.create; },
}));
vi.mock('@sprintable/shared', async (importActual) => ({
  // 공유 모듈은 export 다수(VALID_STORY_TRANSITIONS 등 타 소비자 참조) — importActual로 전부 유지·parseBody만 오버라이드.
  ...(await importActual<typeof import('@sprintable/shared')>()),
  parseBody: h.parseBody,
}));

import { GET, POST } from './route';

const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const task = (id: string, status = 'todo') => ({ id, status, created_at: `2026-06-1${id}T00:00:00Z` });

describe('/api/tasks (직접 서비스 TaskService)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createTaskRepository.mockResolvedValue({});
  });

  it('GET: 401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/tasks'))).status).toBe(401);
    expect(h.list).not.toHaveBeenCalled();
  });

  it('GET: lists via service.list and wraps page+meta (no story_id)', async () => {
    h.list.mockResolvedValue([task('1'), task('2')]);
    const res = await GET(new Request('http://localhost/api/tasks?project_id=p'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.meta).toBeTruthy();
  });

  it('GET: single story_id adds totalCount/doneCount (getStoryTaskCounts)', async () => {
    // main list + counts(all, done) = 3 호출
    h.list
      .mockResolvedValueOnce([task('1', 'todo'), task('2', 'done')])  // main page
      .mockResolvedValueOnce([task('1'), task('2')])                  // all
      .mockResolvedValueOnce([task('2', 'done')]);                    // done
    const res = await GET(new Request('http://localhost/api/tasks?story_id=s1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.totalCount).toBe(2);
    expect(body.meta.doneCount).toBe(1);
  });

  it('POST: 401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await POST(new Request('http://localhost/api/tasks', { method: 'POST', body: '{}' }))).status).toBe(401);
  });

  it('POST: invalid body → parseBody 400 response', async () => {
    h.parseBody.mockResolvedValue({ success: false, response: new Response('bad', { status: 400 }) });
    const res = await POST(new Request('http://localhost/api/tasks', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('POST: valid body → service.create wrapped as 201', async () => {
    h.parseBody.mockResolvedValue({ success: true, data: { title: 'T', story_id: 's1' } });
    h.create.mockResolvedValue({ id: 't1', title: 'T' });
    const res = await POST(new Request('http://localhost/api/tasks', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(201);
    expect(h.create).toHaveBeenCalledWith({ title: 'T', story_id: 's1' });
    expect((await res.json()).data).toMatchObject({ id: 't1' });
  });
});

// story #2262 PR②(BE #2905) — ids 배치 lookup(task 자신의 id로) 분기. ⛔story_ids(부모
// story로 묶어 자식 task들을 찾는 기존 기능)와 다른 축이라는 것도 값으로 고정한다.
describe('/api/tasks GET — ids 배치 lookup 분기(#2262 PR②, task 자신의 id)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createTaskRepository.mockResolvedValue({});
  });

  it('no ids param → existing path, ids not sent', async () => {
    h.list.mockResolvedValue([]);
    await GET(new Request('http://localhost/api/tasks?story_id=s1'));
    const calledWith = h.list.mock.calls[0]![0] as { ids?: string[] };
    expect(calledWith.ids).toBeUndefined();
  });

  it('ids param present → batch lookup by task id, distinct from story_ids', async () => {
    h.list.mockResolvedValue([task('t1'), task('t2')]);
    const res = await GET(new Request('http://localhost/api/tasks?ids=t1,t2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(h.list).toHaveBeenCalledWith({ ids: ['t1', 't2'], limit: 2 });
  });

  it('caps ids at 200 before calling the service', async () => {
    h.list.mockResolvedValue([]);
    const manyIds = Array.from({ length: 250 }, (_, i) => `id${i}`).join(',');
    await GET(new Request(`http://localhost/api/tasks?ids=${manyIds}`));
    const calledWith = h.list.mock.calls[0]![0] as { ids: string[] };
    expect(calledWith.ids).toHaveLength(200);
  });
});
