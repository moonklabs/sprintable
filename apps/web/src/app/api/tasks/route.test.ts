import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b8): 직접 서비스 핸들러(TaskService) — b7 정석 재사용. proxy 아님.
// GET=service.list(+story_id면 counts) / POST=parseBody→service.create(201). pagination 헬퍼는 실제 사용.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), createTaskRepository: vi.fn(),
  list: vi.fn(), create: vi.fn(), parseBody: vi.fn(),
  // story #3718 — getStoryTaskCounts가 service.list(길이 세기) 대신 service.count
  // (BE X-Total-Count)를 쓰도록 바뀌어 mock 표면도 같이 늘어난다.
  count: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createTaskRepository: h.createTaskRepository }));
vi.mock('@/services/task', async (importActual) => ({
  ...(await importActual<typeof import('@/services/task')>()),
  TaskService: class { list = h.list; create = h.create; count = h.count; },
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

  it('GET: single story_id adds totalCount/doneCount from service.count(story #3718 — X-Total-Count, list().length 아님)', async () => {
    h.list.mockResolvedValueOnce([task('1', 'todo'), task('2', 'done')]); // main page
    h.count
      .mockResolvedValueOnce(2)  // total
      .mockResolvedValueOnce(1); // done
    const res = await GET(new Request('http://localhost/api/tasks?story_id=s1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.totalCount).toBe(2);
    expect(body.meta.doneCount).toBe(1);
    expect(h.count).toHaveBeenCalledWith({ story_id: 's1' });
    expect(h.count).toHaveBeenCalledWith({ story_id: 's1', status: 'done' });
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

// story #3717(PO 배포 57 API 축 실측 03:50Z, #3713 후속) — #3713이 리포지토리 경계
// 전달(cursor/limit)을 고치자 그 뒤에 숨어 있던 두 번째 결함이 드러났다: 이 라우트가
// buildCursorPageMeta의 「limit+1 과대조회」 계약(items.length > limit으로 hasMore
// 판정, lib/pagination.ts)을 안 지켜 리포지토리에 정확히 요청 limit만 전달했다 —
// BE가 정확히 그만큼만 주니 어떤 limit에서도 hasMore가 영영 false였다(형제
// stories/route.ts:114는 +1이 이미 있음). #4061의 픽스 테스트는 「경계 전달」(리포지토리가
// 받은 query)만 쟀고 「응답 hasMore가 실제로 선다」(결과)는 안 쟀다 — 이번엔 결과를 잰다.
describe('/api/tasks GET — cursor pagination hasMore/nextCursor 과대조회(story #3717)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createTaskRepository.mockResolvedValue({});
  });

  it('요청 limit=5인데 리포지토리엔 limit+1(6)이 전달된다(이 PR의 본질 — 지우면 RED)', async () => {
    h.list.mockResolvedValue([]);
    await GET(new Request('http://localhost/api/tasks?story_id=s1&limit=5'));
    const calledWith = h.list.mock.calls[0]![0] as { limit?: number };
    expect(calledWith.limit).toBe(6);
  });

  // 카디르 재-QA(2026-09-09 04:17, codex mutation-kill 실측) — h.list가 호출 인자와
  // 무관하게 고정 배열을 반환하면 이 테스트는 buildCursorPageMeta의 산술(6>5)만
  // 재검증하는 동어반복이라, +1을 지워 리포지토리에 limit=5가 가도(mock이 여전히
  // 6행을 주므로) GREEN인 채 남는다(경계 테스트만 RED로 잡혔다). limit-aware mock으로
  // «리포지토리가 실제로 받은 limit」에 따라 반환량이 갈리게 해 결과 단언 자체가
  // +1 전달에 의존하게 만든다.
  function limitAwarePool(pool: ReturnType<typeof task>[]) {
    return (args: { limit?: number; status?: string }) => {
      let rows = pool;
      if (args.status) rows = rows.filter((t) => t.status === args.status);
      if (typeof args.limit === 'number') rows = rows.slice(0, args.limit);
      return Promise.resolve(rows);
    };
  }

  it('리포지토리가 요청보다 1건 더(6행) 주면 hasMore=true·nextCursor=5번째 행의 created_at(양성대조, limit-aware — +1 제거 시 RED 실측)', async () => {
    const pool = [task('1'), task('2'), task('3'), task('4'), task('5'), task('6')];
    h.list.mockImplementation(limitAwarePool(pool));
    const res = await GET(new Request('http://localhost/api/tasks?story_id=s1&limit=5'));
    const body = await res.json();
    expect(body.data).toHaveLength(5);
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.nextCursor).toBe(task('5').created_at);
  });

  it('리포지토리가 정확히 요청분(5행)만 주면 hasMore=false(마지막 페이지, 무회귀)', async () => {
    const pool = [task('1'), task('2'), task('3'), task('4'), task('5')];
    h.list.mockImplementation(limitAwarePool(pool));
    const res = await GET(new Request('http://localhost/api/tasks?story_id=s1&limit=5'));
    const body = await res.json();
    expect(body.data).toHaveLength(5);
    expect(body.meta.hasMore).toBe(false);
    expect(body.meta.nextCursor).toBeNull();
  });
});

// story #3718(FE 완전성-정직, 3713/3717 후속) — getStoryTaskCounts가 service.list(...).length
// 로 총계를 셌다. BE 기본 페이지 상한(미지정 시 1000)에 잘린 근사치라 태스크 1000건 초과
// 스토리에선 「N개 중 M개」의 N 자체가 거짓이었다. service.count(BE X-Total-Count)로 교체.
describe('/api/tasks GET — getStoryTaskCounts가 목록 길이가 아닌 service.count를 쓴다(story #3718)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createTaskRepository.mockResolvedValue({});
  });

  it('(a) count가 1500(목록 길이 상한 1000을 초과하는 값)을 반환하면 totalCount=1500 그대로 나간다(list().length였다면 1000 이하로 잘렸을 값 — 되돌리면 RED)', async () => {
    h.list.mockResolvedValueOnce(Array.from({ length: 20 }, (_, i) => task(String(i))));
    h.count.mockResolvedValueOnce(1500).mockResolvedValueOnce(300);
    const res = await GET(new Request('http://localhost/api/tasks?story_id=s1&limit=20'));
    const body = await res.json();
    expect(body.meta.totalCount).toBe(1500);
    expect(body.meta.doneCount).toBe(300);
  });

  it('(c) count가 둘 다 null(BE 헤더 부재)이면 totalCount/doneCount는 현재 페이지 길이로 폴백한다(무회귀 — 화면이 깨지지 않게)', async () => {
    h.list.mockResolvedValueOnce([task('1', 'todo'), task('2', 'done')]);
    h.count.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const res = await GET(new Request('http://localhost/api/tasks?story_id=s1'));
    const body = await res.json();
    expect(body.meta.totalCount).toBe(2);
    expect(body.meta.doneCount).toBe(1);
  });

  it('(d) getStoryTaskCounts는 story_id 분기에서 service.list를 카운트 목적으로 부르지 않는다(main page 호출 1회만 — 목록 길이로 세는 경로 0)', async () => {
    h.list.mockResolvedValueOnce([task('1')]);
    h.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await GET(new Request('http://localhost/api/tasks?story_id=s1'));
    expect(h.list).toHaveBeenCalledTimes(1); // main page만 — counts용 list 호출 0
    expect(h.count).toHaveBeenCalledTimes(2); // total·done
  });

  it('25건 이하(기존 표본 규모) 무회귀 — count 값 그대로 반영', async () => {
    h.list.mockResolvedValueOnce(Array.from({ length: 20 }, (_, i) => task(String(i), i % 5 === 0 ? 'done' : 'todo')));
    h.count.mockResolvedValueOnce(25).mockResolvedValueOnce(5);
    const res = await GET(new Request('http://localhost/api/tasks?story_id=s1&limit=20'));
    const body = await res.json();
    expect(body.meta.totalCount).toBe(25);
    expect(body.meta.doneCount).toBe(5);
  });
});
