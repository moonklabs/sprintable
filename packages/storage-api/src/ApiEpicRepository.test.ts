// 결함 fix(2026-07-30) — 083176e8(ApiStoryRepository의 `q` 소실)와 같은 클래스인지라: `include`가
// 이 파일의 list() query 객체 조립 지점에서만 빠져 있었다. BE(goals.py)는 `include=glance`를
// 정상 처리하는데(participant_ids/focal_story 추가), FE 4단 체인(route.ts→GoalService→
// ApiEpicRepository) 전체가 그 파라미터를 한 번도 실어 나른 적이 없었다 — story #2298/#2303의
// 옵트인이 배선 이후 지금까지 사실상 죽어 있었다(#2224 초점 스트립 결함의 진짜 근본).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiEpicRepository } from './ApiEpicRepository';

describe('ApiEpicRepository.list — include(story #2298 glance 옵트인) 파라미터가 실제 요청 URL에 실린다', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);
  });

  it('includes include=glance in the outgoing query string when filters.include is set', async () => {
    const repo = new ApiEpicRepository('token');
    await repo.list({ project_id: 'proj-1', include: 'glance' });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).toContain('include=glance');
  });

  it('omits include from the query string when filters.include is undefined(기존 무옵션 호출 byte-identical 유지)', async () => {
    const repo = new ApiEpicRepository('token');
    await repo.list({ project_id: 'proj-1' });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).not.toContain('include=');
  });
});
