// story #3713(라이브 결함·high, 유나 배포 56 라이브 1차 02:40Z) — ApiTaskRepository.list()가
// query 객체에 cursor·limit을 안 실어 BE 커서가 전진하지 않았다(같은 5행·같은 nextCursor
// 반복 — 표본 3711에서 「더 보기」 3회 클릭해도 로드분 20 그대로). 형제 ApiStoryRepository는
// 이미 cursor/limit을 실어 보내는데, 이 파일만 조립 지점에서 빠져 있었다(q 소실 083176e8과
// 같은 클래스). 이 스위트는 그 정확한 회귀 지점을 직접 재현 가능한 형태로 봉쇄한다.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TaskListFilters } from '@sprintable/core-storage';
import { ApiTaskRepository, TASK_LIST_FILTER_KEYS } from './ApiTaskRepository';

function stubFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ApiTaskRepository.list — cursor·limit이 실제 요청 URL에 실린다(story #3713 라이브 결함)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = stubFetch(); });

  it('cursor가 있으면 요청 URL에 cursor가 실린다(양성대조: 이 필드를 지우면 RED)', async () => {
    const repo = new ApiTaskRepository('token');
    await repo.list({ story_id: 's1', cursor: 'CURSOR_X' });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).toContain('cursor=CURSOR_X');
  });

  it('limit이 있으면 요청 URL에 limit이 실린다', async () => {
    const repo = new ApiTaskRepository('token');
    await repo.list({ story_id: 's1', limit: 5 });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).toContain('limit=5');
  });

  it('cursor 두 번째 페이지 요청이 첫 페이지와 다른 cursor 값을 싣는다(겹침 재현 방지 — API 계약 측)', async () => {
    const repo = new ApiTaskRepository('token');
    await repo.list({ story_id: 's1', limit: 5 });
    await repo.list({ story_id: 's1', limit: 5, cursor: 'PAGE1_LAST_CREATED_AT' });

    const firstUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    const secondUrl = (fetchMock.mock.calls[1]![0] as URL | string).toString();
    expect(firstUrl).not.toContain('cursor=');
    expect(secondUrl).toContain('cursor=PAGE1_LAST_CREATED_AT');
  });
});

// story #3713 AC3(재발 차단) — memory("extracted가 아니라 expected를 기준으로 검사해야
// 조용한 누락을 잡는다")를 그대로 적용한다. TASK_LIST_FILTER_KEYS(ApiTaskRepository.ts,
// Record<keyof TaskListFilters, true> — 인터페이스에 필드가 추가/삭제되면 tsc가 즉시
// 깨지는 SSOT)를 순회하며 «하나도 빠짐없이» 요청 URL에 실리는지 잰다. 새 필터 필드가
// 인터페이스에 추가되고 이 상수엔 반영됐는데 list()의 query 조립만 빠뜨리면(오늘의 정확한
// 재발 시나리오) 이 테스트가 그 키에서 fail-closed로 걸린다 — 사람이 케이스를 일일이
// 나열하는 게 아니라 SSOT를 순회하므로 새 필드도 자동으로 커버된다.
describe('ApiTaskRepository.list — TaskListFilters 키 완전성(story #3713, fail-closed)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = stubFetch(); });

  const TEST_VALUE_AND_EXPECTED_PARAM: Record<keyof TaskListFilters, { value: unknown; expectedParam: string }> = {
    story_id: { value: 's1', expectedParam: 'story_id=s1' },
    project_id: { value: 'p1', expectedParam: 'project_id=p1' },
    assignee_id: { value: 'a1', expectedParam: 'assignee_id=a1' },
    status: { value: 'in-progress', expectedParam: 'status=in-progress' },
    status_ne: { value: 'done', expectedParam: 'status_ne=done' },
    ids: { value: ['t1', 't2'], expectedParam: `ids=${encodeURIComponent('t1,t2')}` },
    limit: { value: 5, expectedParam: 'limit=5' },
    cursor: { value: 'CURSOR_X', expectedParam: 'cursor=CURSOR_X' },
  };

  it.each(Object.keys(TASK_LIST_FILTER_KEYS) as Array<keyof TaskListFilters>)(
    '필터 키 %s가 실제 요청 URL에 실린다',
    async (key) => {
      const repo = new ApiTaskRepository('token');
      const { value, expectedParam } = TEST_VALUE_AND_EXPECTED_PARAM[key];
      await repo.list({ [key]: value } as TaskListFilters);

      const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
      expect(requestedUrl).toContain(expectedParam);
    },
  );

  it('TEST_VALUE_AND_EXPECTED_PARAM 자체가 TASK_LIST_FILTER_KEYS와 키 집합이 정확히 같다(테스트 자신의 완전성 — 새 필드를 위 표에 안 채우면 여기서 걸린다)', () => {
    expect(Object.keys(TEST_VALUE_AND_EXPECTED_PARAM).sort()).toEqual(Object.keys(TASK_LIST_FILTER_KEYS).sort());
  });
});
